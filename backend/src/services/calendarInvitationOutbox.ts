import { randomUUID } from 'node:crypto';

import { query } from './db.js';
import { sendCalendarInvitation } from './calendarInvitation.js';
import { toAppError } from '../utils/errors.js';

// SMTP acceptance is checkpointed per action and per recipient. A retry therefore
// never repeats an action that was fully accepted before a later action failed.
const MAX_ATTEMPTS = 5;
const DRAIN_INTERVAL_MS = 60 * 1000;
const CLAIM_LEASE_SECONDS = 15 * 60;

type InvitationSendInput = Parameters<typeof sendCalendarInvitation>[0];
type InvitationAccount = InvitationSendInput['account'];
type InvitationActionSource = Omit<InvitationSendInput, 'account'> & {
  account?: InvitationAccount | null;
  accountId?: string | null;
};
type ResolvedInvitationAction = Omit<InvitationSendInput, 'account' | 'startsAt' | 'endsAt'> & {
  account: InvitationAccount | null;
  accountId: string | null;
  startsAt: Date;
  endsAt: Date;
};
type InvitationOutboxPayload = { actions?: unknown } | null;
type ClaimedInvitationRow = {
  id: string;
  user_id: string;
  payload: InvitationOutboxPayload;
  invite_account_id: string | null;
  completion_checkpointed_at?: Date | string | null;
};
type InvitationDeliveryStatus = { status?: string | null; lastError?: string | null };
type InvitationDeliveryResult =
  | { status: 'sent'; lastError: null }
  | { status: 'failed'; lastError: string }
  | { status: 'uncertain'; lastError: string }
  | { status: 'processing'; lastError: null };
type DrainedInvitation = { id: string } & InvitationDeliveryResult;

function actionArray(actions: unknown): InvitationActionSource[] {
  return Array.isArray(actions) ? actions : [];
}

function toDate(value: Date | string | number): Date {
  return value instanceof Date ? value : new Date(value);
}

// Outbox payloads hold account ids only, never credential-bearing account rows.
export function invitationActionsForStorage(actions: unknown) {
  return actionArray(actions).map(({ account, ...action }) => ({
    ...action,
    accountId: action.accountId || account?.id || null,
  }));
}

export async function resolveInvitationActions(
  userId: string | undefined,
  actions: unknown,
  fallbackAccountId: string | null = null,
): Promise<ResolvedInvitationAction[]> {
  const normalized = actionArray(actions).map(action => ({
    ...action,
    account: action.account || null,
    accountId: action.accountId || action.account?.id || fallbackAccountId || null,
    startsAt: action.startsAt == null ? action.startsAt : toDate(action.startsAt),
    endsAt: action.endsAt == null ? action.endsAt : toDate(action.endsAt),
  }));
  const missingIds = [...new Set(normalized.flatMap(action => (!action.account && action.accountId ? [action.accountId] : [])))];
  if (missingIds.length) {
    const rows = (await query<InvitationAccount & { id: string }>('SELECT * FROM email_accounts WHERE user_id = $1 AND id = ANY($2::uuid[])', [userId, missingIds])).rows;
    const byId = new Map(rows.map(row => [row.id, row]));
    for (const action of normalized) {
      if (!action.account && action.accountId) action.account = byId.get(action.accountId) || null;
    }
  }
  return normalized as ResolvedInvitationAction[];
}

export function invitationDeliveryError(status: InvitationDeliveryStatus | null | undefined) {
  if (!status || status.status === 'sent' || status.status === 'processing') return null;
  const detail = status.lastError ? ' (' + status.lastError + ')' : '';
  if (status.status === 'uncertain') return 'The event was saved, but the invitation delivery outcome is uncertain' + detail + '. It will not be automatically resent.';
  return 'The event was saved, but the invitation could not be sent' + detail + '. Use "Retry save" to send it again.';
}

// Claim and read the authoritative row in one UPDATE ... RETURNING. Callers must
// never pass a pre-claim payload, because another worker may have checkpointed it.
async function claimInvitation(outboxId: string): Promise<{ token: string; row: ClaimedInvitationRow } | null> {
  const token = randomUUID();
  const result = await query<ClaimedInvitationRow>([
    'UPDATE calendar_invitation_outbox o',
    "   SET status = 'processing',",
    '       claim_token = $2::uuid,',
    "       claim_expires_at = NOW() + ($3 * INTERVAL '1 second')",
    ' WHERE o.id = $1',
    '   AND (',
    "     o.status IN ('sending', 'failed')",
    "     OR (o.status = 'processing' AND o.claim_expires_at <= NOW())",
    '   )',
    ' RETURNING o.id, o.user_id, o.payload, o.completion_checkpointed_at,',
    '   (SELECT e.invite_account_id FROM calendar_events e WHERE e.id = o.event_id) AS invite_account_id',
  ].join('\n'), [outboxId, token, CLAIM_LEASE_SECONDS]);
  return result.rows[0] ? { token, row: result.rows[0] } : null;
}

