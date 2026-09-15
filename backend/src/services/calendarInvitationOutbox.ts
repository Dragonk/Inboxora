import { query } from './db.js';
import { sendCalendarInvitation } from './calendarInvitation.js';
import { toAppError } from '../utils/errors.js';

// A calendar invitation is only "sent" when SMTP accepted it. The outbox keeps
// every attempt, its error and the next scheduled retry, so a transient SMTP
// failure (connection refused, expired OAuth token, greylisting) is recovered
// instead of leaving the event saved with an invitation that never left.
const MAX_ATTEMPTS = 5;
const DRAIN_INTERVAL_MS = 60 * 1000;

/** Exactly what sendCalendarInvitation accepts for one invitation. */
type InvitationSendInput = Parameters<typeof sendCalendarInvitation>[0];
/** The account slice an invitation is sent from. */
type InvitationAccount = InvitationSendInput['account'];
/** An action before its account row is resolved: the send fields plus the stored account id. */
type InvitationActionSource = Omit<InvitationSendInput, 'account'> & {
  account?: InvitationAccount | null;
  accountId?: string | null;
};
/** An action whose account row has been resolved and is ready to send. */
type ResolvedInvitationAction = Omit<InvitationSendInput, 'account' | 'startsAt' | 'endsAt'> & {
  account: InvitationAccount;
  accountId?: string | null;
  startsAt: Date;
  endsAt: Date;
};
/** A resolved action whose account id was always normalised to a value. */
type AccountResolvedAction = ResolvedInvitationAction & { accountId: string | null };
/** The nested JSONB payload stored per outbox row. */
type InvitationOutboxPayload = { actions?: unknown } | null;
/** The account row resolveInvitationActions reads back when an action only stored an id. */
type ResolvedAccountRow = InvitationAccount & { id: string };
/** One outbox row selected by the drain query. */
type PendingInvitationRow = {
  id: string;
  user_id: string;
  payload: InvitationOutboxPayload;
  invite_account_id: string | null;
};
/** The status invitationDeliveryError renders, and what a delivery returns. */
type InvitationDeliveryStatus = { status?: string | null; lastError?: string | null };
type InvitationDeliveryResult = { status: 'sent'; lastError: null } | { status: 'failed'; lastError: string };
/** One drain outcome: the row id plus its delivery result. */
type DrainedInvitation = { id: string } & InvitationDeliveryResult;

/**
 * The outbox payload crosses a JSONB boundary, so its actions arrive as unknown;
 * this is the same Array.isArray check the callers always relied on. Inside the
 * payload an action is the send contract plus the stored account id.
 */
function actionArray(actions: unknown): InvitationActionSource[] {
  return Array.isArray(actions) ? actions : [];
}

function toDate(value: Date | string | number): Date {
  return value instanceof Date ? value : new Date(value);
}

// What is stored in the outbox: never the account row itself (it holds
// credentials), only its id, so a retry resolves the account fresh.
export function invitationActionsForStorage(actions: unknown) {
  return actionArray(actions).map(({ account, ...action }) => ({
    ...action,
    accountId: action.accountId || account?.id || null,
  }));
}

// Rebuild deliverable actions from the stored payload (or straight from memory):
// resolve missing accounts by id and normalise the date fields, which cross the
// JSONB boundary as ISO strings.
export async function resolveInvitationActions(
  userId: string | undefined,
  actions: unknown,
  fallbackAccountId: string | null = null,
): Promise<AccountResolvedAction[]> {
  const normalized = actionArray(actions).map(action => ({
    ...action,
    accountId: action.accountId || action.account?.id || fallbackAccountId || null,
    startsAt: action.startsAt == null ? action.startsAt : toDate(action.startsAt),
    endsAt: action.endsAt == null ? action.endsAt : toDate(action.endsAt),
  }));
  const missingIds = [...new Set(normalized.flatMap(action => (!action.account && action.accountId ? [action.accountId] : [])))];
  if (missingIds.length) {
    // A disabled account retains SMTP settings (its row cannot be deleted while a
    // referenced event exists), so a failed send stays retryable after a toggle.
    const rows = (await query<ResolvedAccountRow>('SELECT * FROM email_accounts WHERE user_id = $1 AND id = ANY($2::uuid[])', [userId, missingIds])).rows;
    const byId = new Map<string, ResolvedAccountRow>(rows.map(row => [row.id, row]));
    for (const action of normalized) {
      if (!action.account && action.accountId) action.account = byId.get(action.accountId) || null;
    }
  }
  return normalized.filter((action): action is AccountResolvedAction => Boolean(action.account));
}

