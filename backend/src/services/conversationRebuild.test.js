import { describe, expect, it, vi } from 'vitest';

const { pool, upsertConversationCopy } = vi.hoisted(() => ({ pool: { connect: vi.fn() }, upsertConversationCopy: vi.fn() }));
vi.mock('./db.js', () => ({ pool }));
vi.mock('./conversationPersistence.js', () => ({ upsertConversationCopy }));
vi.mock('./conversationProviderEnvelope.js', () => ({ providerIdentityForCopy: vi.fn(() => ({ provider: null })) }));

import { rebuildConversationCopies } from './conversationRebuild.js';

describe('conversation rebuild', () => {
  it('uses a supplied cursor for the next dry-run batch and reports wouldChange', async () => {
    const client = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'm2', date: '2026-01-02T00:00:00Z', conversation_id: null, logical_message_id: null, threading_algorithm_version: null }] })
      .mockResolvedValue({ rows: [] }), release: vi.fn() };
    pool.connect.mockResolvedValueOnce(client);
    const result = await rebuildConversationCopies({ userId: 'u1', limit: 2, dryRun: true, cursor: { date: '2026-01-01T00:00:00Z', id: 'm1', isNull: false } });
    expect(result.scanned).toBe(1);
    expect(result.wouldChange).toBe(1);
    expect(result.complete).toBe(true);
  });

  it('allows an explicit forced repair after a completed checkpoint', async () => {
    const client = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ status: 'complete' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValue({ rows: [] }), release: vi.fn() };
    pool.connect.mockResolvedValueOnce(client);
    await expect(rebuildConversationCopies({ userId: 'u1', limit: 1, dryRun: false, force: true })).resolves.toMatchObject({ scanned: 0, updated: 0, complete: true, dryRun: false });
    expect(upsertConversationCopy).not.toHaveBeenCalled();
  });
});
