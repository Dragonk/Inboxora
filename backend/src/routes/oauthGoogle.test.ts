import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { listeningPort } from '../test/net.js';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
const finalizerMock = vi.hoisted(() => ({ finalize: vi.fn() }));

vi.mock('../services/db.js', () => ({
  query: mocks.query,
  withTransaction: async (fn: (client: { query: typeof mocks.query }) => unknown) => fn({ query: mocks.query }),
}));
// Keep the real `isFinalizablePurpose`/`authorizationResultQuery`, but observe the finalization call so a test
// can prove an `account_enable` callback runs the mailbox's services instead of the generic success branch.
vi.mock('../services/providerAuthorizationFinalizer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/providerAuthorizationFinalizer.js')>();
  return { ...actual, finalizeProviderAuthorization: finalizerMock.finalize };
});
vi.mock('../services/encryption.js', () => ({
  encrypt: (value: string) => `enc:${value}`,
  decrypt: (value: unknown) => typeof value === 'string' && value.startsWith('enc:') ? value.slice(4) : value,
}));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import oauthGoogleRouter from './oauthGoogle.js';

// Capture the real fetch before the per-test stub replaces the global, so the
// suite can still call its own local server.
const realFetch = globalThis.fetch.bind(globalThis) as typeof fetch;

const CONFIG = {
  clientId: 'client-123.apps.googleusercontent.com',
  clientSecret: 'secret-value',
  redirectUri: 'https://inboxora.example/oauth/google/callback',
};

let sessionUserId = 'user-1';
let takenFlow: Record<string, unknown>;
let tokenStatus = 200;
let tokenBody: Record<string, unknown>;

const originalEnv = {
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI,
};

let server: Server;
let base = '';

function queryCallsMatching(fragment: string): unknown[][] {
  return mocks.query.mock.calls.filter(([sql]) => String(sql).includes(fragment));
}

/** Calls the route handlers made to a provider endpoint (not to this test server). */
function providerCalls(): unknown[][] {
  return vi.mocked(fetch).mock.calls.filter(([url]) => !String(url).startsWith(base));
}

