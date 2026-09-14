import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('./db.js', () => ({ query }));

import { authenticateDavCredential } from './davCredentials.js';

const token = 'mf_dav_123e4567-e89b-12d3-a456-426614174000.exampleSecret-123456';

describe('DAV credential authentication', () => {
  beforeEach(() => query.mockReset());

  it('accepts a valid, active DAV app password for a TOTP-enabled account', async () => {
    const bcrypt = (await import('bcryptjs')).default;
    const secretHash = await bcrypt.hash('exampleSecret-123456', 4);
    query
      .mockResolvedValueOnce({ rows: [{ id: 'user-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'credential-1', secret_hash: secretHash }] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(authenticateDavCredential('sam@example.test', token)).resolves.toEqual({
      userId: 'user-1',
      credentialId: 'credential-1',
    });
    expect(query.mock.calls[0][0]).toContain('FROM users');
    expect(query.mock.calls[1][0]).toContain('FROM dav_app_passwords');
    expect(query.mock.calls[2][0]).toContain('last_used_at');
  });

  it('rejects a primary account password even when the account does not use TOTP', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'user-1' }] });

    await expect(authenticateDavCredential('sam@example.test', 'primary-account-password')).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('rejects a revoked or unknown DAV credential without returning a user', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'user-1' }] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(authenticateDavCredential('sam@example.test', token)).resolves.toBeNull();
  });
});
