import { describe, expect, it, vi } from 'vitest';

const { pool, query } = vi.hoisted(() => ({
  pool: { connect: vi.fn() }, query: vi.fn(),
}));
vi.mock('./db.js', () => ({ pool, query }));
vi.mock('./conversationPersistence.js', () => ({ upsertConversationCopy: vi.fn() }));
vi.mock('./conversationProviderEnvelope.js', () => ({ providerIdentityForCopy: vi.fn(() => ({ provider: null })) }));

import { rebuildConversationCopies } from './conversationRebuild.js';

describe('conversation rebuild', () => {
  it('uses keyset checkpointing and keeps dry-run read-only for message ingest', async () => {
    const client = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'm1', date: '2026-01-01T00:00:00Z' }] })
      .mockResolvedValue({ rows: [] }), release: vi.fn() };
    pool.connect.mockResolvedValueOnce(client);
    const result = await rebuildConversationCopies({ userId: 'u1', limit: 1, dryRun: true });
    expect(result).toMatchObject({ scanned: 1, updated: 0, complete: false, dryRun: true });
    expect(client.query.mock.calls[2][0]).toContain('ORDER BY (m.date IS NULL), m.date ASC, m.id ASC');
    expect(client.query.mock.calls[2][0]).toContain('LIMIT $2');
  });
});
