import { createHash } from 'crypto';
import { GoogleApiError } from './googleApiClient.js';
import type { GoogleApiOptions } from './googleApiClient.js';
import { GMAIL_USER, gmailDelete, gmailPatch, gmailPost } from './gmailApi.js';
import { runProviderMutation } from '../../providerMutationService.js';
import type { ProviderAdapterOutcome, ProviderMutationAdapter } from '../../providerMutationService.js';

/**
 * Gmail mutations (P08, first slice: labels).
 *
 * The write side of the Gmail adapter, expressed as adapters on the shared
 * provider-mutation layer rather than as a Gmail-only pipeline — the same choice
 * the Graph adapter makes, and for the same reason: `pending`, `confirmed`,
 * `retryable`, `outcome_unknown` and the claim fencing must not depend on which
 * provider a mailbox happens to use.
 *
 * Gmail's own semantics decide each adapter's `idempotent` flag, and the
 * difference is deliberate:
 *
 *  - a **rename** is a PATCH that sets the label's name, so re-applying it
 *    converges and a recovered claim may run it again;
 *  - a **create** is not — Gmail answers a duplicate name with a `409`, so a
 *    recovered claim could not tell "already created by my previous attempt" from
 *    "a label of that name already existed", and it is parked as
 *    `outcome_unknown` instead of re-run;
 *  - a **delete** is not either: the second attempt answers `404`, which is
 *    indistinguishable from "the label is gone for another reason".
 *
 * The classification of a failure is part of the contract: a network failure is
 * deliberately `outcome_unknown`, never `retryable`, because a timeout cannot tell
 * us whether the request reached Gmail.
 */