async function claimPendingInvitations(limit: number) {
  const token = randomUUID();
  const result = await query<ClaimedInvitationRow>([
    'WITH candidates AS (',
    '  SELECT o.id FROM calendar_invitation_outbox o',
    '   WHERE o.attempts < $2 AND (',
    "     (o.status IN ('sending', 'failed') AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= NOW()))",
    "     OR (o.status = 'processing' AND o.claim_expires_at <= NOW())",
    '   ) ORDER BY o.created_at ASC LIMIT $1 FOR UPDATE SKIP LOCKED',
    ')',
    'UPDATE calendar_invitation_outbox o',
    "   SET status = 'processing', claim_token = $3::uuid,",
    "       claim_expires_at = NOW() + ($4 * INTERVAL '1 second')",
    '  FROM candidates WHERE o.id = candidates.id',
    'RETURNING o.id, o.user_id, o.payload, o.completion_checkpointed_at,',
    '  (SELECT e.invite_account_id FROM calendar_events e WHERE e.id = o.event_id) AS invite_account_id',
  ].join('\n'), [limit, MAX_ATTEMPTS, token, CLAIM_LEASE_SECONDS]);
  return { token, rows: result.rows };
}

// Renew immediately before every SMTP call. An expired/recovered claim cannot
// start a later SMTP action, even if its conditional final write would fail.
async function renewClaim(outboxId: string, claimToken: string) {
  const result = await query<{ id: string }>([
    'UPDATE calendar_invitation_outbox',
    "   SET claim_expires_at = NOW() + ($3 * INTERVAL '1 second')",
    " WHERE id = $1 AND claim_token = $2::uuid AND status = 'processing' AND claim_expires_at > NOW()",
    ' RETURNING id',
  ].join('\n'), [outboxId, claimToken, CLAIM_LEASE_SECONDS]);
  return result.rowCount !== 0;
}

// Once this commits, a process crash or a lost SMTP/DATA response cannot be
// retried automatically. The durable action identity is for reconciliation.
async function beginDispatch(outboxId: string, claimToken: string, action: ResolvedInvitationAction) {
  const result = await query<{ id: string }>([
    'UPDATE calendar_invitation_outbox',
    "   SET claim_expires_at = NOW() + ($4 * INTERVAL '1 second'),",
    "       status = 'uncertain', dispatch_action = $3::jsonb, dispatch_started_at = NOW(),",
    "       last_error = 'SMTP dispatch outcome is not confirmed'",
    " WHERE id = $1 AND claim_token = $2::uuid AND status = 'processing' AND claim_expires_at > NOW()",
    ' RETURNING id',
  ].join('\n'), [outboxId, claimToken, JSON.stringify(invitationActionsForStorage([action])[0]), CLAIM_LEASE_SECONDS]);
  return result.rowCount !== 0;
}

async function checkpointActions(outboxId: string, claimToken: string, actions: unknown) {
  const result = await query<{ id: string }>([
    'UPDATE calendar_invitation_outbox',
    "   SET payload = jsonb_set(payload, '{actions}', $3::jsonb, true),",
    "       status = 'processing', completion_checkpointed_at = NULL, last_error = NULL,",
    '       dispatch_action = NULL, dispatch_started_at = NULL',
    " WHERE id = $1 AND claim_token = $2::uuid AND status = 'uncertain' AND claim_expires_at > NOW()",
    ' RETURNING id',
  ].join('\n'), [outboxId, claimToken, JSON.stringify(invitationActionsForStorage(actions))]);
  return result.rowCount !== 0;
}

// The terminal empty checkpoint and sent status share one conditional UPDATE. This
// leaves no normal crash window with processing + an unqualified empty payload.
async function completeDelivery(outboxId: string, claimToken: string) {
  const result = await query<{ id: string }>([
    'UPDATE calendar_invitation_outbox',
    "   SET payload = jsonb_set(payload, '{actions}', '[]'::jsonb, true),",
    '       completion_checkpointed_at = NOW(),',
    "       status = 'sent', attempts = attempts + 1, delivered_at = NOW(), last_error = NULL,",
    "       next_attempt_at = NULL, claim_token = NULL, claim_expires_at = NULL,",
    '       dispatch_action = NULL, dispatch_started_at = NULL',
    " WHERE id = $1 AND claim_token = $2::uuid AND status = 'uncertain' AND claim_expires_at > NOW()",
    ' RETURNING id',
  ].join('\n'), [outboxId, claimToken]);
  return result.rowCount !== 0;
}

