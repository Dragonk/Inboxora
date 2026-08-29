import { describe, expect, it, vi } from 'vitest';

const { withTransaction } = vi.hoisted(() => ({ withTransaction: vi.fn() }));
vi.mock('./db.js', () => ({ withTransaction }));

import { claimConversationIngestFailures, recordConversationIngestFailure, resolveConversationIngestFailure } from './conversationIngestFailures.js';

describe('conversation ingest failures', () => {
  it('records failures with bounded diagnostic data through a transaction', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    withTransaction.mockImplementationOnce(async fn => fn({ query }));
    await recordConversationIngestFailure({
      userId: 'u1', accountId: 'a1', messageRowId: 'm1', operation: 'imap-ingest',
      error: Object.assign(new Error('failed'), { code: 'E_TEST' }), diagnostics: { rawMessageId: '<m@x>' },
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO conversation_ingest_failures'), expect.arrayContaining(['u1', 'a1', 'm1', 'imap-ingest', 'E_TEST', 'failed']));
  });

  it('claims due failures and advances their retry time while locked', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'f1' }] })
      .mockResolvedValueOnce({ rows: [] });
    withTransaction.mockImplementationOnce(async fn => fn({ query }));
    const rows = await claimConversationIngestFailures({ userId: 'u1', limit: 5 });
    expect(rows).toEqual([{ id: 'f1' }]);
    expect(query.mock.calls[0][0]).toContain('FOR UPDATE SKIP LOCKED');
    expect(query.mock.calls[1][0]).toContain('attempts = attempts + 1');
  });

  it('resolves a failure by id', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    withTransaction.mockImplementationOnce(async fn => fn({ query }));
    await resolveConversationIngestFailure('f1');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('resolved_at = NOW()'), ['f1']);
  });
});
