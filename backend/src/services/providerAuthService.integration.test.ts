// Real PostgreSQL tests for the OAuth flow store, connection identity and grant
// storage. These are the invariants a mocked database cannot prove: single-use is
// enforced by one conditional UPDATE, refresh-token preservation is a SQL COALESCE,
// and connection identity is a partial unique index on issuer + subject.
//
// Run with:
//   DB_HOST=localhost DB_PORT=5432 DB_NAME=mailflow_test DB_USER=… DB_PASSWORD=… \
//     npx vitest run src/services/providerAuthService.integration.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import crypto from 'crypto';
import { pool } from './db.js';
import { decrypt } from './encryption.js';
import {
  GOOGLE_GRANT_AUDIENCE,
  GOOGLE_ISSUER,
  createAuthorizationFlow,
  finishAuthorizationFlow,
  storeOAuthGrant,
  takeAuthorizationFlow,
  upsertProviderConnection,
} from './providerAuthService.js';

const hasPg = process.env.DB_HOST && process.env.DB_NAME;
const describeOrSkip = hasPg ? describe : describe.skip;

const USER_ID = '00000000-0000-0000-0000-0000000003c1';
const originalKey = process.env.ENCRYPTION_KEY;

async function autocommit<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
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

describeOrSkip('OAuth authorization flows (PostgreSQL)', () => {
  beforeAll(async () => {
    // A real key so the grant/verifier encryption path is exercised, not bypassed.
    process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    await autocommit(client => client.query(
      `INSERT INTO users (id, username) VALUES ($1, 'p04-integration-user') ON CONFLICT (id) DO NOTHING`,
      [USER_ID],
    ));
  });

  afterAll(async () => {
    await autocommit(client => client.query('DELETE FROM users WHERE id = $1', [USER_ID]));
    if (originalKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = originalKey;
  });

  beforeEach(async () => {
    await autocommit(async client => {
      await client.query('DELETE FROM provider_connections WHERE user_id = $1', [USER_ID]);
      await client.query('DELETE FROM oauth_authorization_flows WHERE user_id = $1', [USER_ID]);
    });
  });

  it('consumes a flow exactly once and stores only a hash of the state', async () => {
    const created = await inTransaction(client => createAuthorizationFlow(client, {
      userId: USER_ID, provider: 'google', purpose: 'new_account',
      scopes: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.modify'],
      configRevision: 'rev-1',
    }));
    expect(created.state).toMatch(/^[A-Za-z0-9_-]{20,}$/);

    const stored = await autocommit(client => client.query<{ state_hash: string; code_verifier_enc: string | null }>(
      'SELECT state_hash, code_verifier_enc FROM oauth_authorization_flows WHERE id = $1',
      [created.flowId],
    ));
    expect(stored.rows[0]?.state_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.rows[0]?.state_hash).not.toBe(created.state);
    // The PKCE verifier is encrypted with the configured key.
    expect(stored.rows[0]?.code_verifier_enc).toMatch(/^enc:v1:/);

    const taken = await inTransaction(client => takeAuthorizationFlow(client, { state: created.state, provider: 'google' }));
    expect(taken).toMatchObject({ userId: USER_ID, purpose: 'new_account', configRevision: 'rev-1' });
    expect(taken?.codeVerifier).toBeTruthy();

    // A replayed callback finds nothing: the first take moved it out of `pending`.
    const replay = await inTransaction(client => takeAuthorizationFlow(client, { state: created.state, provider: 'google' }));
    expect(replay).toBeNull();

    expect(await inTransaction(client => finishAuthorizationFlow(client, { flowId: created.flowId, status: 'completed' }))).toBe(true);
    const after = await autocommit(client => client.query<{ status: string }>(
      'SELECT status FROM oauth_authorization_flows WHERE id = $1', [created.flowId],
    ));
    expect(after.rows[0]?.status).toBe('completed');
  });

  it('scopes a flow to its provider, so a Google state cannot start a Microsoft flow', async () => {
    const microsoftFlow = await inTransaction(client => createAuthorizationFlow(client, {
      userId: USER_ID, provider: 'microsoft', purpose: 'calendar_enable',
      scopes: ['openid', 'offline_access', 'https://graph.microsoft.com/Calendars.ReadWrite'],
      configRevision: 'rev-ms',
    }));
    const googleFlow = await inTransaction(client => createAuthorizationFlow(client, {
      userId: USER_ID, provider: 'google', purpose: 'new_account',
      scopes: ['openid', 'email'],
      configRevision: 'rev-g',
    }));

    // The wrong provider must neither consume nor reveal the flow.
    expect(await inTransaction(client => takeAuthorizationFlow(client, { state: googleFlow.state, provider: 'microsoft' }))).toBeNull();
    expect(await inTransaction(client => takeAuthorizationFlow(client, { state: microsoftFlow.state, provider: 'google' }))).toBeNull();

    const taken = await inTransaction(client => takeAuthorizationFlow(client, { state: microsoftFlow.state, provider: 'microsoft' }));
    expect(taken).toMatchObject({ userId: USER_ID, provider: 'microsoft', purpose: 'calendar_enable', configRevision: 'rev-ms' });
    expect(taken?.requestedScopes).toContain('https://graph.microsoft.com/Calendars.ReadWrite');
    // The provider-mismatch attempts above must not have consumed it.
    expect(await inTransaction(client => takeAuthorizationFlow(client, { state: microsoftFlow.state, provider: 'microsoft' }))).toBeNull();
  });

  it('refuses an expired flow', async () => {
    const created = await inTransaction(client => createAuthorizationFlow(client, {
      userId: USER_ID, provider: 'google', purpose: 'contacts_enable', scopes: ['openid'], ttlSeconds: 60,
    }));
    await autocommit(client => client.query(
      `UPDATE oauth_authorization_flows SET expires_at = NOW() - interval '1 second' WHERE id = $1`,
      [created.flowId],
    ));
    expect(await inTransaction(client => takeAuthorizationFlow(client, { state: created.state, provider: 'google' }))).toBeNull();
  });

  it('keeps one connection per verified issuer + subject', async () => {
    const first = await inTransaction(client => upsertProviderConnection(client, {
      userId: USER_ID, provider: 'google', issuer: GOOGLE_ISSUER, subject: 'sub-1', providerUserId: 'old@example.test',
    }));
    // The address changed, the subject did not: same connection.
    const second = await inTransaction(client => upsertProviderConnection(client, {
      userId: USER_ID, provider: 'google', issuer: GOOGLE_ISSUER, subject: 'sub-1', providerUserId: 'new@example.test',
    }));
    expect(second).toBe(first);

    const other = await inTransaction(client => upsertProviderConnection(client, {
      userId: USER_ID, provider: 'google', issuer: GOOGLE_ISSUER, subject: 'sub-2',
    }));
    expect(other).not.toBe(first);

    const rows = await autocommit(client => client.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM provider_connections WHERE user_id = $1', [USER_ID],
    ));
    expect(rows.rows[0]?.count).toBe('2');
  });

  it('stores grants encrypted and never erases a refresh token with a null update', async () => {
    const connectionId = await inTransaction(client => upsertProviderConnection(client, {
      userId: USER_ID, provider: 'google', issuer: GOOGLE_ISSUER, subject: 'sub-grant',
    }));

    const first = await inTransaction(client => storeOAuthGrant(client, {
      connectionId, audience: GOOGLE_GRANT_AUDIENCE, accessToken: 'access-1', refreshToken: 'refresh-1',
      expiresAt: new Date(Date.now() + 3600_000), scopes: ['openid'], clientIdAtIssue: 'client-1',
    }));
    expect(first.generation).toBe(1);

    const stored = await autocommit(client => client.query<{ access_token_encrypted: string; refresh_token_encrypted: string }>(
      'SELECT access_token_encrypted, refresh_token_encrypted FROM oauth_grants WHERE connection_id = $1',
      [connectionId],
    ));
    expect(stored.rows[0]?.access_token_encrypted).toMatch(/^enc:v1:/);
    expect(stored.rows[0]?.access_token_encrypted).not.toContain('access-1');
    expect(decrypt(stored.rows[0]?.refresh_token_encrypted ?? null)).toBe('refresh-1');

    // A refresh response that omits the refresh token must keep the stored one.
    const second = await inTransaction(client => storeOAuthGrant(client, {
      connectionId, audience: GOOGLE_GRANT_AUDIENCE, accessToken: 'access-2', refreshToken: null,
      expiresAt: new Date(Date.now() + 7200_000), scopes: ['openid'], clientIdAtIssue: 'client-1',
    }));
    expect(second.generation).toBe(2);
    const after = await autocommit(client => client.query<{ access_token_encrypted: string; refresh_token_encrypted: string }>(
      'SELECT access_token_encrypted, refresh_token_encrypted FROM oauth_grants WHERE connection_id = $1',
      [connectionId],
    ));
    expect(decrypt(after.rows[0]?.access_token_encrypted ?? null)).toBe('access-2');
    expect(decrypt(after.rows[0]?.refresh_token_encrypted ?? null)).toBe('refresh-1');
  });
});