// A legacy/reconciliation marker proves that an empty payload followed confirmed
// SMTP acceptance. It may be finalized without another SMTP dispatch.
async function markSent(outboxId: string, claimToken: string) {
  const result = await query<{ id: string }>([
    'UPDATE calendar_invitation_outbox',
    "   SET status = 'sent', attempts = attempts + 1, delivered_at = NOW(), last_error = NULL,",
    '       next_attempt_at = NULL, claim_token = NULL, claim_expires_at = NULL',
    " WHERE id = $1 AND claim_token = $2::uuid AND status = 'processing' AND claim_expires_at > NOW()",
    ' RETURNING id',
  ].join('\n'), [outboxId, claimToken]);
  return result.rowCount !== 0;
}

async function markFailed(outboxId: string, claimToken: string, message: string, retryActions: unknown, completedCheckpoint = false) {
  const result = await query<{ attempts: number }>([
    'UPDATE calendar_invitation_outbox',
    "   SET status = 'failed', attempts = attempts + 1, last_error = $3,",
    '       next_attempt_at = NOW() + make_interval(secs => LEAST(3600, 30 * power(2, attempts))::int),',
    "       payload = jsonb_set(payload, '{actions}', $4::jsonb, true),",
    '       completion_checkpointed_at = CASE WHEN $5 THEN NOW() ELSE NULL END,',
    '       claim_token = NULL, claim_expires_at = NULL, dispatch_action = NULL, dispatch_started_at = NULL',
    " WHERE id = $1 AND claim_token = $2::uuid AND status IN ('processing', 'uncertain') AND claim_expires_at > NOW()",
    ' RETURNING attempts',
  ].join('\n'), [outboxId, claimToken, String(message || 'delivery failed').slice(0, 2000), JSON.stringify(invitationActionsForStorage(retryActions)), completedCheckpoint]);
  return result.rowCount !== 0;
}

function isExplicitSmtpRejection(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const responseCode = (error as { responseCode?: unknown }).responseCode;
  return typeof responseCode === 'number' && Number.isInteger(responseCode) && responseCode >= 400 && responseCode <= 599;
}

function hasCompleteRecipientOutcome(attendees: readonly string[], accepted: readonly string[], rejected: readonly string[]) {
  const requested = new Set(attendees.map(address => address.trim().toLowerCase()).filter(Boolean));
  const acceptedSet = new Set(accepted.map(address => address.trim().toLowerCase()).filter(address => requested.has(address)));
  const rejectedSet = new Set(rejected.map(address => address.trim().toLowerCase()).filter(address => requested.has(address)));
  return [...requested].every(address => acceptedSet.has(address) !== rejectedSet.has(address));
}

function rejectedAttendees(attendees: readonly string[], rejected: readonly string[]) {
  const requested = new Map(attendees.map(address => [address.trim().toLowerCase(), address]));
  const retry: string[] = [];
  for (const address of rejected) {
    const original = requested.get(address.trim().toLowerCase());
    if (original && !retry.includes(original)) retry.push(original);
  }
  return retry;
}

async function failDelivery(outboxId: string, claimToken: string, message: string, retryActions: unknown, completedCheckpoint = false): Promise<InvitationDeliveryResult> {
  return await markFailed(outboxId, claimToken, message, retryActions, completedCheckpoint)
    ? { status: 'failed', lastError: message }
    : { status: 'processing', lastError: null };
}

