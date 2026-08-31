import { describe, expect, it, vi } from 'vitest';

import { ensureUserDavResources } from './userDavResources.js';

describe('ensureUserDavResources', () => {
  it('idempotently provisions Personal Contacts and Personal Calendar for one user', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await ensureUserDavResources({ query }, 'user-123');

    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining('INSERT INTO address_books'), ['user-123']);
    expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining('INSERT INTO calendars'), ['user-123']);
    expect(query.mock.calls[0][0]).toContain("'Personal'");
    expect(query.mock.calls[1][0]).toContain("'Personal'");
    expect(query.mock.calls[1][0]).toContain("'local'");
  });

  it('rejects an empty user id without issuing SQL', async () => {
    const query = vi.fn();

    await expect(ensureUserDavResources({ query }, '')).rejects.toThrow('User id is required');
    expect(query).not.toHaveBeenCalled();
  });
});
