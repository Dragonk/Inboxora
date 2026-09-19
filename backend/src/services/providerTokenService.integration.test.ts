// Real PostgreSQL tests for OAuth grant refresh (P04, plan §6.4). The single-flight
// lease and the generation compare-and-swap are database behaviours: two workers
// must not rotate the same refresh token, and a stale write must not overwrite a
// newer grant.
//
// Run with:
//   DB_HOST=localhost DB_PORT=5432 DB_NAME=mailflow_test DB_USER=… DB_PASSWORD=… \
//     npx vitest run src/services/providerTokenService.integration.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { pool } from './db.js';
import {
  GOOGLE_GRANT_AUDIENCE,
  GOOGLE_ISSUER,
  MICROSOFT_GRANT_AUDIENCE,
  MICROSOFT_ISSUER,
  storeOAuthGrant,
  upsertProviderConnection,
  type OAuthProvider,
} from './providerAuthService.js';
import { acquireRefreshLease, getGoogleAccessToken, getMicrosoftAccessToken, readGrantForUser } from './providerTokenService.js';

const hasPg = process.env.DB_HOST && process.env.DB_NAME;
const describeOrSkip = hasPg ? describe : describe.skip;

const USER_ID = '00000000-0000-0000-0000-0000000003d1';
const CONFIG = {
  clientId: 'client-123.apps.googleusercontent.com',
  clientSecret: 'secret-value',
  redirectUri: 'https://inboxora.example/oauth/google/callback',
};
const originalKey = process.env.ENCRYPTION_KEY;

async function autocommit<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { return await fn(client); } finally { client.release(); }
}

async function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Insert a grant through the real store (so encryption is exercised), then pin its expiry. */
async function seedGrant(input: {
  subject: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  provider?: OAuthProvider;
  audience?: string;
  issuer?: string;
  scopes?: string[];
}): Promise<string> {
  const connectionId = await inTransaction(client => upsertProviderConnection(client, {
    userId: USER_ID,
    provider: input.provider ?? 'google',
    issuer: input.issuer ?? GOOGLE_ISSUER,
    subject: input.subject,
  }));
  await inTransaction(client => storeOAuthGrant(client, {
    connectionId,
    audience: input.audience ?? GOOGLE_GRANT_AUDIENCE,
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    expiresAt: input.expiresAt,
    scopes: input.scopes ?? ['openid'],
    clientIdAtIssue: 'client-1',
  }));
  await autocommit(client => client.query(
    'UPDATE oauth_grants SET expires_at = $2 WHERE connection_id = $1',
    [connectionId, input.expiresAt],
  ));
  return connectionId;
}

const okTokens = (access: string, refresh?: string) => ({
  ok: true, status: 200,
  json: async () => ({ access_token: access, ...(refresh ? { refresh_token: refresh } : {}), expires_in: 3600 }),
}) as Response;