async function deliverClaimedInvitation({ outboxId, actions, claimToken }: { outboxId: string; actions: readonly ResolvedInvitationAction[]; claimToken: string }): Promise<InvitationDeliveryResult> {
  for (let index = 0; index < actions.length; index += 1) {
    const current = actions[index];
    const remaining = actions.slice(index + 1);
    if (!current.account) return failDelivery(outboxId, claimToken, 'no sender account is available for this invitation action', actions.slice(index));
    if (!await renewClaim(outboxId, claimToken)) return { status: 'processing', lastError: null };
    if (!await beginDispatch(outboxId, claimToken, current)) return { status: 'processing', lastError: null };
    const { account, accountId, ...invitation } = current;
    let delivery: Awaited<ReturnType<typeof sendCalendarInvitation>>;
    try {
      delivery = await sendCalendarInvitation({ account, ...invitation });
    } catch (caught) {
      const error = toAppError(caught);
      if (isExplicitSmtpRejection(caught)) {
        const result = await failDelivery(outboxId, claimToken, error.message, [current, ...remaining]);
        if (result.status === 'failed') console.error('Calendar invitation delivery failed:', error.message, error.code ? '(code ' + error.code + ')' : '');
        return result;
      }
      console.error('Calendar invitation delivery outcome is uncertain:', error.message, error.code ? '(code ' + error.code + ')' : '');
      return { status: 'uncertain', lastError: error.message };
    }
    if (!hasCompleteRecipientOutcome(invitation.attendees, delivery.accepted, delivery.rejected)) {
      const message = 'SMTP recipient outcome was incomplete or contradictory';
      console.error('Calendar invitation delivery outcome is uncertain:', message);
      return { status: 'uncertain', lastError: message };
    }
    const rejected = rejectedAttendees(invitation.attendees, delivery.rejected);
    if (rejected.length) {
      const retryActions = [{ ...current, attendees: rejected }, ...remaining];
      const message = 'SMTP rejected invitation recipient' + (rejected.length === 1 ? ': ' : 's: ') + rejected.join(', ');
      return failDelivery(outboxId, claimToken, message, retryActions);
    }
    try {
      // Full SMTP acceptance is never put back into the retry payload. The last
      // checkpoint becomes sent atomically; earlier checkpoints retain only later actions.
      const finalized = remaining.length
        ? await checkpointActions(outboxId, claimToken, remaining)
        : await completeDelivery(outboxId, claimToken);
      if (!finalized) return { status: 'uncertain', lastError: 'SMTP dispatch outcome could not be finalized' };
      if (!remaining.length) return { status: 'sent', lastError: null };
      void accountId;
    } catch (caught) {
      const error = toAppError(caught);
      // The dispatch marker remains uncertain if this final write was lost. Do not
      // replace it with a retryable row: SMTP may already have accepted current.
      console.error('Calendar invitation delivery checkpoint outcome is uncertain:', error.message);
      return { status: 'uncertain', lastError: 'delivery checkpoint could not be persisted: ' + error.message };
    }
  }
  return { status: 'sent', lastError: null };
}

/** Claim, read current payload, resolve senders, and deliver one stored invitation. */
export async function deliverStoredInvitation({ outboxId, claimToken = null, claimedRow = null }: {
  outboxId: string;
  claimToken?: string | null;
  claimedRow?: ClaimedInvitationRow | null;
}): Promise<InvitationDeliveryResult> {
  const claimed = claimToken && claimedRow ? { token: claimToken, row: claimedRow } : await claimInvitation(outboxId);
  if (!claimed) return { status: 'processing', lastError: null };
  const actions = await resolveInvitationActions(claimed.row.user_id, claimed.row.payload?.actions, claimed.row.invite_account_id);
  if (!actions.length) {
    if (claimed.row.completion_checkpointed_at) {
      return await markSent(outboxId, claimed.token) ? { status: 'sent', lastError: null } : { status: 'processing', lastError: null };
    }
    return failDelivery(outboxId, claimed.token, 'no invitation actions are available for delivery', []);
  }
  return deliverClaimedInvitation({ outboxId, actions, claimToken: claimed.token });
}

/** Compatibility entry point for callers with freshly-resolved actions. */
export async function deliverInvitationOutbox({ outboxId }: { outboxId: string; actions?: readonly ResolvedInvitationAction[]; claimToken?: string | null }): Promise<InvitationDeliveryResult> {
  return deliverStoredInvitation({ outboxId });
}

/** Retry every due invitation after atomically claiming it for this worker. */
export async function drainPendingInvitations({ limit = 1 }: { limit?: number } = {}): Promise<DrainedInvitation[]> {
  const { token, rows } = await claimPendingInvitations(limit);
  const results: DrainedInvitation[] = [];
  for (const row of rows) {
    try {
      results.push({ id: row.id, ...(await deliverStoredInvitation({ outboxId: row.id, claimToken: token, claimedRow: row })) });
    } catch (caught) {
      const error = toAppError(caught);
      console.error('Calendar invitation outbox drain failed:', error.message);
    }
  }
  return results;
}

export function startCalendarInvitationOutboxWorker() {
  const timer = setInterval(() => {
    drainPendingInvitations().catch(error => console.warn('Calendar invitation retry failed:', error.message));
  }, DRAIN_INTERVAL_MS);
  timer.unref?.();
  return timer;
}