/** Classify a Gmail mutation failure for the journal. Exported so tests assert it directly. */
export function classifyGmailMailMutationFailure<T = void>(error: unknown): ProviderAdapterOutcome<T> {
  if (error instanceof GoogleApiError) {
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

// ── Labels ───────────────────────────────────────────────────────────────────

/** A label as Gmail returns it from a create/rename. */
export interface GmailLabelResult {
  id: string;
  name?: string | null;
}

/** Create a top-level user label. Gmail refuses a duplicate name with a `409`. */
export async function gmailCreateLabel(api: GoogleApiOptions, name: string): Promise<GmailLabelResult | null> {
  return gmailPost<GmailLabelResult>(api, `users/${GMAIL_USER}/labels`, {
    name,
    labelListVisibility: 'labelShow',
    messageListVisibility: 'show',
  });
}

/** Rename a label. The label id is immutable; only the display name changes. */
export async function gmailRenameLabel(api: GoogleApiOptions, labelId: string, name: string): Promise<GmailLabelResult | null> {
  return gmailPatch<GmailLabelResult>(api, `users/${GMAIL_USER}/labels/${encodeURIComponent(labelId)}`, { name });
}

/** Delete a label. Gmail removes it from every message that carried it. */
export async function gmailDeleteLabel(api: GoogleApiOptions, labelId: string): Promise<void> {
  await gmailDelete(api, `users/${GMAIL_USER}/labels/${encodeURIComponent(labelId)}`);
}

export interface GmailLabelCreatePayload {
  name: string;
  intentAt: string;
}

export interface GmailLabelRenamePayload {
  labelId: string;
  name: string;
  intentAt: string;
}

export interface GmailLabelDeletePayload {
  labelId: string;
  intentAt: string;
}

/**
 * `intentAt` is part of the *intent identity*, not decoration: it makes the
 * idempotency key unique per user action while remaining derivable from the stored
 * payload, so a retry reclaims its own journal row instead of inserting a second
 * one — and the same control used a second time is a new operation rather than a
 * replay of an old result.
 */
export function gmailLabelCreateIntent(payload: GmailLabelCreatePayload): { idempotencyKey: string; payloadHash: string } {
  return {
    idempotencyKey: `gmail-label-create:${payload.name}:${payload.intentAt}`,
    payloadHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
  };
}

export function gmailLabelRenameIntent(payload: GmailLabelRenamePayload): { idempotencyKey: string; payloadHash: string } {
  return {
    idempotencyKey: `gmail-label-rename:${payload.labelId}:${payload.name}:${payload.intentAt}`,
    payloadHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
  };
}

export function gmailLabelDeleteIntent(payload: GmailLabelDeletePayload): { idempotencyKey: string; payloadHash: string } {
  return {
    idempotencyKey: `gmail-label-delete:${payload.labelId}:${payload.intentAt}`,
    payloadHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
  };
}

export function gmailLabelCreateAdapter(options: {
  api: GoogleApiOptions;
  /** Injected in tests; the application uses `gmailCreateLabel`. */
  create?: typeof gmailCreateLabel;
}): ProviderMutationAdapter<GmailLabelCreatePayload, GmailLabelResult> {
  const create = options.create ?? gmailCreateLabel;
  return {
    resourceType: 'mail_label',
    // A duplicate name is a `409`, so a recovered claim must not be re-run.
    idempotent: false,
    async perform(write) {
      try {
        const created = await create(options.api, write.name);
        // A create that answers without an id cannot be linked to a local folder, so
        // it is not reported as success.
        if (!created?.id) return { status: 'outcome_unknown', code: 'MUTATION_OUTCOME_UNKNOWN' };
        return { status: 'committed', value: created };
      } catch (error) {
        return classifyGmailMailMutationFailure(error);
      }
    },
  };
}

export function gmailLabelRenameAdapter(options: {
  api: GoogleApiOptions;
  rename?: typeof gmailRenameLabel;
}): ProviderMutationAdapter<GmailLabelRenamePayload, GmailLabelResult> {
  const rename = options.rename ?? gmailRenameLabel;
  return {
    resourceType: 'mail_label',
    // A state set on one immutable id: re-applying it converges.
    idempotent: true,
    async perform(write) {
      try {
        const renamed = await rename(options.api, write.labelId, write.name);
        return { status: 'committed', value: renamed?.id ? renamed : { id: write.labelId } };
      } catch (error) {
        return classifyGmailMailMutationFailure(error);
      }
    },
  };
}

export function gmailLabelDeleteAdapter(options: {
  api: GoogleApiOptions;
  remove?: typeof gmailDeleteLabel;
}): ProviderMutationAdapter<GmailLabelDeletePayload, void> {
  const remove = options.remove ?? gmailDeleteLabel;
  return {
    resourceType: 'mail_label',
    idempotent: false,
    async perform(write) {
      try {
        await remove(options.api, write.labelId);
        return { status: 'committed' };
      } catch (error) {
        return classifyGmailMailMutationFailure(error);
      }
    },
  };
}

// ── Messages ─────────────────────────────────────────────────────────────────

/**
 * Gmail's label modification: the one write that expresses *every* message state
 * change this adapter needs.
 *
 * Gmail has no "move", no "flag" and no "mark read" of its own — a message's state
 * is its label set, and `messages.modify` adds and removes labels. `UNREAD` is the
 * unread marker (so read means *removing* it), `STARRED` is the flag, `INBOX` is
 * inbox membership, `TRASH` is the trash, and a user label is a folder. That makes
 * every one of these an **idempotent** state set: adding a label a message already
 * has, or removing one it does not, converges, so a recovered claim may safely run it
 * again. That is the deliberate opposite of the delete adapter below.
 */
export async function gmailModifyMessageLabels(
  api: GoogleApiOptions,
  providerMessageId: string,
  addLabelIds: readonly string[],
  removeLabelIds: readonly string[],
): Promise<void> {
  await gmailPost<unknown>(api, `users/${GMAIL_USER}/messages/${encodeURIComponent(providerMessageId)}/modify`, {
    addLabelIds: [...addLabelIds],
    removeLabelIds: [...removeLabelIds],
  });
}

/**
 * The label change a local flag corresponds to, or `null` for a flag Gmail has no
 * equivalent for. Returning null rather than guessing keeps an unimplemented flag a
 * visible refusal instead of a silent no-op.
 */
export function gmailLabelChangeForFlag(flag: string, value: boolean): { add: string[]; remove: string[] } | null {
  if (flag === '\\Seen') return value ? { add: [], remove: ['UNREAD'] } : { add: ['UNREAD'], remove: [] };
  if (flag === '\\Flagged') return value ? { add: ['STARRED'], remove: [] } : { add: [], remove: ['STARRED'] };
  return null;
}

/** A flag write as the application models it, with IMAP-style flag names. */
export interface GmailMailFlagPayload {
  providerMessageId: string;
  flag: string;
  value: boolean;
  intentAt: string;
}

/**
 * `intentAt` is part of the *intent identity*, not decoration: it makes the
 * idempotency key unique per user action while remaining derivable from the stored
 * payload, so a retry reclaims its own journal row instead of inserting a second one
 * — and a later click of the same control is a new operation rather than a replay of
 * an old result.
 */
export function gmailFlagIntent(input: { messageId: string; write: GmailMailFlagPayload }): { idempotencyKey: string; payloadHash: string } {
  return {
    idempotencyKey: `gmail-mail-flag:${input.messageId}:${input.write.flag}:${input.write.value}:${input.write.intentAt}`,
    payloadHash: createHash('sha256').update(JSON.stringify(input.write)).digest('hex'),
  };
}

export function gmailFlagMutationAdapter(options: {
  api: GoogleApiOptions;
  /** Injected in tests; the application uses `gmailModifyMessageLabels`. */
  modify?: typeof gmailModifyMessageLabels;
}): ProviderMutationAdapter<GmailMailFlagPayload, void> {
  const modify = options.modify ?? gmailModifyMessageLabels;
  return {
    resourceType: 'message',
    // A state set, not a delta: re-applying it converges.
    idempotent: true,
    async perform(write) {
      const change = gmailLabelChangeForFlag(write.flag, write.value);
      if (!change) return { status: 'permanent', code: 'OPERATION_FORBIDDEN' };
      try {
        await modify(options.api, write.providerMessageId, change.add, change.remove);
        return { status: 'committed' };
      } catch (error) {
        return classifyGmailMailMutationFailure(error);
      }
    },
  };
}

// ── Moving and archiving a message ───────────────────────────────────────────

/**
 * A move, as Gmail models it: the message keeps its identity and its labels change.
 *
 * `removeLabelId` is the mailbox the message is leaving, and it is optional because
 * archiving removes `INBOX` without naming a destination. Adding a label the message
 * already carries is a no-op on Gmail's side, so the whole operation converges and is
 * declared idempotent — unlike a Graph move, which re-identifies the message.
 */
export interface GmailMailMovePayload {
  providerMessageId: string;
  addLabelIds: string[];
  removeLabelIds: string[];
  intentAt: string;
}

export function gmailMoveIntent(payload: GmailMailMovePayload): { idempotencyKey: string; payloadHash: string } {
  return {
    idempotencyKey: `gmail-mail-move:${payload.providerMessageId}:${[...payload.addLabelIds].sort().join(',')}:${[...payload.removeLabelIds].sort().join(',')}:${payload.intentAt}`,
    payloadHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
  };
}

export function gmailMoveMutationAdapter(options: {
  api: GoogleApiOptions;
  modify?: typeof gmailModifyMessageLabels;
}): ProviderMutationAdapter<GmailMailMovePayload, void> {
  const modify = options.modify ?? gmailModifyMessageLabels;
  return {
    resourceType: 'message',
    // Adding/removing labels converges; the provider id does not change.
    idempotent: true,
    async perform(write) {
      try {
        await modify(options.api, write.providerMessageId, write.addLabelIds, write.removeLabelIds);
        return { status: 'committed' };
      } catch (error) {
        return classifyGmailMailMutationFailure(error);
      }
    },
  };
}

export interface GmailMailDeletePayload {
  providerMessageId: string;
  intentAt: string;
}

/**
 * Permanently remove one Gmail message.
 *
 * Not a move to Trash — that is a label change, and the caller decides which of the
 * two Inboxora's "delete" means. Gmail's `messages.delete` removes the message from
 * the mailbox (and from every label it carried), which is the same end state the
 * Graph adapter's permanent delete produces.
 */
export async function gmailDeleteMessage(api: GoogleApiOptions, providerMessageId: string): Promise<void> {
  await gmailDelete(api, `users/${GMAIL_USER}/messages/${encodeURIComponent(providerMessageId)}`);
}

export function gmailDeleteIntent(payload: GmailMailDeletePayload): { idempotencyKey: string; payloadHash: string } {
  return {
    idempotencyKey: `gmail-mail-delete:${payload.providerMessageId}:${payload.intentAt}`,
    payloadHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
  };
}

/**
 * A permanent delete is **not** declared idempotent: the second attempt answers
 * `404`, which is indistinguishable from "the message is gone for another reason",
 * so a recovered claim is parked as `outcome_unknown` instead of re-run. A
 * `retryable` classification still schedules a retry, because the adapter is then
 * explicitly saying nothing was applied.
 */
export function gmailDeleteMutationAdapter(options: {
  api: GoogleApiOptions;
  remove?: typeof gmailDeleteMessage;
}): ProviderMutationAdapter<GmailMailDeletePayload, void> {
  const remove = options.remove ?? gmailDeleteMessage;
  return {
    resourceType: 'message',
    idempotent: false,
    async perform(write) {
      try {
        await remove(options.api, write.providerMessageId);
        return { status: 'committed' };
      } catch (error) {
        return classifyGmailMailMutationFailure(error);
      }
    },
  };
}

/** One confirmed removal, or the reason it was not confirmed. */
export async function deleteGmailMessagePermanently(input: {
  userId: string;
  accountId: string;
  connectionId: string;
  config: GoogleApiOptions['config'];
  /** The local `messages.id`. */
  resourceId: string;
  providerMessageId: string;
}): Promise<{ deleted: true } | { deleted: false; code?: string }> {
  const payload: GmailMailDeletePayload = { providerMessageId: input.providerMessageId, intentAt: new Date().toISOString() };
  const result = await runProviderMutation(
    {
      userId: input.userId,
      channel: 'web',
      operation: 'delete',
      accountId: input.accountId,
      resourceId: input.resourceId,
      ...gmailDeleteIntent(payload),
      payload,
      retry: { delaySeconds: 300 },
    },
    gmailDeleteMutationAdapter({
      api: { userId: input.userId, connectionId: input.connectionId, config: input.config },
    }),
  );
  if (result.status === 'confirmed' || result.status === 'accepted') return { deleted: true };
  return { deleted: false, ...(result.code ? { code: result.code } : {}) };
}
