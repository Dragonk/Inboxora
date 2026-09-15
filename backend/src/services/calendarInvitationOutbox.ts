import { randomUUID } from 'node:crypto';

import { query } from './db.js';
import { sendCalendarInvitation } from './calendarInvitation.js';
import { toAppError } from '../utils/errors.js';

// A calendar invitation is only "sent" when SMTP accepted every remaining recipient.
// Rejected recipients remain in payload.actions for a targeted retry; accepted recipients
// are deliberately removed so retrying a partial send cannot duplicate their invitation.
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
  account: InvitationAccount;
  accountId?: string | null;
  startsAt: Date;
  endsAt: Date;
};
type AccountResolvedAction = ResolvedInvitationAction & { accountId: string | null };
type InvitationOutboxPayload = { actions?: unknown } | null;
type ResolvedAccountRow = InvitationAccount & { id: string };
type PendingInvitationRow = {
  id: string;
  user_id: string;
  payload: InvitationOutboxPayload;
  invite_account_id: string | null;
};
type InvitationDeliveryStatus = { status?: string | null; lastError?: string | null };
type InvitationDeliveryResult =
  | { status: 'sent'; lastError: null }
  | { status: 'failed'; lastError: string }
  | { status: 'processing'; lastError: null };
type DrainedInvitation = { id: string } & InvitationDeliveryResult;

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
    const rows = (await query<ResolvedAccountRow>('SELECT * FROM email_accounts WHERE user_id = $1 AND id = ANY($2::uuid[])', [userId, missingIds])).rows;
    const byId = new Map<string, ResolvedAccountRow>(rows.map(row => [row.id, row]));
    for (const action of normalized) {
      if (!action.account && action.accountId) action.account = byId.get(action.accountId) || null;
    }
  }
  return normalized.filter((action): action is AccountResolvedAction => Boolean(action.account));
}

export function invitationDeliveryError(status: InvitationDeliveryStatus | null | undefined) {
  if (!status || status.status === 'sent' || status.status === 'processing') return null;
  const detail = status.lastError ? ' (' + status.lastError + ')' : '';
  return 'The event was saved, but the invitation could not be sent' + detail + '. Use "Retry save" to send it again.';
}

// Direct request delivery and the background worker use the same database claim. A live
// processing claim rejects another sender; an expired claim can be recovered after a crash.
async function claimInvitation(outboxId: string) {
  const token = randomUUID();
  const result = await query<{ id: string }>(
    [
      'UPDATE calendar_invitation_outbox',
      "   SET status = 'processing',",
      '       claim_token = $2::uuid,',
      "       claim_expires_at = NOW() + ($3 * INTERVAL '1 second')",
      ' WHERE id = $1',
      '   AND (',
      "     status IN ('sending', 'failed')",
      "     OR (status = 'processing' AND claim_expires_at <= NOW())",
      '   )',
      ' RETURNING id',
    ].join('\n'),
    [outboxId, token, CLAIM_LEASE_SECONDS],
  );
  return result.rows[0] ? token : null;
}

// Atomically select and claim a bounded batch. The transaction finishes before SMTP so
// locks are never held over the network; token-conditional finalization prevents an old
// owner from overwriting a newer recovered claim.
async function claimPendingInvitations(limit: number) {
  const token = randomUUID();
  const result = await query<PendingInvitationRow>(
    [
      'WITH candidates AS (',
      '  SELECT o.id',
      '    FROM calendar_invitation_outbox o',
      '   WHERE o.attempts < $2',
      '     AND (',
      "       (o.status IN ('sending', 'failed')",
      '        AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= NOW()))',
      "       OR (o.status = 'processing' AND o.claim_expires_at <= NOW())",
      '     )',
      '   ORDER BY o.created_at ASC',
      '   LIMIT $1',
      '   FOR UPDATE SKIP LOCKED',
      ')',
      'UPDATE calendar_invitation_outbox o',
      "   SET status = 'processing',",
      '       claim_token = $3::uuid,',
      "       claim_expires_at = NOW() + ($4 * INTERVAL '1 second')",
      '  FROM candidates',
      ' WHERE o.id = candidates.id',
      'RETURNING o.id,',
      '          o.user_id,',
      '          o.payload,',
      '          (SELECT e.invite_account_id FROM calendar_events e WHERE e.id = o.event_id) AS invite_account_id',
    ].join('\n'),
    [limit, MAX_ATTEMPTS, token, CLAIM_LEASE_SECONDS],
  );
  return { token, rows: result.rows };
}

async function markSent(outboxId: string, claimToken: string) {
  const result = await query<{ id: string }>(
    [
      'UPDATE calendar_invitation_outbox',
      "   SET status = 'sent',",
      '       attempts = attempts + 1,',
      '       delivered_at = NOW(),',
      '       last_error = NULL,',
      '       next_attempt_at = NULL,',
      '       claim_token = NULL,',
      '       claim_expires_at = NULL',
      ' WHERE id = $1 AND claim_token = $2::uuid',
      ' RETURNING id',
    ].join('\n'),
    [outboxId, claimToken],
  );
  return result.rowCount !== 0;
}

