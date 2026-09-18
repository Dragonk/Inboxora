import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { listeningPort } from '../test/net.js';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('../services/db.js', () => ({
  query: mocks.query,
  withTransaction: async (fn: (client: { query: typeof mocks.query }) => unknown) => fn({ query: mocks.query }),
}));
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
});

describe('GET /oauth/google/callback', () => {
  it('rejects an unknown or replayed state without contacting Google', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (String(sql).includes("SET status = 'exchanging'")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });
    const response = await callback('?code=code-1&state=replayed');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/?oauth_error=Invalid%20or%20expired%20authorization%20state');
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
});
