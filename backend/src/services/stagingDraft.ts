/**
 * The lifecycle of a **send staging draft**: the provider draft Inboxora creates in order to send a
 * message, as opposed to a draft the person saved and expects to find in Drafts.
 *
 * It exists as its own vocabulary because the two are not the same object and must not be shown as one.
 * The staging draft is a step of a send: it is created, filled with attachments, sent, and then either
 * gone (a sent message) or left behind by a failure, in which case reconciliation has to be able to tell
 * that it belongs to one Inboxora operation rather than to the user's drafts.
 *
 * It deliberately adds **no third durability mechanism**. The two that exist keep their roles: the send
 * intent (`send_idempotency`) owns the HTTP/user intent and its replay; the provider journal
 * (`provider_operations`) owns the provider mutation, and it is where this state is recorded — in its
 * payload, beside the operation that will act on it, with the provider draft id as the operation's
 * resource. A staging draft's state is therefore recoverable after a restart by reading the journal, and
 * an operation whose outcome is unknown is parked there rather than guessed.
 */
export const STAGING_DRAFT_STATES = [
  'creating',
  'uploading',
  'ready',
  'sending',
  'sent',
  'upload_failed',
  'send_outcome_unknown',
  'cancelled',
] as const;

export type StagingDraftState = typeof STAGING_DRAFT_STATES[number];

/**
 * The transitions a staging draft may make. Anything absent is refused — in particular there is no path
 * back into `sending` from `sent`, `send_outcome_unknown` or `cancelled`, which is what makes "an
 * uncertain send is never retried automatically" a property of the model rather than a rule each caller
 * has to remember. A deliberate resend is a **new intent** with a new staging draft, not a transition.
 */
const TRANSITIONS: Record<StagingDraftState, readonly StagingDraftState[]> = {
  creating: ['uploading', 'ready', 'upload_failed', 'cancelled'],
  uploading: ['ready', 'upload_failed', 'cancelled'],
  ready: ['sending', 'cancelled'],
  sending: ['sent', 'send_outcome_unknown'],
  sent: [],
  upload_failed: ['creating', 'uploading', 'cancelled'],
  send_outcome_unknown: [],
  cancelled: [],
};

export function canTransition(from: StagingDraftState, to: StagingDraftState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Terminal states: nothing follows them, and a resend must be a new intent. */
export function isTerminal(state: StagingDraftState): boolean {
  return TRANSITIONS[state].length === 0;
}

/** A state that means "do not touch the provider again for this operation". */
export function requiresReconciliation(state: StagingDraftState): boolean {
  return state === 'send_outcome_unknown' || state === 'upload_failed';
}

export interface StagingDraftRecord {
  state: StagingDraftState;
  /** The Inboxora user/HTTP intent this belongs to. */
  intentId: string | null;
  /** The provider draft, once created. */
  providerDraftId: string | null;
  /** The provider operation that owns the mutation, once claimed. */
  operationId: string | null;
  /** Why it stopped, when it stopped for a reason. */
  failureCode?: string | null;
}

/**
 * Build the record stored in the provider operation's payload.
 *
 * The custom header below is what lets a lost create response be resolved later: if the draft exists at
 * the provider, it carries this id, so "no draft was created" and "the draft exists but the answer was
 * lost" are distinguishable. It holds an opaque operation id and nothing else — no secrets, no tokens.
 */
export function stagingDraftOperationPayload(record: StagingDraftRecord): {
  stagingDraft: StagingDraftRecord;
  internetMessageHeaders: Array<{ name: string; value: string }>;
} {
  return {
    stagingDraft: record,
    internetMessageHeaders: record.operationId
      ? [{ name: STAGING_DRAFT_OPERATION_HEADER, value: record.operationId }]
      : [],
  };
}

export const STAGING_DRAFT_OPERATION_HEADER = 'X-Inboxora-Operation-Id';
