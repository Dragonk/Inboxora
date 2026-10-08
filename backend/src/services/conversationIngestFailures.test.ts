import { describe, expect, it, vi } from 'vitest';

const { withTransaction } = vi.hoisted(() => ({ withTransaction: vi.fn() }));
vi.mock('./db.js', () => ({ withTransaction }));

import {
  claimConversationIngestFailures,
  recordConversationIngestFailure,
  resolveConversationIngestFailure,
  resolveConversationIngestFailuresForMessage,
} from './conversationIngestFailures.js';

describe('conversation ingest failures', () => {
  it('records message failures atomically with ON CONFLICT and exponential backoff', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    withTransaction.mockImplementationOnce(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }));
    await recordConversationIngestFailure({
      userId: 'u1', accountId: 'a1', messageRowId: 'm1', operation: 'imap-ingest',
      error: Object.assign(new Error('failed'), { code: 'E_TEST' }), diagnostics: { rawMessageId: '<m@x>' },
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (user_id, account_id, message_row_id, operation) WHERE resolved_at IS NULL AND message_row_id IS NOT NULL'),
      ['u1', 'a1', 'm1', 'imap-ingest', 'E_TEST', 'failed', JSON.stringify({ rawMessageId: '<m@x>' })],
    );
    expect(query.mock.calls[0][0]).toContain('attempts = conversation_ingest_failures.attempts + 1');
    expect(query.mock.calls[0][0]).toContain('next_attempt_at = NOW() +');
  });

  it('looks up account_id from messages when omitted before recording message failure', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ account_id: 'a-looked-up' }] })
      .mockResolvedValueOnce({ rowCount: 1 });
    withTransaction.mockImplementationOnce(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }));
    await recordConversationIngestFailure({
      userId: 'u1', messageRowId: 'm1', operation: 'imap-ingest',
      error: Object.assign(new Error('network error'), { code: 'E_NET' }), diagnostics: { retry: true },
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT account_id FROM messages WHERE id = $1'),
      ['m1'],
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (user_id, account_id, message_row_id, operation)'),
      ['u1', 'a-looked-up', 'm1', 'imap-ingest', 'E_NET', 'network error', JSON.stringify({ retry: true })],
    );
  });

  it('inserts non-message failure without conflict target', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    withTransaction.mockImplementationOnce(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }));
    await recordConversationIngestFailure({
      userId: 'u1', accountId: 'a1', operation: 'sync',
      error: new Error('general error'),
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO conversation_ingest_failures (user_id, account_id, message_row_id, operation, error_code, error_message, diagnostics)'),
      ['u1', 'a1', null, 'sync', null, 'general error', '{}'],
    );
    expect(query.mock.calls[0][0]).not.toContain('ON CONFLICT');
  });

  it('claims due failures and advances their retry time with exponential backoff while locked', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'f1', attempts: 2 }] })
      .mockResolvedValueOnce({ rows: [] });
    withTransaction.mockImplementationOnce(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }));
    const rows = await claimConversationIngestFailures({ userId: 'u1', limit: 5 });
    expect(rows).toEqual([{ id: 'f1', attempts: 2 }]);
    expect(query.mock.calls[0][0]).toContain('FOR UPDATE SKIP LOCKED');
    expect(query.mock.calls[1][0]).toContain('attempts = attempts + 1');
    expect(query.mock.calls[1][1]).toEqual([20, 'f1']);
  });

  it('resolves a failure by id', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    withTransaction.mockImplementationOnce(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }));
    await resolveConversationIngestFailure('f1');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('resolved_at = NOW()'), ['f1']);
  });

  it('resolves all active failures for a message row', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 2 });
    await resolveConversationIngestFailuresForMessage({ query }, { userId: 'u1', messageRowId: 'm1' });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE conversation_ingest_failures SET resolved_at = NOW()'),
      ['u1', 'm1'],
    );
  });
});
