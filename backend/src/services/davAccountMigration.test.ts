import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn(), clientQuery: vi.fn() }));
vi.mock('./db.js', () => ({ query: mocks.query, withTransaction: mocks.transaction }));
import { migrateAllDavAccounts } from './davAccountMigration.js';

describe('startup DAV migration isolation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.clientQuery.mockResolvedValue({ rows: [] });
    mocks.transaction.mockImplementation(async (callback: (client: { query: typeof mocks.clientQuery }) => Promise<void>) => callback({ query: mocks.clientQuery }));
  });
  it('logs a failed user transaction and still migrates subsequent users', async () => {
    mocks.query.mockResolvedValue({ rows: [{ user_id: 'broken-user' }, { user_id: 'good-user' }] });
    mocks.transaction.mockRejectedValueOnce(new Error('transaction failed'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(migrateAllDavAccounts()).resolves.toBeUndefined();
      expect(mocks.transaction).toHaveBeenCalledTimes(2);
      expect(log).toHaveBeenCalledWith('DAV account migration failed for user broken-user:', 'transaction failed');
      expect(mocks.clientQuery).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_xact_lock'), ['dav-accounts:good-user']);
    } finally { log.mockRestore(); }
  });
  it('does not hide a global database failure before users can be listed', async () => {
    mocks.query.mockRejectedValue(new Error('database unavailable'));
    await expect(migrateAllDavAccounts()).rejects.toThrow('database unavailable');
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
