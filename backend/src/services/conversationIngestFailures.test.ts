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
  it('records new failures with bounded diagnostic data when no active failure exists', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    withTransaction.mockImplementationOnce(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }));
    await recordConversationIngestFailure({
      userId: 'u1', accountId: 'a1', messageRowId: 'm1', operation: 'imap-ingest',
      error: Object.assign(new Error('failed'), { code: 'E_TEST' }), diagnostics: { rawMessageId: '<m@x>' },
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('SELECT id, attempts FROM conversation_ingest_failures'), ['u1', 'a1', 'm1', 'imap-ingest']);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO conversation_ingest_failures'), expect.arrayContaining(['u1', 'a1', 'm1', 'imap-ingest', 'E_TEST', 'failed']));
  });

  it('deduplicates active failures and applies exponential backoff instead of inserting duplicates', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'existing-f1', attempts: 3 }] })
      .mockResolvedValueOnce({ rowCount: 1 });
    withTransaction.mockImplementationOnce(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }));
    await recordConversationIngestFailure({
      userId: 'u1', accountId: 'a1', messageRowId: 'm1', operation: 'imap-ingest',
      error: Object.assign(new Error('network error'), { code: 'E_NET' }), diagnostics: { retry: true },
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('SELECT id, attempts FROM conversation_ingest_failures'), ['u1', 'a1', 'm1', 'imap-ingest']);
    expect(query).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO conversation_ingest_failures'), expect.anything());
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE conversation_ingest_failures'),
      ['E_NET', 'network error', JSON.stringify({ retry: true }), 40, 'existing-f1'],
    );
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
