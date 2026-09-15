import { beforeEach, describe, expect, it, vi } from 'vitest';

type Query = typeof import('./db.js').query;

const { query } = vi.hoisted(() => ({ query: vi.fn<Query>() }));
vi.mock('./db.js', () => ({ query }));

function queryCall(index: number): [string, unknown[]] {
  const call = query.mock.calls[index];
  if (!call) throw new Error(`Expected query call ${index}`);
  const [sql, params] = call;
  if (!params) throw new Error(`Expected parameters for query call ${index}`);
  return [sql, params];
}

import {
  createDavAppPassword,
  listDavAppPasswords,
  parseDavAppPassword,
  revokeDavAppPassword,
  verifyDavAppPassword,
} from './davAppPasswords.js';

describe('DAV application passwords', () => {
  beforeEach(() => query.mockReset());

  it('creates a one-time secret while persisting only a bcrypt hash and safe prefix', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'password-id', label: 'DAVx5 phone', created_at: '2026-08-30T00:00:00.000Z' }] });

    const created = await createDavAppPassword('user-1', 'DAVx5 phone');

    expect(created).toMatchObject({ id: 'password-id', label: 'DAVx5 phone' });
    expect(created.secret).toMatch(/^mf_dav_[a-f0-9-]+\.[A-Za-z0-9_-]+$/);
    const [sql, params] = queryCall(0);
    expect(sql).toContain('INSERT INTO dav_app_passwords');
    expect(params[2]).toMatch(/^mf_dav_[a-f0-9-]+$/);
    expect(params[3]).toMatch(/^\$2[aby]\$/);
    expect(params[3]).not.toContain(created.secret);
  });

  it('parses only the supported token shape', () => {
    expect(parseDavAppPassword('mf_dav_123e4567-e89b-12d3-a456-426614174000.abc_DEF-1234567890'))
      .toEqual({ prefix: 'mf_dav_123e4567-e89b-12d3-a456-426614174000', secret: 'abc_DEF-1234567890' });
    expect(parseDavAppPassword('not-a-dav-password')).toBeNull();
  });

  it('authenticates an active app password and records its use', async () => {
    const secret = 'mf_dav_123e4567-e89b-12d3-a456-426614174000.exampleSecret-123456';
    const created = await import('bcryptjs').then(({ default: bcrypt }) => bcrypt.hash('exampleSecret-123456', 4));
    query.mockResolvedValueOnce({ rows: [{ id: 'p1', user_id: 'user-1', secret_hash: created }] });
    query.mockResolvedValueOnce({ rows: [] });

    await expect(verifyDavAppPassword('user-1', secret)).resolves.toBe(true);
    expect(queryCall(1)[0]).toContain('last_used_at');
  });

  it('lists credential metadata without selecting or returning hashes or secrets', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'p1', label: 'DAVx5 phone', created_at: '2026-08-30T00:00:00.000Z', last_used_at: null }] });

    await expect(listDavAppPasswords('user-1')).resolves.toEqual([
      { id: 'p1', label: 'DAVx5 phone', created_at: '2026-08-30T00:00:00.000Z', last_used_at: null },
    ]);
    const [sql] = queryCall(0);
    expect(sql).not.toContain('secret_hash');
    expect(sql).not.toContain('token_prefix');
  });

  it('revokes only the current user credential', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'p1', revoked_at: '2026-08-30T00:00:00.000Z' }] });

    await expect(revokeDavAppPassword('user-1', 'p1')).resolves.toEqual({ id: 'p1', revoked_at: '2026-08-30T00:00:00.000Z' });
    const [sql, params] = queryCall(0);
    expect(sql).toContain('revoked_at = NOW()');
    expect(params).toEqual(['p1', 'user-1']);
  });
});
