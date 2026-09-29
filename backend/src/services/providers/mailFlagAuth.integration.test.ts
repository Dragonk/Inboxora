import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pool, withTransaction } from '../db.js';
import {
  GOOGLE_GRANT_AUDIENCE, GOOGLE_ISSUER, MICROSOFT_GRANT_AUDIENCE, MICROSOFT_ISSUER,
  ProviderAuthError, storeOAuthGrant, upsertProviderConnection,
} from '../providerAuthService.js';
import type { FetchLike } from '../providerAuthService.js';
import { acquireRefreshLease } from '../providerTokenService.js';
import { graphPatch } from './microsoft/graphApiClient.js';
import { drainGraphMailFlagOperations, graphFlagMutationAdapter } from './microsoft/graphMailMutations.js';
import { gmailFlagMutationAdapter, gmailModifyMessageLabels } from './google/gmailMailMutations.js';

const USER = '00000000-0000-0000-0000-0000000156a1';
const CONFIG = {
  clientId: 'synthetic-client', clientSecret: 'synthetic-secret', tenantId: 'common',
  redirectUri: 'https://synthetic.test/callback', providerRedirectUri: 'https://synthetic.test/callback',
};
const originalKey = process.env.ENCRYPTION_KEY;
const payload = { providerMessageId: 'synthetic-message', flag: '\\Seen', value: true, intentAt: '2026-09-29T00:00:00Z' };
const context = () => ({ operationId: 'synthetic-op', signal: new AbortController().signal });
const suite = process.env.DB_HOST && process.env.DB_NAME ? describe : describe.skip;

