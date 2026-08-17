import { describe, expect, it, vi } from 'vitest';

const { pool, upsertConversationCopy } = vi.hoisted(() => ({ pool: { connect: vi.fn() }, upsertConversationCopy: vi.fn() }));
vi.mock('./db.js', () => ({ pool }));
vi.mock('./conversationPersistence.js', () => ({ upsertConversationCopy }));
vi.mock('./conversationProviderEnvelope.js', () => ({ providerIdentityForCopy: vi.fn(() => ({ provider: null })) }));

import { rebuildConversationCopies } from './conversationRebuild.js';

describe('conversation rebuild', () => {
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