describeOrSkip('OAuth grant refresh (PostgreSQL)', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    await autocommit(client => client.query(
      `INSERT INTO users (id, username) VALUES ($1, 'p04-token-user') ON CONFLICT (id) DO NOTHING`,
      [USER_ID],
    ));
  });

  afterAll(async () => {
    await autocommit(client => client.query('DELETE FROM users WHERE id = $1', [USER_ID]));
    if (originalKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = originalKey;
  });

  beforeEach(async () => {
    await autocommit(client => client.query('DELETE FROM provider_connections WHERE user_id = $1', [USER_ID]));
  });

  it('returns a still-valid token without contacting the provider', async () => {
    const connectionId = await seedGrant({
      subject: 'sub-valid', accessToken: 'access-valid', refreshToken: 'rt-1',
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const fetchImpl = vi.fn();
    const result = await getGoogleAccessToken({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl });
    expect(result).toMatchObject({ accessToken: 'access-valid', refreshed: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refreshes an expired token and stores it with a generation bump', async () => {
    const connectionId = await seedGrant({
      subject: 'sub-expired', accessToken: 'access-old', refreshToken: 'rt-old',
      expiresAt: new Date(Date.now() - 1000),
    });
    const fetchImpl = vi.fn().mockResolvedValue(okTokens('access-new'));
    const result = await getGoogleAccessToken({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl });
    expect(result).toMatchObject({ accessToken: 'access-new', refreshed: true, generation: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const stored = await inTransaction(client => readGrantForUser(client, { userId: USER_ID, connectionId }));
    expect(stored?.accessToken).toBe('access-new');
    // An omitted refresh token keeps the stored one.
    expect(stored?.refreshToken).toBe('rt-old');
    expect(stored?.generation).toBe(2);
  });

  it('parks a revoked grant as reauth_required and stops calling the provider', async () => {
    const connectionId = await seedGrant({
      subject: 'sub-revoked', accessToken: 'access-old', refreshToken: 'rt-revoked',
      expiresAt: new Date(Date.now() - 1000),
    });
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }),
    } as Response);

    await expect(getGoogleAccessToken({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl }))
      .rejects.toMatchObject({ code: 'invalid_grant' });
    const stored = await inTransaction(client => readGrantForUser(client, { userId: USER_ID, connectionId }));
    expect(stored?.status).toBe('reauth_required');

    // The next attempt refuses immediately, without a provider call.
    const second = vi.fn();
    await expect(getGoogleAccessToken({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: second }))
      .rejects.toMatchObject({ code: 'REAUTH_REQUIRED' });
    expect(second).not.toHaveBeenCalled();
  });

  it('reports a held refresh lease instead of starting a second refresh', async () => {
    const connectionId = await seedGrant({
      subject: 'sub-lease', accessToken: 'access-old', refreshToken: 'rt-lease',
      expiresAt: new Date(Date.now() - 1000),
    });
    const stored = await inTransaction(client => readGrantForUser(client, { userId: USER_ID, connectionId }));
    if (!stored) throw new Error('expected the seeded grant');
    const lease = await inTransaction(client => acquireRefreshLease(client, { grantId: stored.id, owner: 'other-worker' }));
    expect(lease).not.toBeNull();

    const fetchImpl = vi.fn();
    await expect(getGoogleAccessToken({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl }))
      .rejects.toMatchObject({ code: 'REFRESH_IN_PROGRESS' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refreshes a token only once when two workers race', async () => {
    const connectionId = await seedGrant({
      subject: 'sub-race', accessToken: 'access-old', refreshToken: 'rt-race',
      expiresAt: new Date(Date.now() - 1000),
    });
    const fetchImpl = vi.fn().mockImplementation(async () => okTokens('access-race'));
    const results = await Promise.allSettled([
      getGoogleAccessToken({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl }),
      getGoogleAccessToken({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl }),
    ]);
    // At most one provider call: the loser either observes the landed token or
    // reports REFRESH_IN_PROGRESS, never a second rotation.
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(1);
    expect(results.some(result => result.status === 'fulfilled')).toBe(true);

    const stored = await inTransaction(client => readGrantForUser(client, { userId: USER_ID, connectionId }));
    expect(stored?.accessToken).toBe('access-race');
    expect(stored?.refreshToken).toBe('rt-race');
  });
});

const MS_CONFIG = {
  clientId: '11111111-2222-3333-4444-555555555555',
  clientSecret: 'ms-secret',
  redirectUri: 'https://inboxora.example/oauth/microsoft/callback',
  providerRedirectUri: 'https://inboxora.example/oauth/provider/microsoft/callback',
  tenantId: 'consumers',
};

const seedMicrosoftGrant = (input: { subject: string; accessToken: string; refreshToken: string | null; expiresAt: Date }) => seedGrant({
  ...input,
  provider: 'microsoft',
  audience: MICROSOFT_GRANT_AUDIENCE,
  issuer: MICROSOFT_ISSUER,
  scopes: ['https://graph.microsoft.com/Mail.ReadWrite'],
});

describeOrSkip('Microsoft Graph grant refresh (PostgreSQL)', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    await autocommit(client => client.query(
      `INSERT INTO users (id, username) VALUES ($1, 'p07-token-user') ON CONFLICT (id) DO NOTHING`,
      [USER_ID],
    ));
  });

  afterAll(async () => {
    await autocommit(client => client.query('DELETE FROM users WHERE id = $1', [USER_ID]));
    if (originalKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = originalKey;
  });

  beforeEach(async () => {
    await autocommit(client => client.query('DELETE FROM provider_connections WHERE user_id = $1', [USER_ID]));
  });

  it('returns a still-valid Graph token without contacting the provider', async () => {
    const connectionId = await seedMicrosoftGrant({
      subject: 'ms-valid', accessToken: 'ms-access-valid', refreshToken: 'ms-rt-1',
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const fetchImpl = vi.fn();
    const result = await getMicrosoftAccessToken({ userId: USER_ID, connectionId, config: MS_CONFIG, fetchImpl });
    expect(result).toMatchObject({ accessToken: 'ms-access-valid', refreshed: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('stores Microsoft rotation: the returned refresh token replaces the stored one', async () => {
    const connectionId = await seedMicrosoftGrant({
      subject: 'ms-expired', accessToken: 'ms-access-old', refreshToken: 'ms-rt-old',
      expiresAt: new Date(Date.now() - 1000),
    });
    const fetchImpl = vi.fn().mockResolvedValue(okTokens('ms-access-new', 'ms-rt-new'));
    const result = await getMicrosoftAccessToken({ userId: USER_ID, connectionId, config: MS_CONFIG, fetchImpl });
    expect(result).toMatchObject({ accessToken: 'ms-access-new', refreshed: true, generation: 2 });

    // Microsoft rotates refresh tokens, so a returned one must win over the stored value.
    const stored = await inTransaction(client => readGrantForUser(client, {
      userId: USER_ID, connectionId, audience: MICROSOFT_GRANT_AUDIENCE,
    }));
    expect(stored?.accessToken).toBe('ms-access-new');
    expect(stored?.refreshToken).toBe('ms-rt-new');

    // The request carries the tenant-specific endpoint and the consented scope.
    const [url, init] = fetchImpl.mock.calls[0] as [string, { body: string }];
    expect(url).toBe('https://login.microsoftonline.com/consumers/oauth2/v2.0/token');
    expect(init.body).toContain('grant_type=refresh_token');
    expect(init.body).toContain('scope=https%3A%2F%2Fgraph.microsoft.com%2FMail.ReadWrite');
  });

  it('parks a revoked Microsoft grant as reauth_required', async () => {
    const connectionId = await seedMicrosoftGrant({
      subject: 'ms-revoked', accessToken: 'ms-access-old', refreshToken: 'ms-rt-dead',
      expiresAt: new Date(Date.now() - 1000),
    });
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false, status: 400,
      json: async () => ({ error: 'invalid_grant', error_description: 'AADSTS700082: The refresh token has expired.' }),
    } as Response);

    await expect(getMicrosoftAccessToken({ userId: USER_ID, connectionId, config: MS_CONFIG, fetchImpl }))
      .rejects.toMatchObject({ code: 'invalid_grant' });

    const stored = await inTransaction(client => readGrantForUser(client, {
      userId: USER_ID, connectionId, audience: MICROSOFT_GRANT_AUDIENCE,
    }));
    expect(stored?.status).toBe('reauth_required');
    // A parked grant is not retried: the next call fails fast without a provider call.
    const second = vi.fn();
    await expect(getMicrosoftAccessToken({ userId: USER_ID, connectionId, config: MS_CONFIG, fetchImpl: second }))
      .rejects.toMatchObject({ code: 'REAUTH_REQUIRED' });
    expect(second).not.toHaveBeenCalled();
  });

  it('reports a held refresh lease instead of rotating twice', async () => {
    const connectionId = await seedMicrosoftGrant({
      subject: 'ms-lease', accessToken: 'ms-access-old', refreshToken: 'ms-rt-lease',
      expiresAt: new Date(Date.now() - 1000),
    });
    const stored = await inTransaction(client => readGrantForUser(client, {
      userId: USER_ID, connectionId, audience: MICROSOFT_GRANT_AUDIENCE,
    }));
    if (!stored) throw new Error('expected the seeded grant');
    expect(await inTransaction(client => acquireRefreshLease(client, { grantId: stored.id, owner: 'other-worker' }))).not.toBeNull();

    const fetchImpl = vi.fn();
    await expect(getMicrosoftAccessToken({ userId: USER_ID, connectionId, config: MS_CONFIG, fetchImpl }))
      .rejects.toMatchObject({ code: 'REFRESH_IN_PROGRESS' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
