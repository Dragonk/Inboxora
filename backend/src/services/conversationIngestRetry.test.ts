import { describe, expect, it, vi, beforeEach } from 'vitest';

type ClaimedFailure = {
  id: string;
  user_id: string;
  message_row_id: string;
};

type MessageRow = {
  id: string;
  user_id: string;
  account_id: string;
};

type TransactionClient = {
  query: (text: string, params: string[]) => Promise<{ rows: MessageRow[] }>;
};

type ProviderIdentity = {
  provider: string;
  providerThreadId: string;
  isStrong: boolean;
};

type PersistResult = { conversationId: string };

type RetryMocks = {
  claim: (options: { userId?: string | null; limit?: number }) => Promise<ClaimedFailure[]>;
  resolve: (id: string) => Promise<void>;
  withTransaction: <T>(
    callback: (client: TransactionClient) => Promise<T>,
    options: { serializable: boolean },
  ) => Promise<T>;
  _upsertWithClient: (
    client: TransactionClient,
    message: MessageRow,
    options: { identities: string[]; provider: ProviderIdentity; userId: string },
  ) => Promise<PersistResult>;
  resolveOwnIdentity: (client: TransactionClient, accountId: string, message: MessageRow) => Promise<string[]>;
  providerIdentity: (message: MessageRow, copy: MessageRow) => ProviderIdentity;
};

const { claim, resolve, withTransaction, _upsertWithClient, resolveOwnIdentity, providerIdentity } = vi.hoisted<{
  [Key in keyof RetryMocks]: ReturnType<typeof vi.fn<RetryMocks[Key]>>;
}>(() => ({
  claim: vi.fn<RetryMocks['claim']>(),
  resolve: vi.fn<RetryMocks['resolve']>(),
  withTransaction: vi.fn<RetryMocks['withTransaction']>(),
  _upsertWithClient: vi.fn<RetryMocks['_upsertWithClient']>(),
  resolveOwnIdentity: vi.fn<RetryMocks['resolveOwnIdentity']>(),
  providerIdentity: vi.fn<RetryMocks['providerIdentity']>(),
}));
vi.mock('./conversationIngestFailures.js', () => ({ claimConversationIngestFailures: claim, resolveConversationIngestFailure: resolve }));
vi.mock('./db.js', () => ({ withTransaction }));
vi.mock('./conversationIngestEnvelope.js', () => ({ resolveOwnIdentityAddresses: resolveOwnIdentity }));
vi.mock('./conversationProviderEnvelope.js', () => ({ providerIdentityForCopy: providerIdentity }));
vi.mock('./conversationPersistence.js', () => ({ _upsertConversationCopyWithClient: _upsertWithClient }));
import { retryConversationIngestFailures } from './conversationIngestRetry.js';

describe('conversation ingest retry', () => {
  beforeEach(() => {
    claim.mockReset(); resolve.mockReset(); withTransaction.mockReset();
    _upsertWithClient.mockReset(); resolveOwnIdentity.mockReset();
    resolveOwnIdentity.mockResolvedValue([]);
    providerIdentity.mockImplementation(() => ({ provider: 'gmail', providerThreadId: 't1', isStrong: true }));
  });

  it('resolves successfully persisted failures using a single transaction client', async () => {
    claim.mockResolvedValueOnce([{ id: 'f1', user_id: 'u1', message_row_id: 'm1' }]);
    const client: TransactionClient = {
      query: vi.fn<TransactionClient['query']>().mockResolvedValueOnce({ rows: [{ id: 'm1', user_id: 'u1', account_id: 'a1' }] }),
    };
    withTransaction.mockImplementationOnce(callback => callback(client));
    _upsertWithClient.mockResolvedValueOnce({ conversationId: 'c1' });
    const result = await retryConversationIngestFailures({ userId: 'u1' });
    // The message row SELECT must use the transaction client (FOR UPDATE)
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('FOR UPDATE'),
      ['m1', 'u1'],
    );
    // Identity resolution must use the same client
    expect(resolveOwnIdentity).toHaveBeenCalledWith(client, 'a1', expect.objectContaining({ id: 'm1' }));
    // Persistence must use _upsertConversationCopyWithClient with the same client
    expect(_upsertWithClient).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ id: 'm1', user_id: 'u1' }),
      expect.objectContaining({
        identities: [],
        provider: expect.objectContaining({ providerThreadId: 't1' }),
        userId: 'u1',
      }),
    );
    expect(resolve).toHaveBeenCalledWith('f1');
    expect(result).toEqual([{ id: 'f1', resolved: true, conversationId: 'c1' }]);
  });

  it('keeps a failed item unresolved and does not expose credentials', async () => {
    claim.mockResolvedValueOnce([{ id: 'f2', user_id: 'u1', message_row_id: 'm2' }]);
    const client: TransactionClient = {
      query: vi.fn<TransactionClient['query']>().mockResolvedValueOnce({ rows: [] }),
    };
    withTransaction.mockImplementationOnce(callback => callback(client));
    const result = await retryConversationIngestFailures({ userId: 'u1' });
    expect(_upsertWithClient).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(result[0]).toMatchObject({ id: 'f2', resolved: false });
    expect(result[0].error).toBe('Message row no longer exists');
  });

  it('passes userId from the failure record to _upsertConversationCopyWithClient', async () => {
    claim.mockResolvedValueOnce([{ id: 'f3', user_id: 'u2', message_row_id: 'm3' }]);
    const client: TransactionClient = {
      query: vi.fn<TransactionClient['query']>().mockResolvedValueOnce({ rows: [{ id: 'm3', user_id: 'u2', account_id: 'a2' }] }),
    };
    withTransaction.mockImplementationOnce(callback => callback(client));
    _upsertWithClient.mockResolvedValueOnce({ conversationId: 'c3' });
    await retryConversationIngestFailures({ userId: 'u2' });
    expect(_upsertWithClient).toHaveBeenCalledWith(
      client,
      { id: 'm3', user_id: 'u2', account_id: 'a2' },
      expect.objectContaining({ userId: 'u2' }),
    );
  });
});