beforeAll(async () => {
  const app = express();
  // The callback is a top-level browser navigation, so it reads the session itself.
  app.use((req, _res, next) => { (req as unknown as { session: { userId: string } }).session = { userId: sessionUserId }; next(); });
  app.use('/oauth', oauthGoogleRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  base = `http://127.0.0.1:${listeningPort(server)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  sessionUserId = 'user-1';
  tokenStatus = 200;
  tokenBody = { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600, scope: 'openid email gmail.modify' };
  takenFlow = {
    id: 'flow-1', user_id: 'user-1', provider: 'google', purpose: 'new_account',
    target_account_id: null, code_verifier_enc: 'enc:verifier-1', nonce: 'nonce-1',
    requested_scopes: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.modify'],
    return_route: '/settings', config_revision: null,
  };
  process.env.GOOGLE_CLIENT_ID = CONFIG.clientId;
  process.env.GOOGLE_CLIENT_SECRET = CONFIG.clientSecret;
  process.env.GOOGLE_REDIRECT_URI = CONFIG.redirectUri;

  finalizerMock.finalize.mockReset();
  finalizerMock.finalize.mockResolvedValue({
    provider: 'google',
    purpose: 'account_enable',
    accountId: '11111111-1111-4111-8111-111111111111',
    authorized: true,
    synchronized: true,
    syncErrorCode: null,
  });

  mocks.query.mockReset();
  mocks.query.mockImplementation(async (sql: string) => {
    const text = String(sql);
    if (text.includes("SET status = 'exchanging'")) return { rows: [takenFlow], rowCount: 1 };
    if (text.includes('INSERT INTO oauth_authorization_flows')) return { rows: [{ id: 'flow-1', expires_at: new Date(Date.now() + 600_000) }], rowCount: 1 };
    if (text.includes('SELECT 1 FROM email_accounts')) return { rows: [{ '?column?': 1 }], rowCount: 1 };
    if (text.includes('SELECT id FROM provider_connections')) return { rows: [], rowCount: 0 };
    if (text.includes('INSERT INTO provider_connections')) return { rows: [{ id: 'connection-1' }], rowCount: 1 };
    if (text.includes('INSERT INTO oauth_grants')) return { rows: [{ id: 'grant-1', generation: '1' }], rowCount: 1 };
    if (text.includes('UPDATE oauth_authorization_flows')) return { rows: [{ id: 'flow-1' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });

  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    // The suite's own HTTP calls go to the real server.
    if (String(url).startsWith(base)) return realFetch(url, init);
    if (String(url).includes('oauth2.googleapis.com')) {
      return { ok: tokenStatus === 200, status: tokenStatus, json: async () => tokenBody } as Response;
    }
    if (String(url).includes('userinfo')) {
      return { ok: true, status: 200, json: async () => ({ sub: 'google-sub-1', email: 'user@example.test', email_verified: true }) } as Response;
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_REDIRECT_URI;
});

async function startFlow(query = ''): Promise<Response> {
  return realFetch(`${base}/oauth/google${query}`, { redirect: 'manual' });
}

async function callback(query: string): Promise<Response> {
  return realFetch(`${base}/oauth/google/callback${query}`, { redirect: 'manual' });
}

describe('GET /oauth/google (start)', () => {
  it('refuses to start when the administrator has not configured Google', async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    const response = await startFlow();
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/?oauth_error=Google%20API%20is%20not%20configured');
    expect(queryCallsMatching('INSERT INTO oauth_authorization_flows')).toHaveLength(0);
  });

  it('redirects to Google with PKCE and stores only a hash of the state', async () => {
    const response = await startFlow('?purpose=calendar_enable');
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location') || '');
    expect(location.origin + location.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('scope')).toContain('calendar.events');
    expect(location.searchParams.get('scope')).not.toContain('gmail');

    const insert = queryCallsMatching('INSERT INTO oauth_authorization_flows');
    expect(insert).toHaveLength(1);
    const params = insert[0][1] as unknown[];
    const stateHash = String(params[4]);
    expect(stateHash).toMatch(/^[0-9a-f]{64}$/);
    // The plaintext state is never stored, and the PKCE verifier is encrypted.
    expect(stateHash).not.toBe(location.searchParams.get('state'));
    expect(String(params[5])).toMatch(/^enc:/);
    expect(params[2]).toBe('calendar_enable');
    expect(params[3]).toBeNull();
  });

  it('refuses to start when the provider layer is switched off for the installation', async () => {
    // One operator switch above the per-provider ones: an installation that must not call out to a
    // provider should not be able to start this flow at all.
    process.env.PROVIDER_INTEGRATIONS_ENABLED = '0';
    try {
      const response = await startFlow();
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toContain('oauth_error=');
      expect(queryCallsMatching('INSERT INTO oauth_authorization_flows')).toHaveLength(0);
    } finally {
      delete process.env.PROVIDER_INTEGRATIONS_ENABLED;
    }
  });

  it('refuses to start when the administrator switched the API off', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ config: { apiEnabled: false } }] });
    const apiOff = await startFlow();
    expect(apiOff.status).toBe(302);
    expect(apiOff.headers.get('location')).toContain('oauth_error=');

    mocks.query.mockResolvedValueOnce({ rows: [{ config: { disabled: true } }] });
    const providerOff = await startFlow();
    expect(providerOff.status).toBe(302);
    expect(providerOff.headers.get('location')).toContain('oauth_error=');
    expect(queryCallsMatching('INSERT INTO oauth_authorization_flows')).toHaveLength(0);
  });

  it('rejects a target account the actor does not own', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (String(sql).includes('SELECT 1 FROM email_accounts')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });
    const response = await startFlow('?accountId=11111111-1111-4111-8111-111111111111');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/?oauth_error=Account%20not%20found');
    expect(queryCallsMatching('INSERT INTO oauth_authorization_flows')).toHaveLength(0);
  });

  it('starts the whole-mailbox account_enable purpose with mail, calendar and contacts scopes', async () => {
    // AUTH-01: the account card asks for one consent covering everything the mailbox needs. The route used to
    // keep a narrower allow-list, so this value was rewritten to `new_account` and no service was ever
    // finalized for the existing mailbox.
    const response = await startFlow('?purpose=account_enable');
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location') || '');
    const scope = location.searchParams.get('scope') || '';
    expect(scope).toContain('gmail.modify');
    expect(scope).toContain('calendar.events');
    expect(scope).toContain('contacts');
    const insert = queryCallsMatching('INSERT INTO oauth_authorization_flows');
    expect(insert).toHaveLength(1);
    expect((insert[0][1] as unknown[])[2]).toBe('account_enable');
  });

  it('rejects an explicitly unknown purpose instead of quietly starting another flow', async () => {
    const response = await startFlow('?purpose=delete_everything');
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Unsupported authorization purpose' });
    expect(queryCallsMatching('INSERT INTO oauth_authorization_flows')).toHaveLength(0);
  });
});

describe('GET /oauth/google/callback', () => {
  it('rejects an unknown or replayed state without contacting Google', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (String(sql).includes("SET status = 'exchanging'")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });
    const response = await callback('?code=code-1&state=replayed');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/?oauth_error=Invalid%20OAuth%20state%20-%20please%20start%20from%20the%20account%20card%20again');
    expect(providerCalls()).toHaveLength(0);
  });

  it('never attaches a grant when the callback arrives in another session', async () => {
    sessionUserId = 'user-2';
    const response = await callback('?code=code-1&state=state-1');
    expect(response.status).toBe(403);
    expect(response.headers.get('location')).toBe('/?oauth_error=Authorization%20session%20mismatch');
    expect(queryCallsMatching('INSERT INTO oauth_grants')).toHaveLength(0);
    // The taken flow is consumed as failed rather than left usable.
    const finish = queryCallsMatching('UPDATE oauth_authorization_flows').find(([sql]) => String(sql).includes('SET status = $2'));
    expect(finish?.[1]).toEqual(['flow-1', 'failed', 'SESSION_MISMATCH']);
  });

  it('rejects a flow whose configuration changed before the callback', async () => {
    takenFlow.config_revision = 'a-different-revision';
    const response = await callback('?code=code-1&state=state-1');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/?oauth_error=Google%20configuration%20changed%20during%20authorization');
    expect(queryCallsMatching('INSERT INTO oauth_grants')).toHaveLength(0);
  });

  it('does not exchange a returned code after the administrator disables Google', async () => {
    const defaultQuery = mocks.query.getMockImplementation();
    mocks.query.mockImplementation(async (sql: string, ...args: unknown[]) => {
      if (String(sql).includes('FROM integration_config')) {
        return { rows: [{ config: { apiEnabled: false } }], rowCount: 1 };
      }
      return defaultQuery?.(sql, ...args) as Promise<{ rows: unknown[]; rowCount: number }>;
    });

    const response = await callback('?code=code-1&state=state-1');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/?oauth_error=Google%20API%20is%20disabled%20by%20the%20administrator');
    expect(providerCalls()).toHaveLength(0);
    expect(queryCallsMatching('INSERT INTO oauth_grants')).toHaveLength(0);
    const finish = queryCallsMatching('UPDATE oauth_authorization_flows').find(([sql]) => String(sql).includes('SET status = $2'));
    expect(finish?.[1]).toEqual(['flow-1', 'failed', 'PROVIDER_DISABLED']);
  });

  it('exchanges the code, verifies the identity and stores connection and grant', async () => {
    const response = await callback('?code=code-1&state=state-1');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/?oauth_success=google');

    // The code exchange carries the decrypted PKCE verifier and the client secret.
    const tokenCall = vi.mocked(fetch).mock.calls.find(([url]) => String(url).includes('oauth2.googleapis.com'));
    expect(tokenCall).toBeTruthy();
    const body = new URLSearchParams(String((tokenCall?.[1] as RequestInit).body));
    expect(body.get('code_verifier')).toBe('verifier-1');
    expect(body.get('code')).toBe('code-1');
    expect(body.get('client_secret')).toBe(CONFIG.clientSecret);

    // Identity is issuer + subject; an email change must not duplicate the connection.
    const connection = queryCallsMatching('INSERT INTO provider_connections');
    expect(connection).toHaveLength(1);
    const connectionParams = connection[0][1] as unknown[];
    expect(connectionParams[2]).toBe('https://accounts.google.com');
    expect(connectionParams[3]).toBe('google-sub-1');

    // A response without a refresh token must keep the stored one.
    const grant = queryCallsMatching('INSERT INTO oauth_grants');
    expect(grant).toHaveLength(1);
    expect(String(grant[0][0])).toContain('COALESCE(EXCLUDED.refresh_token_encrypted, oauth_grants.refresh_token_encrypted)');
    const grantParams = grant[0][1] as unknown[];
    expect(grantParams[1]).toBe('https://www.googleapis.com/');
    expect(grantParams[2]).toBe('enc:access-1');
    expect(grantParams[3]).toBe('enc:refresh-1');

    const completed = queryCallsMatching('UPDATE oauth_authorization_flows').find(([sql]) => String(sql).includes('SET status = $2'));
    expect(completed?.[1]).toEqual(['flow-1', 'completed', null]);
  });

  it('does not announce success for a duplicate callback while the first is still exchanging', async () => {
    // AUTH-03: the state is single-use and the first callback has already moved the flow to `exchanging`. A
    // reload or a provider retry must not turn that into a terminal success the first callback may contradict.
    mocks.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes("SET status = 'exchanging'")) return { rows: [], rowCount: 0 };
      if (text.includes('FROM oauth_authorization_flows')) {
        return { rows: [{ status: 'exchanging', expired: false, target_account_id: 'acct-9', error_code: null }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const response = await callback('?code=code-1&state=state-1');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/?oauth_pending=google&accountId=acct-9');
  });

  it('reports the terminal result with the account for a duplicate callback after success', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes("SET status = 'exchanging'")) return { rows: [], rowCount: 0 };
      if (text.includes('FROM oauth_authorization_flows')) {
        return { rows: [{ status: 'completed', expired: false, target_account_id: 'acct-9', error_code: null }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const response = await callback('?code=code-1&state=state-1');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/?oauth_success=google&authorized=1&accountId=acct-9');
  });

  it('refuses to re-point a mailbox at a different Google identity', async () => {
    // AUTH-02: choosing another Google account in the consent window must not bind this mailbox to it.
    takenFlow.target_account_id = '11111111-1111-4111-8111-111111111111';
    mocks.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes("SET status = 'exchanging'")) return { rows: [takenFlow], rowCount: 1 };
      if (text.includes('JOIN provider_connections')) {
        return { rows: [{ provider: 'google', issuer: 'https://accounts.google.com', subject: 'another-subject', tenant_id: null }], rowCount: 1 };
      }
      if (text.includes('UPDATE oauth_authorization_flows')) return { rows: [{ id: 'flow-1' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const response = await callback('?code=code-1&state=state-1');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('different%20Google%20account');
    expect(queryCallsMatching('INSERT INTO provider_connections')).toHaveLength(0);
    expect(queryCallsMatching('INSERT INTO oauth_grants')).toHaveLength(0);
    expect(queryCallsMatching('UPDATE email_accounts')).toHaveLength(0);
    const finish = queryCallsMatching('UPDATE oauth_authorization_flows').find(([sql]) => String(sql).includes('SET status = $2'));
    expect(finish?.[1]).toEqual(['flow-1', 'failed', 'IDENTITY_MISMATCH']);
  });

  it('still re-points a mailbox at the connection of the same Google identity', async () => {
    // The repair this must keep working: a mailbox whose recorded connection is the wrong row of the *same*
    // identity is moved to the connection the grant was stored on.
    takenFlow.target_account_id = '11111111-1111-4111-8111-111111111111';
    mocks.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes("SET status = 'exchanging'")) return { rows: [takenFlow], rowCount: 1 };
      if (text.includes('JOIN provider_connections')) {
        return { rows: [{ provider: 'google', issuer: 'https://accounts.google.com', subject: 'google-sub-1', tenant_id: null }], rowCount: 1 };
      }
      if (text.includes('INSERT INTO provider_connections')) return { rows: [{ id: 'connection-1' }], rowCount: 1 };
      if (text.includes('INSERT INTO oauth_grants')) return { rows: [{ id: 'grant-1', generation: '1' }], rowCount: 1 };
      if (text.includes('UPDATE email_accounts SET provider_connection_id')) return { rows: [], rowCount: 1 };
      if (text.includes('UPDATE oauth_authorization_flows')) return { rows: [{ id: 'flow-1' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const response = await callback('?code=code-1&state=state-1');
    expect(response.status).toBe(302);
    expect(queryCallsMatching('UPDATE email_accounts SET provider_connection_id')).toHaveLength(1);
  });

  it('records a declined authorization as failed and redirects the user', async () => {
    const response = await callback('?error=access_denied&state=state-1');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/?oauth_error=Google%20authorization%20was%20denied');
    const finish = queryCallsMatching('UPDATE oauth_authorization_flows').find(([sql]) => String(sql).includes('SET status = $2'));
    expect(finish?.[1]).toEqual(['flow-1', 'failed', 'PROVIDER_DENIED']);
    expect(providerCalls()).toHaveLength(0);
  });

  it('fails the flow when the token exchange is rejected', async () => {
    tokenStatus = 400;
    tokenBody = { error: 'invalid_grant', error_description: 'code expired' };
    const response = await callback('?code=code-1&state=state-1');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/?oauth_error=Google%20authentication%20failed');
    expect(queryCallsMatching('INSERT INTO oauth_grants')).toHaveLength(0);
    const finish = queryCallsMatching('UPDATE oauth_authorization_flows').find(([sql]) => String(sql).includes('SET status = $2'));
    expect(finish?.[1]).toEqual(['flow-1', 'failed', 'invalid_grant']);
  });

  it('finalizes an account_enable consent instead of announcing a bare success', async () => {
    // AUTH-01: the reconnect card listens for a result that names its account. A generic `oauth_success`
    // without finalization leaves the card waiting, so this path must reach the finalizer and report back.
    takenFlow.purpose = 'account_enable';
    takenFlow.target_account_id = '11111111-1111-4111-8111-111111111111';
    const response = await callback('?code=code-1&state=state-1');
    expect(response.status).toBe(302);
    const location = response.headers.get('location') || '';
    expect(location).not.toBe('/?oauth_success=google');
    expect(finalizerMock.finalize).toHaveBeenCalledTimes(1);
    expect(finalizerMock.finalize.mock.calls[0][0]).toMatchObject({
      provider: 'google',
      purpose: 'account_enable',
      targetAccountId: '11111111-1111-4111-8111-111111111111',
    });
    expect(location).toContain('accountId=11111111-1111-4111-8111-111111111111');
    expect(location).toContain('authorized=1');
  });
});
