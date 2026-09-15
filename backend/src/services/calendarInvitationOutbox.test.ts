import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { query as queryContract } from './db.js';
import type { sendCalendarInvitation as sendCalendarInvitationContract } from './calendarInvitation.js';

const { query } = vi.hoisted(() => ({ query: vi.fn<typeof queryContract>() }));
vi.mock('./db.js', () => ({ query }));
const { sendCalendarInvitation } = vi.hoisted(() => ({ sendCalendarInvitation: vi.fn<typeof sendCalendarInvitationContract>() }));
vi.mock('./calendarInvitation.js', () => ({ sendCalendarInvitation }));

const { deliverStoredInvitation, drainPendingInvitations, invitationActionsForStorage, resolveInvitationActions } = vi.mocked(await import('./calendarInvitationOutbox.js'));

const startsAt = new Date('2026-09-11T12:00:00.000Z');
const endsAt = new Date('2026-09-11T13:00:00.000Z');
const account = { id: 'account-1', email_address: 'owner@example.test' };
const baseAction = { accountId: 'account-1', attendees: ['guest@example.test'], summary: 'Planning', uid: 'uid-1', allDay: false, method: 'REQUEST', sequence: 0, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() };

function sql(value: unknown) { return String(value); }
function claimed(actions: unknown) { return { id: 'outbox-1', user_id: 'user-1', payload: { actions }, invite_account_id: 'account-1' }; }

beforeEach(() => {
  query.mockReset();
  sendCalendarInvitation.mockReset().mockResolvedValue({ accepted: ['guest@example.test'], rejected: [] });
});

describe('outbox payloads', () => {
  it('stores the account id, never the credential-bearing account row', () => {
    const stored = invitationActionsForStorage([{ ...baseAction, account }]);
    expect(stored).toEqual([baseAction]);
    expect(JSON.stringify(stored)).not.toContain('email_address');
  });

  it('keeps an unresolved sender action rather than silently dropping it', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const resolved = await resolveInvitationActions('user-1', [baseAction]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].account).toBeNull();
  });
});

describe('claimed invitation delivery', () => {
  it('checkpoints an accepted earlier action before a later action fails (V3-04)', async () => {
    const first = { ...baseAction, attendees: ['first@example.test'], method: 'CANCEL' };
    const second = { ...baseAction, attendees: ['second@example.test'], method: 'REQUEST' };
    let failurePayload: unknown;
    query.mockImplementation(async (statement: string, params?: unknown[]) => {
      const text = sql(statement);
      if (text.includes("SET status = 'processing'")) return { rows: [claimed([first, second])], rowCount: 1 };
      if (text.includes('FROM email_accounts')) return { rows: [account], rowCount: 1 };
      if (text.includes('SET claim_expires_at')) return { rows: [{ id: 'outbox-1' }], rowCount: 1 };
      if (text.includes("SET payload = jsonb_set")) return { rows: [{ id: 'outbox-1' }], rowCount: 1 };
      if (text.includes("SET status = 'failed'")) { failurePayload = JSON.parse(String(params?.[3])); return { rows: [{ attempts: 1 }], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    });
    sendCalendarInvitation.mockResolvedValueOnce({ accepted: ['first@example.test'], rejected: [] }).mockRejectedValueOnce(new Error('second action unavailable'));

    const result = await deliverStoredInvitation({ outboxId: 'outbox-1' });
    expect(result).toMatchObject({ status: 'failed', lastError: 'second action unavailable' });
    expect(failurePayload).toEqual([expect.objectContaining({ method: 'REQUEST', attendees: ['second@example.test'] })]);
    expect(failurePayload).not.toEqual(expect.arrayContaining([expect.objectContaining({ method: 'CANCEL' })]));
  });

  it('uses the payload returned by the claim, not a stale caller snapshot (V3-05)', async () => {
    const current = { ...baseAction, attendees: ['remaining@example.test'] };
    query.mockImplementation(async (statement: string) => {
      const text = sql(statement);
      if (text.includes("SET status = 'processing'")) return { rows: [claimed([current])], rowCount: 1 };
      if (text.includes('FROM email_accounts')) return { rows: [account], rowCount: 1 };
      if (text.includes('SET claim_expires_at') || text.includes("SET payload = jsonb_set") || text.includes("SET status = 'sent'")) return { rows: [{ id: 'outbox-1' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    await deliverStoredInvitation({ outboxId: 'outbox-1' });
    expect(sendCalendarInvitation.mock.calls[0][0].attendees).toEqual(['remaining@example.test']);
  });

  it('does not begin SMTP after ownership has expired or been recovered (V3-06)', async () => {
    query.mockImplementation(async (statement: string) => {
      const text = sql(statement);
      if (text.includes("SET status = 'processing'")) return { rows: [claimed([baseAction])], rowCount: 1 };
      if (text.includes('FROM email_accounts')) return { rows: [account], rowCount: 1 };
      if (text.includes('SET claim_expires_at')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });

    expect(await deliverStoredInvitation({ outboxId: 'outbox-1' })).toEqual({ status: 'processing', lastError: null });
    expect(sendCalendarInvitation).not.toHaveBeenCalled();
  });

  it('keeps every pending action when one sender account is unavailable (V3-08)', async () => {
    const missing = { ...baseAction, accountId: 'missing-account', method: 'CANCEL' };
    const available = { ...baseAction, method: 'REQUEST' };
    let failurePayload: unknown;
    query.mockImplementation(async (statement: string, params?: unknown[]) => {
      const text = sql(statement);
      if (text.includes("SET status = 'processing'")) return { rows: [claimed([missing, available])], rowCount: 1 };
      if (text.includes('FROM email_accounts')) return { rows: [account], rowCount: 1 };
      if (text.includes("SET status = 'failed'")) { failurePayload = JSON.parse(String(params?.[3])); return { rows: [{ attempts: 1 }], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    });

    expect(await deliverStoredInvitation({ outboxId: 'outbox-1' })).toMatchObject({ status: 'failed', lastError: expect.stringContaining('no sender account') });
    expect(sendCalendarInvitation).not.toHaveBeenCalled();
    expect(failurePayload).toEqual([expect.objectContaining({ accountId: 'missing-account', method: 'CANCEL' }), expect.objectContaining({ method: 'REQUEST' })]);
  });
});

describe('atomic background drain', () => {
  it('claims due rows with SKIP LOCKED before SMTP', async () => {
    query.mockImplementation(async (statement: string) => {
      const text = sql(statement);
      if (text.includes('WITH candidates')) return { rows: [claimed([baseAction])], rowCount: 1 };
      if (text.includes('FROM email_accounts')) return { rows: [account], rowCount: 1 };
      if (text.includes('SET claim_expires_at') || text.includes("SET payload = jsonb_set") || text.includes("SET status = 'sent'")) return { rows: [{ id: 'outbox-1' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    expect(await drainPendingInvitations()).toEqual([{ id: 'outbox-1', status: 'sent', lastError: null }]);
    const claim = query.mock.calls.find(([statement]) => sql(statement).includes('WITH candidates'));
    expect(sql(claim?.[0])).toContain('FOR UPDATE SKIP LOCKED');
  });
});
