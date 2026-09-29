import { createHash } from 'crypto';
import { GraphApiError, graphDelete, graphPatch, graphPost } from './graphApiClient.js';
import type { GraphApiOptions } from './graphApiClient.js';
import { withTransaction } from '../../db.js';
import { listDueOperations } from '../../providerOperations.js';
import type { ProviderAdapterOutcome, ProviderMutationAdapter } from '../../providerMutationService.js';
import type { GraphMailFolder } from './graphMail.js';
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
 * A flag PATCH sets a state, but replaying a recovered claim could overwrite a
 * later user or remote edit. Recovery therefore requires provider read-back;
 * only failures known to precede application may be retried as writes.
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
 *
 * It is the classifier for **every** Graph adapter, not only mail: the mapping is a property of the
 * transport's error type, so contacts and calendar writes share it rather than each re-deriving it.
 */
export function classifyGraphMutationFailure<T = void>(error: unknown): ProviderAdapterOutcome<T> {
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
    // A stale state set can overwrite a newer edit; recovery must read back.
    idempotent: false,
    async perform(write, context) {
      const body = graphMessagePatchForFlag(write.flag, write.value);
      if (!body) return { status: 'permanent', code: 'OPERATION_FORBIDDEN' };
      try {
        const signal = options.api.signal ? AbortSignal.any([options.api.signal, context.signal]) : context.signal;
        await patch({ ...options.api, signal }, graphMessageResource(write.providerMessageId), body);
        return { status: 'committed' };
      } catch (error) {
        return classifyGraphMutationFailure(error);
      }
    },
  };
}

/**
 * Compatibility entry point for legacy callers. Legacy journal rows have no
 * durable latest-intent fence, so none may be dispatched here. The mail flag
 * state worker imports them as read-back obligations and records reconciliation
 * separately from historical write success.
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

  return { due: due.length, confirmed: 0, unresolved: due.length };
}

// ── Moving and removing a message ───────────────────────────────────────────

/**
 * A move, as the application models it: the message is addressed by its provider
 * id and the destination is the provider's folder id.
 */
export interface GraphMailMovePayload {
  providerMessageId: string;
  destinationFolderId: string;
  intentAt: string;
}

/** A permanent delete. Providers identify the message the same way a move does. */
export interface GraphMailDeletePayload {
  providerMessageId: string;
  intentAt: string;
}

/** What a Graph move hands back: the message under its **new** id. */
export interface GraphMoveResult {
  id: string;
  parentFolderId?: string | null;
}

/** Move a message to another Graph folder. Graph answers with the message, re-identified. */
export async function graphMoveMessage(
  api: GraphApiOptions,
  providerMessageId: string,
  destinationFolderId: string,
): Promise<GraphMoveResult | null> {
  return graphPost<GraphMoveResult>(
    api,
    `/me/messages/${encodeURIComponent(providerMessageId)}/move`,
    { destinationId: destinationFolderId },
  );
}

/** Remove a message permanently (not to the deleted-items folder — that is a move). */
export async function graphDeleteMessage(api: GraphApiOptions, providerMessageId: string): Promise<void> {
  await graphDelete(api, `/me/messages/${encodeURIComponent(providerMessageId)}`);
}

/**
 * Move and delete are **not** declared idempotent, and the reason is worth stating.
 *
 * A move converges on the same end state, and a delete is a no-op the second time —
 * but Graph re-identifies a moved message, so the provider id the operation was
 * dispatched with stops existing. A second attempt therefore answers `404`, which
 * is indistinguishable from "the message is gone for another reason". Declaring
 * them non-idempotent makes the layer **park a recovered claim as
 * `outcome_unknown`** instead of re-running it, which is the honest reading of a
 * 404 after a crash. A `retryable` classification still schedules a retry, because
 * the adapter is then explicitly saying nothing was applied.
 */
export function graphMoveMutationAdapter(options: {
  api: GraphApiOptions;
  move?: typeof graphMoveMessage;
}): ProviderMutationAdapter<GraphMailMovePayload, GraphMoveResult> {
  const move = options.move ?? graphMoveMessage;
  return {
    resourceType: 'message',
    idempotent: false,
    async perform(write) {
      try {
        const moved = await move(options.api, write.providerMessageId, write.destinationFolderId);
        // A provider that answers without the new identity leaves nothing to adopt,
        // and pretending otherwise would strand the local row on a dead id.
        if (!moved?.id) return { status: 'outcome_unknown', code: 'MUTATION_OUTCOME_UNKNOWN' };
        return { status: 'committed', value: moved };
      } catch (error) {
        return classifyGraphMutationFailure(error);
      }
    },
  };
}

export function graphDeleteMutationAdapter(options: {
  api: GraphApiOptions;
  remove?: typeof graphDeleteMessage;
}): ProviderMutationAdapter<GraphMailDeletePayload, void> {
  const remove = options.remove ?? graphDeleteMessage;
  return {
    resourceType: 'message',
    idempotent: false,
    async perform(write) {
      try {
        await remove(options.api, write.providerMessageId);
        return { status: 'committed' };
      } catch (error) {
        return classifyGraphMutationFailure(error);
      }
    },
  };
}

/** The journal key and payload hash of one move or delete intent. */
export function graphMoveIntent(payload: GraphMailMovePayload): { idempotencyKey: string; payloadHash: string } {
  return {
    idempotencyKey: `graph-mail-move:${payload.providerMessageId}:${payload.destinationFolderId}:${payload.intentAt}`,
    payloadHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
  };
}

export function graphDeleteIntent(payload: GraphMailDeletePayload): { idempotencyKey: string; payloadHash: string } {
  return {
    idempotencyKey: `graph-mail-delete:${payload.providerMessageId}:${payload.intentAt}`,
    payloadHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
  };
}

/**
 * Create a top-level mail folder.
 *
 * Snooze needs a `Snoozed` folder, and a Graph account only has the folders it has
 * discovered — so the provider has to be asked to create it and the discovery run
 * again, or there is no local path and no `mail_folder` collection for a move to
 * address.
 */
export async function graphCreateMailFolder(api: GraphApiOptions, displayName: string): Promise<GraphMailFolder | null> {
  return graphPost<GraphMailFolder>(api, '/me/mailFolders', { displayName });
}

/**
 * Rename a mail folder.
 *
 * Graph identifies the folder immutably and the display name is what changes, so a
 * rename is a PATCH and the discovery run that follows is what moves the local path
 * — the folder sync already recognises a path change and relocates the folder's
 * messages with it, which is why nothing here touches `messages`.
 */
export async function graphRenameMailFolder(api: GraphApiOptions, folderId: string, displayName: string): Promise<GraphMailFolder | null> {
  return graphPatch<GraphMailFolder>(api, `/me/mailFolders/${encodeURIComponent(folderId)}`, { displayName });
}

/** Delete a mail folder. The provider deletes its contents with it. */
export async function graphDeleteMailFolder(api: GraphApiOptions, folderId: string): Promise<void> {
  await graphDelete(api, `/me/mailFolders/${encodeURIComponent(folderId)}`);
}
