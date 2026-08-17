import { describe, expect, it, vi, beforeEach } from 'vitest';

const { claim, resolve, query, upsert, providerIdentity } = vi.hoisted(() => ({
  claim: vi.fn(), resolve: vi.fn(), query: vi.fn(), upsert: vi.fn(), providerIdentity: vi.fn(() => ({ provider: 'gmail', providerThreadId: 't1', isStrong: true })),
}));
vi.mock('./conversationIngestFailures.js', () => ({ claimConversationIngestFailures: claim, resolveConversationIngestFailure: resolve }));
vi.mock('./db.js', () => ({ query }));
vi.mock('./conversationProviderEnvelope.js', () => ({ providerIdentityForCopy: providerIdentity }));
vi.mock('./conversationPersistence.js', () => ({ upsertConversationCopy: upsert }));
import { retryConversationIngestFailures } from './conversationIngestRetry.js';

describe('conversation ingest retry', () => {
  beforeEach(() => {
    claim.mockReset(); resolve.mockReset(); query.mockReset(); upsert.mockReset();
  });

  it('resolves successfully persisted failures', async () => {
    claim.mockResolvedValueOnce([{ id: 'f1', user_id: 'u1', message_row_id: 'm1' }]);
    query.mockResolvedValueOnce({ rows: [{ id: 'm1', user_id: 'u1' }] });
    upsert.mockResolvedValueOnce({ conversationId: 'c1' });
    const result = await retryConversationIngestFailures({ userId: 'u1' });
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1', user_id: 'u1' }), expect.objectContaining({ provider: expect.objectContaining({ providerThreadId: 't1' }) }));
    expect(resolve).toHaveBeenCalledWith('f1');
    expect(result).toEqual([{ id: 'f1', resolved: true }]);
  });

  it('keeps a failed item unresolved and does not expose credentials', async () => {
    claim.mockResolvedValueOnce([{ id: 'f2', user_id: 'u1', message_row_id: 'm2' }]);
    query.mockResolvedValueOnce({ rows: [] });
    const result = await retryConversationIngestFailures({ userId: 'u1' });
    expect(resolve).not.toHaveBeenCalled();
    expect(result[0]).toMatchObject({ id: 'f2', resolved: false });
    expect(result[0].error).toBe('Message row no longer exists');
  });
});
