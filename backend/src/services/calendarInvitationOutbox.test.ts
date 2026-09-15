import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { query as queryContract } from './db.js';
import type { sendCalendarInvitation as sendCalendarInvitationContract } from './calendarInvitation.js';

const { query } = vi.hoisted(() => ({ query: vi.fn<typeof queryContract>() }));
vi.mock('./db.js', () => ({ query }));
const { sendCalendarInvitation } = vi.hoisted(() => ({ sendCalendarInvitation: vi.fn<typeof sendCalendarInvitationContract>() }));
vi.mock('./calendarInvitation.js', () => ({ sendCalendarInvitation }));

const {
  deliverInvitationOutbox, deliverStoredInvitation, drainPendingInvitations,
  invitationActionsForStorage, invitationDeliveryError, resolveInvitationActions,
} = vi.mocked(await import('./calendarInvitationOutbox.js'));

const startsAt = new Date('2026-09-11T12:00:00.000Z');
const endsAt = new Date('2026-09-11T13:00:00.000Z');
const account = { id: 'account-1', email_address: 'owner@example.test' };
const action = {
  account,
  attendees: ['accepted@example.test', 'rejected@example.test'],
  summary: 'Planning',
  uid: 'uid-1',
  allDay: false,
  method: 'REQUEST',
  sequence: 0,
  startsAt,
  endsAt,
};

function sql(value: unknown) {
  return String(value);
}

beforeEach(() => {
  query.mockReset();
  sendCalendarInvitation.mockReset();
  sendCalendarInvitation.mockResolvedValue({ accepted: ['accepted@example.test', 'rejected@example.test'], rejected: [] });
});

describe('outbox payloads', () => {
  it('stores the account id, never the credential-bearing account row', () => {
    const stored = invitationActionsForStorage([action]);
    expect(stored).toEqual([{ accountId: 'account-1', attendees: action.attendees, summary: 'Planning', uid: 'uid-1', allDay: false, method: 'REQUEST', sequence: 0, startsAt, endsAt }]);
    expect(JSON.stringify(stored)).not.toContain('email_address');
  });

  it('resolves a missing account by id and normalises stored dates', async () => {
    query.mockResolvedValueOnce({ rows: [account] });
    const resolved = await resolveInvitationActions('user-1', [{ accountId: 'account-1', attendees: ['g@example.test'], startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() }]);
    expect(resolved[0].account.id).toBe('account-1');
    expect(resolved[0].startsAt).toBeInstanceOf(Date);
  });
});

describe('recipient-aware delivery', () => {
  it('persists only rejected recipients and retries only that subset', async () => {
    let retryPayload: { actions?: unknown } | undefined;
    query.mockImplementation(async (statement: string, params?: unknown[]) => {
      const text = sql(statement);
      if (text.includes("SET status = 'processing'")) return { rows: [{ id: 'outbox-1' }], rowCount: 1 };
      if (text.includes('FROM email_accounts')) return { rows: [account], rowCount: 1 };
      if (text.includes("SET status = 'failed'")) {
        retryPayload = { actions: JSON.parse(String(params?.[3])) };
        return { rows: [{ attempts: 1 }], rowCount: 1 };
      }
      if (text.includes("SET status = 'sent'")) return { rows: [{ id: 'outbox-1' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    sendCalendarInvitation
      .mockResolvedValueOnce({ accepted: ['accepted@example.test'], rejected: ['rejected@example.test'] })
      .mockResolvedValueOnce({ accepted: ['rejected@example.test'], rejected: [] });

    const first = await deliverInvitationOutbox({ outboxId: 'outbox-1', actions: [action] });
    expect(first).toMatchObject({ status: 'failed' });
    expect(first.lastError).toContain('rejected@example.test');
    expect(retryPayload).toEqual(expect.objectContaining({
      actions: [expect.objectContaining({ accountId: 'account-1', attendees: ['rejected@example.test'] })],
    }));

    const second = await deliverStoredInvitation({ userId: 'user-1', outboxId: 'outbox-1', payload: retryPayload });
    expect(second).toEqual({ status: 'sent', lastError: null });
    expect(sendCalendarInvitation).toHaveBeenCalledTimes(2);
    expect(sendCalendarInvitation.mock.calls[1][0].attendees).toEqual(['rejected@example.test']);
  });

  it('does not overwrite delivery after losing the claim owner token', async () => {
    query.mockImplementation(async (statement: string) => {
      const text = sql(statement);
      if (text.includes("SET status = 'processing'")) return { rows: [{ id: 'outbox-1' }], rowCount: 1 };
      if (text.includes("SET status = 'sent'")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });

    const result = await deliverInvitationOutbox({ outboxId: 'outbox-1', actions: [action] });
    expect(result).toEqual({ status: 'processing', lastError: null });
    const finalization = query.mock.calls.find(([statement]) => sql(statement).includes("SET status = 'sent'"));
    expect(sql(finalization?.[0])).toContain('claim_token = $2::uuid');
  });
});

describe('atomic background drain', () => {
  it('claims due rows with SKIP LOCKED before SMTP and leaves a concurrent drain nothing to send', async () => {
    let claims = 0;
    query.mockImplementation(async (statement: string) => {
      const text = sql(statement);
      if (text.includes('WITH candidates')) {
        claims += 1;
        return claims === 1
          ? { rows: [{ id: 'outbox-1', user_id: 'user-1', payload: { actions: [{ accountId: 'account-1', attendees: ['guest@example.test'], startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() }] }, invite_account_id: 'account-1' }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (text.includes('FROM email_accounts')) return { rows: [account], rowCount: 1 };
      if (text.includes("SET status = 'sent'")) return { rows: [{ id: 'outbox-1' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    const first = await drainPendingInvitations({ limit: 5 });
    const second = await drainPendingInvitations({ limit: 5 });
    expect(first).toEqual([{ id: 'outbox-1', status: 'sent', lastError: null }]);
    expect(second).toEqual([]);
    expect(sendCalendarInvitation).toHaveBeenCalledTimes(1);
    const claim = query.mock.calls.find(([statement]) => sql(statement).includes('WITH candidates'));
    expect(sql(claim?.[0])).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql(claim?.[0])).toContain("SET status = 'processing'");
    expect(sql(claim?.[0])).toContain('claim_token = $3::uuid');
  });
});

describe('user-facing delivery error', () => {
  it('does not present an in-progress claim as a retryable failure', () => {
    expect(invitationDeliveryError({ status: 'processing', lastError: null })).toBeNull();
  });
});
