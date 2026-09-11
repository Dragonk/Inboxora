// Delivery of a calendar invitation is durable: a failed attempt is recorded with
// a scheduled retry, an identical retry resends, and the background drain picks up
// anything that is due — without ever sending a message that already succeeded.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('./db.js', () => ({ query }));
const { sendCalendarInvitation } = vi.hoisted(() => ({ sendCalendarInvitation: vi.fn() }));
vi.mock('./calendarInvitation.js', () => ({ sendCalendarInvitation }));

const {
  deliverInvitationOutbox, deliverStoredInvitation, drainPendingInvitations,
  invitationActionsForStorage, invitationDeliveryError, resolveInvitationActions,
} = await import('./calendarInvitationOutbox.js');

const startsAt = new Date('2026-09-11T12:00:00.000Z');
const endsAt = new Date('2026-09-11T13:00:00.000Z');
const action = { account: { id: 'account-1', email_address: 'owner@example.test' }, attendees: ['guest@example.test'], summary: 'Planning', uid: 'uid-1', allDay: false, method: 'REQUEST', sequence: 0, startsAt, endsAt };

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
  sendCalendarInvitation.mockReset();
  sendCalendarInvitation.mockResolvedValue(undefined);
});

describe('outbox payloads', () => {
  it('stores the account id, never the credential-bearing account row', () => {
    const stored = invitationActionsForStorage([action]);
    expect(stored).toEqual([{ accountId: 'account-1', attendees: ['guest@example.test'], summary: 'Planning', uid: 'uid-1', allDay: false, method: 'REQUEST', sequence: 0, startsAt, endsAt }]);
    expect(JSON.stringify(stored)).not.toContain('email_address');
    // The ISO strings a JSONB round trip produces are rehydrated into Dates.
    const roundTripped = invitationActionsForStorage([{ ...action, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() }]);
    expect(roundTripped[0].startsAt).toBe(startsAt.toISOString());
  });

  it('resolves a missing account by id and normalises stored dates', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'account-1', email_address: 'owner@example.test' }] });
    const resolved = await resolveInvitationActions('user-1', [{ accountId: 'account-1', attendees: ['g@example.test'], startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() }]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].account.id).toBe('account-1');
    expect(resolved[0].startsAt).toBeInstanceOf(Date);
    expect(resolved[0].startsAt.toISOString()).toBe(startsAt.toISOString());
  });

  it('falls back to the event sender when the payload has no account id', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'account-9' }] });
    const resolved = await resolveInvitationActions('user-1', [{ attendees: ['g@example.test'] }], 'account-9');
    expect(resolved[0].account.id).toBe('account-9');
  });

  it('drops an action whose account is gone rather than sending unauthenticated', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await resolveInvitationActions('user-1', [{ accountId: 'deleted-account' }])).toEqual([]);
  });
});

describe('delivery', () => {
  it('marks the row sent only after SMTP accepted every action', async () => {
    const result = await deliverInvitationOutbox({ outboxId: 'outbox-1', actions: [action] });
    expect(result).toEqual({ status: 'sent', lastError: null });
    expect(sendCalendarInvitation).toHaveBeenCalledTimes(1);
    expect(sendCalendarInvitation.mock.calls[0][0]).toMatchObject({ account: action.account, startsAt, endsAt });
    const sentUpdate = query.mock.calls.find(([sql]) => sql.includes("status = 'sent'"));
    expect(sentUpdate[0]).toContain('delivered_at = NOW()');
    expect(sentUpdate[0]).toContain('next_attempt_at = NULL');
  });

  it('records the error and schedules a retry instead of throwing', async () => {
    sendCalendarInvitation.mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ESOCKET' }));
    const result = await deliverInvitationOutbox({ outboxId: 'outbox-1', actions: [action] });
    expect(result).toEqual({ status: 'failed', lastError: 'connect ECONNREFUSED' });
    const failureUpdate = query.mock.calls.find(([sql]) => sql.includes("status = 'failed'"));
    expect(failureUpdate[0]).toContain('next_attempt_at = NOW()');
    expect(failureUpdate[1]).toEqual(['outbox-1', 'connect ECONNREFUSED']);
  });

  it('never reports success when no sender account can be resolved', async () => {
    const result = await deliverInvitationOutbox({ outboxId: 'outbox-1', actions: [] });
    expect(result.status).toBe('failed');
    expect(result.lastError).toContain('no sender account');
    expect(sendCalendarInvitation).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('re-sends a stored invitation on an explicit retry', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'account-1', email_address: 'owner@example.test' }] });
    const result = await deliverStoredInvitation({ userId: 'user-1', outboxId: 'outbox-1', payload: { actions: [{ accountId: 'account-1', attendees: ['g@example.test'], startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() }] } });
    expect(result.status).toBe('sent');
    expect(sendCalendarInvitation).toHaveBeenCalledTimes(1);
  });
});

