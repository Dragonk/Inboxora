import { describe, expect, it, vi } from 'vitest';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('./db.js', () => ({ query }));
vi.mock('./conversationPersistence.js', () => ({ upsertConversationCopy: vi.fn() }));
vi.mock('./conversationProviderEnvelope.js', () => ({ providerIdentityForCopy: vi.fn(() => ({ provider: null })) }));

import { rebuildConversationCopies } from './conversationRebuild.js';

describe('conversation rebuild', () => {
  it('uses keyset checkpointing and keeps dry-run read-only for message ingest', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    query.mockResolvedValueOnce({ rows: [{ id: 'm1', date: '2026-01-01T00:00:00Z' }] });
    query.mockResolvedValueOnce({ rows: [] });
    const result = await rebuildConversationCopies({ userId: 'u1', limit: 1, dryRun: true });
    expect(result).toMatchObject({ scanned: 1, updated: 0, complete: false, dryRun: true });
    expect(query.mock.calls[1][0]).toContain('ORDER BY m.date ASC NULLS LAST, m.id ASC');
    expect(query.mock.calls[1][0]).toContain('LIMIT $2');
  });
});