export function invitationDeliveryError(status: InvitationDeliveryStatus | null | undefined) {
  if (!status || status.status === 'sent') return null;
  const detail = status.lastError ? ` (${status.lastError})` : '';
  return `The event was saved, but the invitation could not be sent${detail}. Use "Retry save" to send it again.`;
}

async function markSent(outboxId: string) {
  await query("UPDATE calendar_invitation_outbox SET status = 'sent', attempts = attempts + 1, delivered_at = NOW(), last_error = NULL, next_attempt_at = NULL WHERE id = $1", [outboxId]);
}

// Exponential backoff capped at one hour, based on the attempts already made.
async function markFailed(outboxId: string, message: string) {
  const result = await query(
    `UPDATE calendar_invitation_outbox
        SET status = 'failed',
            attempts = attempts + 1,
            last_error = $2,
            next_attempt_at = NOW() + make_interval(secs => LEAST(3600, 30 * power(2, attempts))::int)
      WHERE id = $1
      RETURNING attempts`,
    [outboxId, String(message || 'delivery failed').slice(0, 2000)],
  );
  return result.rows[0]?.attempts ?? null;
}

/**
 * Send every action of one outbox row through the account that owns it.
 * Returns { status: 'sent' | 'failed', lastError }. A failure never throws: the
 * event is already committed and the invitation stays queued for another try.
 */
export async function deliverInvitationOutbox({ outboxId, actions }: { outboxId: string; actions: readonly ResolvedInvitationAction[] }): Promise<InvitationDeliveryResult> {
  const deliverable = (Array.isArray(actions) ? actions : []).filter(action => action?.account);
  if (!deliverable.length) {
    await markFailed(outboxId, 'no sender account is available for this invitation');
    return { status: 'failed', lastError: 'no sender account is available for this invitation' };
  }
  try {
    for (const { account, accountId, ...invitation } of deliverable) {
      void accountId;
      await sendCalendarInvitation({ account, ...invitation });
    }
    await markSent(outboxId);
    return { status: 'sent', lastError: null };
  } catch (caught) {
    const error = toAppError(caught);
    await markFailed(outboxId, error.message);
    console.error('Calendar invitation delivery failed:', error.message, error.code ? `(code ${error.code})` : '');
    return { status: 'failed', lastError: error.message };
  }
}

/**
 * Deliver an invitation stored in the outbox. This is the path an explicit retry
 * takes, so it resends even when a previous attempt already recorded an error.
 */
export async function deliverStoredInvitation({ userId, outboxId, payload, fallbackAccountId = null }: {
  userId: string | undefined;
  outboxId: string;
  payload: InvitationOutboxPayload | undefined;
  fallbackAccountId?: string | null;
}): Promise<InvitationDeliveryResult> {
  const actions = await resolveInvitationActions(userId, payload?.actions, fallbackAccountId);
  return deliverInvitationOutbox({ outboxId, actions });
}

/**
 * Retry every undelivered invitation that is due. Called on a timer so a
 * transient SMTP outage heals without the user having to reopen the event.
 */
export async function drainPendingInvitations({ limit = 5 }: { limit?: number } = {}): Promise<DrainedInvitation[]> {
  const rows = (await query<PendingInvitationRow>(
    `SELECT o.id, o.user_id, o.payload, e.invite_account_id
       FROM calendar_invitation_outbox o
       LEFT JOIN calendar_events e ON e.id = o.event_id
      WHERE o.status <> 'sent'
        AND o.attempts < $2
        AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= NOW())
      ORDER BY o.created_at ASC
      LIMIT $1`,
    [limit, MAX_ATTEMPTS],
  )).rows;
  const results: DrainedInvitation[] = [];
  for (const row of rows) {
    // Never let one broken account stop the rest of the queue.
    try {
      results.push({ id: row.id, ...(await deliverStoredInvitation({ userId: row.user_id, outboxId: row.id, payload: row.payload, fallbackAccountId: row.invite_account_id })) });
    } catch (caught) {
      const error = toAppError(caught);
      console.error('Calendar invitation outbox drain failed:', error.message);
    }
  }
  return results;
}

export function startCalendarInvitationOutboxWorker() {
  const timer = setInterval(() => {
    drainPendingInvitations({ limit: 5 }).catch(error => console.warn('Calendar invitation retry failed:', error.message));
  }, DRAIN_INTERVAL_MS);
  timer.unref?.();
  return timer;
}
