import { createHash } from 'crypto';
import { GraphApiError, graphPatch } from './graphApiClient.js';
import type { GraphApiOptions } from './graphApiClient.js';
import { withTransaction } from '../../db.js';
import { listDueOperations } from '../../providerOperations.js';
import { runProviderMutation } from '../../providerMutationService.js';
import type { ProviderAdapterOutcome, ProviderMutationAdapter } from '../../providerMutationService.js';
import type { FetchLike } from '../../providerAuthService.js';

/**
 * Microsoft Graph mail mutations (P07b, third slice).
 *
 * The write side of the Graph adapter, expressed as adapters on the shared
 * provider-mutation layer rather than as a Graph-only pipeline. That is the point
 * of the layer: `pending`, `confirmed`, `retryable`, `outcome_unknown` and the
 * claim fencing are the same here as they are for the IMAP flag write, and the
 * routes above do not need to know which transport they are talking to.
 *
 * Graph's message mutations are **idempotent**: `PATCH { isRead: true }` and
 * `PATCH { flag: { flagStatus } }` set a state rather than applying a delta, so a
 * recovered claim may safely run them again — the same reasoning as the IMAP flag
 * adapter, and the opposite of a send.
 */

/** A flag write as the application models it, with IMAP-style flag names. */
export interface GraphMailFlagWrite {
  providerMessageId: string;
  flag: string;
  value: boolean;
}

/**
 * The stored payload of one flag mutation.
 *
 * `intentAt` is part of the *intent identity*, not decoration: it makes the
 * idempotency key unique per user action while remaining derivable from the stored
 * payload, so a retry reclaims its own journal row instead of inserting a second
 * one — and a later click of the same control is a new operation rather than a
 * replay of an old result. Without it, marking a message read a second time after
 * a sync reverted it would be answered from the journal and never reach the server.
 */
export interface GraphMailFlagPayload extends GraphMailFlagWrite {
  intentAt: string;
}

/** The journal key and payload hash of one flag intent. */
export function graphFlagIntent(input: { messageId: string; write: GraphMailFlagPayload }): { idempotencyKey: string; payloadHash: string } {
  const payloadHash = createHash('sha256').update(JSON.stringify(input.write)).digest('hex');
  return {
    idempotencyKey: `graph-mail-flag:${input.messageId}:${input.write.flag}:${input.write.value}:${input.write.intentAt}`,
    payloadHash,
  };
}

export interface GraphMessagePatch {
  isRead?: boolean;
  flag?: { flagStatus: 'flagged' | 'notFlagged' };
}

/**
 * The Graph patch a local flag corresponds to, or `null` for a flag Graph has no
 * equivalent for. Returning null rather than guessing keeps an unimplemented flag
 * a visible refusal instead of a silent no-op.
 */
export function graphMessagePatchForFlag(flag: string, value: boolean): GraphMessagePatch | null {
  if (flag === '\\Seen') return { isRead: value };
  if (flag === '\\Flagged') return { flag: { flagStatus: value ? 'flagged' : 'notFlagged' } };
  return null;
}

/**
 * Classify a Graph mutation failure for the journal.
 *
 * A network failure is deliberately `outcome_unknown`, not `retryable`: a timeout
 * cannot tell us whether the request reached the server, and re-running a mutation
 * that may have been applied is the failure mode the layer exists to prevent.
 */
export function classifyGraphMailMutationFailure(error: unknown): ProviderAdapterOutcome<void> {
  if (error instanceof GraphApiError) {
    if (error.retryable) {
      return {
        status: 'retryable',
        code: error.code,
        ...(error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
      };
    }
    return { status: 'permanent', code: error.code };
  }
  return { status: 'outcome_unknown', code: 'MUTATION_OUTCOME_UNKNOWN' };
}

/** The Graph resource a message mutation addresses. */
export function graphMessageResource(providerMessageId: string): string {
  return `/me/messages/${encodeURIComponent(providerMessageId)}`;
}

export function graphFlagMutationAdapter(options: {
  api: GraphApiOptions;
  /** Injected in tests; the application uses `graphPatch`. */
  patch?: typeof graphPatch;
}): ProviderMutationAdapter<GraphMailFlagPayload, void> {
  const patch = options.patch ?? graphPatch;
  return {
    resourceType: 'message',
    // A state set, not a delta: re-applying it converges.
    idempotent: true,
    async perform(write) {
      const body = graphMessagePatchForFlag(write.flag, write.value);
      if (!body) return { status: 'permanent', code: 'OPERATION_FORBIDDEN' };
      try {
        await patch(options.api, graphMessageResource(write.providerMessageId), body);
        return { status: 'committed' };
      } catch (error) {
        return classifyGraphMailMutationFailure(error);
      }
    },
  };
}

/**
 * Retry the flag mutations the journal left `pending` for one account.
 *
 * This is the drainer the `pending` pool was missing: a `retryable` outcome (a
 * throttle, a provider outage) schedules the operation instead of dropping the
 * user's change, and this pass re-runs each due row **under its own claim**, so
 * two workers cannot both execute it and a row that has since been completed is
 * answered from the journal rather than re-applied.
 *
 * It runs at the start of the account's message sync, which is the moment the
 * mailbox is being reconciled anyway: a pending flag is settled before the delta
 * is applied, so the sync cannot overwrite a change that is still in flight.
 */
export async function drainGraphMailFlagOperations(input: {
  userId: string;
  connectionId: string;
  accountId: string;
  config?: GraphApiOptions['config'];
  fetchImpl?: FetchLike;
  limit?: number;
}): Promise<{ due: number; confirmed: number; unresolved: number }> {
  const due = await withTransaction(client => listDueOperations(client, {
    userId: input.userId,
    accountId: input.accountId,
    resourceType: 'message',
    limit: input.limit ?? 25,
  }));

  const api: GraphApiOptions = {
    userId: input.userId,
    connectionId: input.connectionId,
    owner: `graph-mail-drain:${input.accountId}`,
    ...(input.config ? { config: input.config } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  };

  let confirmed = 0;
  let unresolved = 0;
  for (const row of due) {
    const payload = row.payload as GraphMailFlagPayload | null;
    // A row without its adapter parameters cannot be re-run; leaving it pending
    // for a human is honest, silently dropping it is not.
    if (!payload?.providerMessageId || !payload.flag || !row.idempotencyKey || !row.payloadHash) {
      unresolved += 1;
      continue;
    }
    const result = await runProviderMutation<GraphMailFlagPayload, void>(
      {
        userId: input.userId,
        channel: 'worker',
        operation: 'update',
        accountId: input.accountId,
        resourceId: row.resourceId,
        idempotencyKey: row.idempotencyKey,
        payloadHash: row.payloadHash,
        payload,
        owner: api.owner,
        retry: { delaySeconds: 300 },
      },
      graphFlagMutationAdapter({ api }),
    );
    if (result.status === 'confirmed' || result.status === 'accepted') confirmed += 1;
    else unresolved += 1;
  }
  return { due: due.length, confirmed, unresolved };
}
