import { describe, expect, it, vi, beforeEach } from 'vitest';

const { pool, upsertConversationCopy } = vi.hoisted(() => ({
  pool: { connect: vi.fn() },
  upsertConversationCopy: vi.fn(),
}));
vi.mock('./db.js', () => ({ pool }));
vi.mock('./conversationPersistence.js', () => ({ upsertConversationCopy }));
vi.mock('./conversationIngestEnvelope.js', () => ({
  resolveOwnIdentityAddresses: vi.fn().mockResolvedValue([]),
}));
vi.mock('./conversationProviderEnvelope.js', () => ({
  providerIdentityForCopy: vi.fn(() => ({ provider: null })),
}));

import { rebuildConversationCopies } from './conversationRebuild.js';

describe('conversation rebuild', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it('uses a supplied cursor for the next dry-run batch and reports wouldChange when upsert changes CE state', async () => {
    // The faithful dry-run runs upsertConversationCopy inside a BEGIN/ROLLBACK.
    // The mock client simulates: advisory lock, checkpoint lookup, message query,
    // then the BEGIN, snapshot-before, upsert (mocked), snapshot-after (changed),
    // ROLLBACK, and final advisory unlock.
    const messageRow = {
      id: 'm2', date: '2026-01-02T00:00:00Z', account_id: 'a1',
      conversation_id: 'old-conv', logical_message_id: 'old-lm',
      canonical_message_id: '<m2@x>', threading_algorithm_version: 'conversation-v2',
    };
    const client = {
      query: vi.fn()
        // advisory lock
        .mockResolvedValueOnce({ rows: [] })
        // checkpoint lookup (no checkpoint)
        .mockResolvedValueOnce({ rows: [] })
        // message query (1 row)
        .mockResolvedValueOnce({ rows: [messageRow] })
        // BEGIN for dry-run
        .mockResolvedValueOnce({ rows: [] })
        // snapshot before (has old CE values)
        .mockResolvedValueOnce({ rows: [{ conversation_id: 'old-conv', logical_message_id: 'old-lm', canonical_message_id: '<m2@x>', provider_message_id: null, provider_thread_id: null, threading_reason: 'old', threading_confidence: 0.5, threading_algorithm_version: 'conversation-v2' }] })
        // upsertConversationCopy is mocked — does not touch the client
        // snapshot after (upsert would change conversation_id)
        .mockResolvedValueOnce({ rows: [{ conversation_id: 'new-conv', logical_message_id: 'new-lm', canonical_message_id: '<m2@x>', provider_message_id: null, provider_thread_id: null, threading_reason: 'rfc-in-reply-to', threading_confidence: 0.99, threading_algorithm_version: 'conversation-v2' }] })
        // ROLLBACK
        .mockResolvedValueOnce({ rows: [] })
        // advisory unlock (in finally)
        .mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    };
    pool.connect.mockResolvedValueOnce(client);
    const result = await rebuildConversationCopies({
      userId: 'u1', limit: 2, dryRun: true,
      cursor: { date: '2026-01-01T00:00:00Z', id: 'm1', isNull: false },
    });
    expect(result.scanned).toBe(1);
    // wouldChange=1 because snapshot before ≠ snapshot after (conversation_id changed)
    expect(result.wouldChange).toBe(1);
    expect(result.complete).toBe(true);
    expect(upsertConversationCopy).toHaveBeenCalled();
  });

  it('reports wouldChange=0 when the CE state does not change after upsert', async () => {
    const messageRow = {
      id: 'm3', date: '2026-01-03T00:00:00Z', account_id: 'a1',
      conversation_id: 'conv-1', logical_message_id: 'lm-1',
      threading_algorithm_version: 'conversation-v2',
    };
    const snapshot = { conversation_id: 'conv-1', logical_message_id: 'lm-1', canonical_message_id: '<m3@x>', provider_message_id: null, provider_thread_id: null, threading_reason: 'rfc-in-reply-to', threading_confidence: 0.99, threading_algorithm_version: 'conversation-v2' };
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] }) // advisory lock
        .mockResolvedValueOnce({ rows: [] }) // checkpoint
        .mockResolvedValueOnce({ rows: [messageRow] }) // message query
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [snapshot] }) // snapshot before
        .mockResolvedValueOnce({ rows: [snapshot] }) // snapshot after (unchanged)
        .mockResolvedValueOnce({ rows: [] }) // ROLLBACK
        .mockResolvedValue({ rows: [] }), // advisory unlock
      release: vi.fn(),
    };
    pool.connect.mockResolvedValueOnce(client);
    const result = await rebuildConversationCopies({ userId: 'u1', limit: 2, dryRun: true });
    expect(result.wouldChange).toBe(0);
  });

  it('allows an explicit forced repair after a completed checkpoint', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] }) // advisory lock
        .mockResolvedValueOnce({ rows: [{ status: 'complete' }] }) // checkpoint
        .mockResolvedValueOnce({ rows: [] }) // message query (empty)
        .mockResolvedValue({ rows: [] }), // checkpoint write, advisory unlock
      release: vi.fn(),
    };
    pool.connect.mockResolvedValueOnce(client);
    await expect(rebuildConversationCopies({ userId: 'u1', limit: 1, dryRun: false, force: true })).resolves.toMatchObject({ scanned: 0, updated: 0, complete: true, dryRun: false });
    expect(upsertConversationCopy).not.toHaveBeenCalled();
  });
});