describe('background drain', () => {
  it('only selects undelivered, due rows and reports each outcome', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-1', user_id: 'user-1', payload: { actions: [{ accountId: 'account-1' }] }, invite_account_id: 'account-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'account-1', email_address: 'owner@example.test' }] });
    const results = await drainPendingInvitations({ limit: 5 });
    const select = query.mock.calls[0][0];
    expect(select).toContain("o.status <> 'sent'");
    expect(select).toContain('o.attempts < $2');
    expect(select).toContain('o.next_attempt_at IS NULL OR o.next_attempt_at <= NOW()');
    expect(results).toEqual([{ id: 'outbox-1', status: 'sent', lastError: null }]);
  });

  it('records an undeliverable row as failed and still processes the rest of the queue', async () => {
    query.mockImplementation(async sql => {
      if (sql.includes('FROM calendar_invitation_outbox')) {
        return { rows: [{ id: 'outbox-1', user_id: 'user-1', payload: null, invite_account_id: null }, { id: 'outbox-2', user_id: 'user-1', payload: { actions: [{ accountId: 'account-2' }] }, invite_account_id: 'account-2' }] };
      }
      if (sql.includes('FROM email_accounts')) return { rows: [{ id: 'account-2', email_address: 'owner@example.test' }] };
      return { rows: [] };
    });
    const results = await drainPendingInvitations({ limit: 5 });
    expect(results).toEqual([
      { id: 'outbox-1', status: 'failed', lastError: 'no sender account is available for this invitation' },
      { id: 'outbox-2', status: 'sent', lastError: null },
    ]);
  });

  it('keeps draining the queue when one row throws', async () => {
    // Only the second row's account lookup succeeds, so the first broken row must
    // not stop the rest of the queue.
    let lookup = 0;
    query.mockImplementation(async sql => {
      if (sql.includes('FROM calendar_invitation_outbox')) {
        return { rows: [{ id: 'outbox-1', user_id: 'user-1', payload: { actions: [{ accountId: 'account-1' }] }, invite_account_id: 'account-1' }, { id: 'outbox-2', user_id: 'user-1', payload: { actions: [{ accountId: 'account-2' }] }, invite_account_id: 'account-2' }] };
      }
      if (sql.includes('FROM email_accounts')) {
        lookup += 1;
        if (lookup === 1) throw new Error('account lookup failed');
        return { rows: [{ id: 'account-2', email_address: 'owner@example.test' }] };
      }
      return { rows: [] };
    });
    const results = await drainPendingInvitations({ limit: 5 });
    expect(results.map(row => row.id)).toEqual(['outbox-2']);
    expect(sendCalendarInvitation).toHaveBeenCalledTimes(1);
  });
});

describe('user-facing delivery error', () => {
  it('says nothing when the invitation was delivered', () => {
    expect(invitationDeliveryError({ status: 'sent', lastError: null })).toBeNull();
    expect(invitationDeliveryError(null)).toBeNull();
  });

  it('names the SMTP reason and points at the retry affordance', () => {
    const message = invitationDeliveryError({ status: 'failed', lastError: 'SMTP unavailable' });
    expect(message).toContain('SMTP unavailable');
    expect(message).toContain('Retry save');
  });
});