suite('mail flag token dispatch boundary (real PostgreSQL, simulated HTTP)', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
    await pool.query('INSERT INTO users (id, username) VALUES ($1, $2)', [USER, 'mail-flag-auth-synthetic']);
  });
  beforeEach(async () => {
    await pool.query('DELETE FROM provider_operations WHERE user_id = $1', [USER]);
    await pool.query('DELETE FROM email_accounts WHERE user_id = $1', [USER]);
    await pool.query('DELETE FROM provider_connections WHERE user_id = $1', [USER]);
  });
  afterAll(async () => {
    await pool.query('DELETE FROM users WHERE id = $1', [USER]);
    if (originalKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = originalKey;
  });

  it('does not replay legacy journal intents without a latest-intent fence', async () => {
    const connectionId = await withTransaction(client => upsertProviderConnection(client, {
      userId: USER, provider: 'microsoft', issuer: MICROSOFT_ISSUER, subject: 'synthetic-legacy',
    }));
    const accountId = '00000000-0000-0000-0000-0000000156a2';
    await pool.query(
      `INSERT INTO email_accounts (id, user_id, name, email_address, protocol, mail_transport, provider_connection_id)
       VALUES ($1, $2, 'Synthetic legacy', 'synthetic@example.test', 'imap', 'microsoft_graph', $3)`,
      [accountId, USER, connectionId],
    );
    await pool.query(
      `INSERT INTO provider_operations (user_id, account_id, resource_type, operation, status, payload)
       VALUES ($1, $2, 'message', 'update', 'pending', $3::jsonb)`,
      [USER, accountId, JSON.stringify(payload)],
    );
    const fetchImpl = vi.fn<FetchLike>();
    await expect(drainGraphMailFlagOperations({ userId: USER, connectionId, accountId, config: CONFIG, fetchImpl }))
      .resolves.toEqual({ due: 1, confirmed: 0, unresolved: 1 });
    expect(fetchImpl).not.toHaveBeenCalled();
    const rows = await pool.query<{ status: string }>('SELECT status FROM provider_operations WHERE user_id = $1', [USER]);
    expect(rows.rows).toEqual([{ status: 'pending' }]);
  });

  for (const provider of ['google', 'microsoft'] as const) {
    const audience = provider === 'google' ? GOOGLE_GRANT_AUDIENCE : MICROSOFT_GRANT_AUDIENCE;
    async function seed(expired = true): Promise<string> {
      return withTransaction(async client => {
        const id = await upsertProviderConnection(client, {
          userId: USER, provider, issuer: provider === 'google' ? GOOGLE_ISSUER : MICROSOFT_ISSUER,
          subject: `synthetic-${provider}`,
        });
        await storeOAuthGrant(client, {
          connectionId: id, audience, accessToken: 'synthetic-old', refreshToken: 'synthetic-refresh',
          expiresAt: new Date(Date.now() + (expired ? -1000 : 3600_000)), scopes: ['mail'], clientIdAtIssue: CONFIG.clientId,
        });
        return id;
      });
    }
    function adapter(connectionId: string, fetchImpl: FetchLike) {
      const api = { userId: USER, connectionId, config: CONFIG, fetchImpl };
      return provider === 'google' ? gmailFlagMutationAdapter({ api }) : graphFlagMutationAdapter({ api });
    }
    function write(connectionId: string, fetchImpl: FetchLike) {
      const api = { userId: USER, connectionId, config: CONFIG, fetchImpl };
      return provider === 'google'
        ? gmailModifyMessageLabels(api, payload.providerMessageId, [], ['UNREAD'])
        : graphPatch(api, '/me/messages/synthetic-message', { isRead: true });
    }
    function syntheticFetch(onResource?: () => Promise<void> | void) {
      return vi.fn<FetchLike>(async (url) => {
        if (String(url).includes('/token')) return Response.json({ access_token: 'synthetic-fresh', expires_in: 3600 });
        await onResource?.();
        return new Response(null, { status: 204 });
      });
    }

    it(`${provider}: held refresh lease makes zero writes, retains cause, then safely retries`, async () => {
      const connectionId = await seed();
      const grant = await pool.query<{ id: string }>('SELECT id FROM oauth_grants WHERE connection_id = $1', [connectionId]);
      const grantId = grant.rows[0]!.id;
      expect(await withTransaction(client => acquireRefreshLease(client, { grantId, owner: 'another-synthetic-worker' }))).not.toBeNull();
      const fetchImpl = syntheticFetch();

      await expect(write(connectionId, fetchImpl)).rejects.toMatchObject({
        code: 'UPSTREAM_UNAVAILABLE', retryable: true, providerReason: 'REFRESH_IN_PROGRESS',
        cause: expect.any(ProviderAuthError),
      });
      await expect(adapter(connectionId, fetchImpl).perform(payload, context())).resolves.toMatchObject({
        status: 'retryable', code: 'UPSTREAM_UNAVAILABLE',
      });
      expect(fetchImpl).not.toHaveBeenCalled();

      await pool.query('UPDATE oauth_grants SET refresh_lease_expires_at = NULL, refresh_lease_owner = NULL WHERE id = $1', [grantId]);
      await expect(adapter(connectionId, fetchImpl).perform(payload, context())).resolves.toEqual({ status: 'committed' });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(fetchImpl.mock.calls.filter(([url]) => !String(url).includes('/token'))).toHaveLength(1);
    });

    it(`${provider}: refresh generation race is safe to retry before any resource write`, async () => {
      const connectionId = await seed();
      const racingFetch = vi.fn<FetchLike>(async () => {
        await pool.query('UPDATE oauth_grants SET generation = generation + 1 WHERE connection_id = $1', [connectionId]);
        return Response.json({ access_token: 'losing-token', expires_in: 3600 });
      });
      await expect(write(connectionId, racingFetch)).rejects.toMatchObject({
        code: 'UPSTREAM_UNAVAILABLE', retryable: true, providerReason: 'REFRESH_RACE',
        cause: expect.objectContaining({ code: 'REFRESH_RACE' }),
      });
      expect(racingFetch).toHaveBeenCalledTimes(1);
      expect(String(racingFetch.mock.calls[0]![0])).toContain('/token');
      const fetchImpl = syntheticFetch();
      await expect(adapter(connectionId, fetchImpl).perform(payload, context())).resolves.toEqual({ status: 'committed' });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it(`${provider}: revoked authorization is a clear permanent refusal without dispatch`, async () => {
      const connectionId = await seed();
      await pool.query("UPDATE oauth_grants SET status = 'reauth_required' WHERE connection_id = $1", [connectionId]);
      const fetchImpl = syntheticFetch();
      await expect(adapter(connectionId, fetchImpl).perform(payload, context())).resolves.toEqual({
        status: 'permanent', code: 'PROVIDER_AUTH_REQUIRED',
      });
      await expect(write(connectionId, fetchImpl)).rejects.toMatchObject({ cause: expect.objectContaining({ code: 'REAUTH_REQUIRED' }) });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it(`${provider}: an invalid refresh grant never masquerades as an uncertain mail write`, async () => {
      const connectionId = await seed();
      const fetchImpl = vi.fn<FetchLike>(async () => Response.json({ error: 'invalid_grant' }, { status: 400 }));
      await expect(adapter(connectionId, fetchImpl).perform(payload, context())).resolves.toEqual({
        status: 'permanent', code: 'PROVIDER_AUTH_REQUIRED',
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(String(fetchImpl.mock.calls[0]![0])).toContain('/token');
      // The token service durably parks this grant, and the next request does not
      // contact even the token endpoint again.
      await expect(adapter(connectionId, fetchImpl).perform(payload, context())).resolves.toEqual({
        status: 'permanent', code: 'PROVIDER_AUTH_REQUIRED',
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it(`${provider}: definitive 401 followed by a held refresh lease remains safe to retry`, async () => {
      const connectionId = await seed(false);
      const grant = await pool.query<{ id: string }>('SELECT id FROM oauth_grants WHERE connection_id = $1', [connectionId]);
      expect(await withTransaction(client => acquireRefreshLease(client, {
        grantId: grant.rows[0]!.id, owner: 'another-synthetic-worker',
      }))).not.toBeNull();
      const fetchImpl = vi.fn<FetchLike>(async () => new Response(null, { status: 401 }));
      await expect(adapter(connectionId, fetchImpl).perform(payload, context())).resolves.toMatchObject({
        status: 'retryable', code: 'UPSTREAM_UNAVAILABLE',
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(String(fetchImpl.mock.calls[0]![0])).not.toContain('/token');
    });

    for (const landed of [true, false]) {
      it(`${provider}: post-dispatch uncertainty stays unknown when write ${landed ? 'landed' : 'did not land'}`, async () => {
        const connectionId = await seed(false);
        let remoteRead = false;
        const fetchImpl = syntheticFetch(() => {
          if (landed) remoteRead = true;
          throw new Error('synthetic resource connection reset');
        });
        await expect(adapter(connectionId, fetchImpl).perform(payload, context())).resolves.toEqual({
          status: 'outcome_unknown', code: 'MUTATION_OUTCOME_UNKNOWN',
        });
        expect(remoteRead).toBe(landed);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
      });
    }

    it(`${provider}: journal cancellation during refresh prevents late resource dispatch`, async () => {
      const connectionId = await seed();
      const controller = new AbortController();
      const fetchImpl = vi.fn<FetchLike>(async () => {
        controller.abort();
        return Response.json({ access_token: 'synthetic-late', expires_in: 3600 });
      });
      await expect(adapter(connectionId, fetchImpl).perform(payload, { operationId: 'cancelled', signal: controller.signal }))
        .resolves.toEqual({ status: 'outcome_unknown', code: 'MUTATION_OUTCOME_UNKNOWN' });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(String(fetchImpl.mock.calls[0]![0])).toContain('/token');
    });
  }
});