// Exponential backoff capped at one hour, based on the attempts already made. When a
// recipient subset is supplied, persist it in the payload before releasing the claim.
async function markFailed(outboxId: string, claimToken: string, message: string, retryActions?: unknown) {
  const result = await query<{ attempts: number }>(
    [
      'UPDATE calendar_invitation_outbox',
      "   SET status = 'failed',",
      '       attempts = attempts + 1,',
      '       last_error = $3,',
      '       next_attempt_at = NOW() + make_interval(secs => LEAST(3600, 30 * power(2, attempts))::int),',
      '       payload = CASE',
      '         WHEN $4::jsonb IS NULL THEN payload',
      "         ELSE jsonb_set(payload, '{actions}', $4::jsonb, true)",
      '       END,',
      '       claim_token = NULL,',
      '       claim_expires_at = NULL',
      ' WHERE id = $1 AND claim_token = $2::uuid',
      ' RETURNING attempts',
    ].join('\n'),
    [outboxId, claimToken, String(message || 'delivery failed').slice(0, 2000), retryActions === undefined ? null : JSON.stringify(retryActions)],
  );
  return result.rowCount !== 0;
}

function rejectedAttendees(attendees: readonly string[], rejected: readonly string[]) {
  const requested = new Map(attendees.map(address => [address.trim().toLowerCase(), address]));
  const retry = [] as string[];
  for (const address of rejected) {
    const original = requested.get(address.trim().toLowerCase());
    if (original && !retry.includes(original)) retry.push(original);
  }
  return retry;
}

async function failDelivery(outboxId: string, claimToken: string, message: string, retryActions?: unknown): Promise<InvitationDeliveryResult> {
  const finalized = await markFailed(outboxId, claimToken, message, retryActions);
  return finalized ? { status: 'failed', lastError: message } : { status: 'processing', lastError: null };
}

/**
 * Send every action of one claimed outbox row through the account that owns it.
 * A partial SMTP acceptance leaves only rejected recipients (and unsent later actions)
 * queued, so a retry cannot resend recipients SMTP already accepted.
 */
export async function deliverInvitationOutbox({ outboxId, actions, claimToken }: {
  outboxId: string;
  actions: readonly ResolvedInvitationAction[];
  claimToken?: string | null;
}): Promise<InvitationDeliveryResult> {
  const token = claimToken || await claimInvitation(outboxId);
  if (!token) return { status: 'processing', lastError: null };

  const deliverable = (Array.isArray(actions) ? actions : []).filter(action => action?.account);
  if (!deliverable.length) {
    return failDelivery(outboxId, token, 'no sender account is available for this invitation');
  }

  try {
    for (let index = 0; index < deliverable.length; index += 1) {
      const { account, accountId, ...invitation } = deliverable[index];
      void accountId;
      const delivery = await sendCalendarInvitation({ account, ...invitation });
      const rejected = rejectedAttendees(invitation.attendees, delivery.rejected);
      if (rejected.length) {
        const remainingActions = [
          { account, accountId, ...invitation, attendees: rejected },
          ...deliverable.slice(index + 1),
        ];
        const message = 'SMTP rejected invitation recipient' + (rejected.length === 1 ? ': ' : 's: ') + rejected.join(', ');
        return failDelivery(outboxId, token, message, invitationActionsForStorage(remainingActions));
      }
    }
    const finalized = await markSent(outboxId, token);
    return finalized ? { status: 'sent', lastError: null } : { status: 'processing', lastError: null };
  } catch (caught) {
    const error = toAppError(caught);
    const result = await failDelivery(outboxId, token, error.message);
    if (result.status === 'failed') {
      console.error('Calendar invitation delivery failed:', error.message, error.code ? '(code ' + error.code + ')' : '');
    }
    return result;
  }
}

/** Deliver a stored invitation; the claim is acquired before account lookup or SMTP. */
export async function deliverStoredInvitation({ userId, outboxId, payload, fallbackAccountId = null, claimToken = null }: {
  userId: string | undefined;
  outboxId: string;
  payload: InvitationOutboxPayload | undefined;
  fallbackAccountId?: string | null;
  claimToken?: string | null;
}): Promise<InvitationDeliveryResult> {
  const token = claimToken || await claimInvitation(outboxId);
  if (!token) return { status: 'processing', lastError: null };
  const actions = await resolveInvitationActions(userId, payload?.actions, fallbackAccountId);
  return deliverInvitationOutbox({ outboxId, actions, claimToken: token });
}

/** Retry every due invitation after atomically claiming it for this worker. */
export async function drainPendingInvitations({ limit = 5 }: { limit?: number } = {}): Promise<DrainedInvitation[]> {
  const { token, rows } = await claimPendingInvitations(limit);
  const results: DrainedInvitation[] = [];
  for (const row of rows) {
    try {
      results.push({
        id: row.id,
        ...(await deliverStoredInvitation({
          userId: row.user_id,
          outboxId: row.id,
          payload: row.payload,
          fallbackAccountId: row.invite_account_id,
          claimToken: token,
        })),
      });
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
