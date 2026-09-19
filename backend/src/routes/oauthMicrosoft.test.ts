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

import oauthMicrosoftRouter from './oauthMicrosoft.js';

// Capture the real fetch before the per-test stub replaces the global, so the
// suite can still call its own local server.
const realFetch = globalThis.fetch.bind(globalThis) as typeof fetch;

const CONFIG = {
  clientId: '11111111-2222-3333-4444-555555555555',
  clientSecret: 'ms-secret',
  redirectUri: 'https://inboxora.example/oauth/microsoft/callback',
  // The provider flow has its own callback; using the mailbox one sent its code to the
  // legacy route, which knows nothing about this flow's state.
  providerRedirectUri: 'https://inboxora.example/oauth/provider/microsoft/callback',
  tenantId: 'consumers',
};

let sessionUserId = 'user-1';
let takenFlow: Record<string, unknown>;
let tokenStatus = 200;
let tokenBody: Record<string, unknown>;
let graphStatus = 200;
let graphBody: Record<string, unknown>;

const originalEnv = {
  APP_URL: process.env.APP_URL,
  MS_CLIENT_ID: process.env.MS_CLIENT_ID,
  MS_CLIENT_SECRET: process.env.MS_CLIENT_SECRET,
  MS_REDIRECT_URI: process.env.MS_REDIRECT_URI,
  MS_TENANT_ID: process.env.MS_TENANT_ID,
};

let server: Server;
let base = '';

function queryCallsMatching(fragment: string): unknown[][] {
  return mocks.query.mock.calls.filter(([sql]) => String(sql).includes(fragment));
}

function providerCalls(): unknown[][] {
  return vi.mocked(fetch).mock.calls.filter(([url]) => !String(url).startsWith(base));
}

beforeAll(async () => {
  const app = express();
  app.use((req, _res, next) => { (req as unknown as { session: { userId: string } }).session = { userId: sessionUserId }; next(); });
  app.use('/oauth', oauthMicrosoftRouter);
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
  graphStatus = 200;
  tokenBody = {
    access_token: 'ms-access-1', refresh_token: 'ms-refresh-1', expires_in: 3600,
    scope: 'https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send',
  };
  graphBody = { id: 'ms-sub-1', userPrincipalName: 'user@contoso.test', mail: 'user@contoso.test', displayName: 'Contoso User' };
  takenFlow = {
    id: 'flow-1', user_id: 'user-1', provider: 'microsoft', purpose: 'mail_migration',
    target_account_id: null, code_verifier_enc: 'enc:verifier-1', nonce: 'nonce-1',
    requested_scopes: ['offline_access', 'https://graph.microsoft.com/Mail.ReadWrite'],
    return_route: '/settings', config_revision: null,
  };
  process.env.MS_CLIENT_ID = CONFIG.clientId;
  process.env.MS_CLIENT_SECRET = CONFIG.clientSecret;
  process.env.MS_REDIRECT_URI = CONFIG.redirectUri;
  process.env.MS_TENANT_ID = CONFIG.tenantId;
  // The provider callback is derived from the trusted APP_URL when not set explicitly.
  process.env.APP_URL = 'https://inboxora.example';

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
    if (String(url).startsWith(base)) return realFetch(url, init);
    if (String(url).includes('login.microsoftonline.com') && String(url).includes('/token')) {
      return { ok: tokenStatus === 200, status: tokenStatus, json: async () => tokenBody } as Response;
    }
    if (String(url).includes('graph.microsoft.com')) {
      return { ok: graphStatus === 200, status: graphStatus, json: async () => graphBody } as Response;
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MS_CLIENT_ID;
  delete process.env.MS_CLIENT_SECRET;
  delete process.env.MS_REDIRECT_URI;
  delete process.env.MS_TENANT_ID;
  delete process.env.APP_URL;
});

const startFlow = (query = '') => realFetch(`${base}/oauth/provider/microsoft${query}`, { redirect: 'manual' });
const callback = (query: string) => realFetch(`${base}/oauth/provider/microsoft/callback${query}`, { redirect: 'manual' });

describe('GET /oauth/provider/microsoft (start)', () => {
  it('refuses to start when the administrator has not configured Microsoft', async () => {
    delete process.env.MS_CLIENT_ID;
    const response = await startFlow();
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('oauth_error=');
    expect(queryCallsMatching('INSERT INTO oauth_authorization_flows')).toHaveLength(0);
  });

  it('redirects to the tenant with PKCE, the requested scopes and a hashed state', async () => {
    const response = await startFlow('?purpose=mail_migration&access=read_only');
    expect(response.status).toBe(302);
    const location = new URL(String(response.headers.get('location')));
    expect(location.origin + location.pathname).toBe('https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize');
    expect(location.searchParams.get('client_id')).toBe(CONFIG.clientId);
    // The provider flow must send its own callback, not the mailbox one: the mailbox
    // route knows nothing about this flow's state, so the code would be lost there.
    expect(location.searchParams.get('redirect_uri')).toBe(CONFIG.providerRedirectUri);
    expect(location.searchParams.get('redirect_uri')).not.toBe(CONFIG.redirectUri);
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('response_mode')).toBe('query');
    // Never silently reuse the browser session.
    expect(location.searchParams.get('prompt')).toBe('select_account');
    const scope = location.searchParams.get('scope') ?? '';
    expect(scope).toContain('https://graph.microsoft.com/Mail.ReadWrite');
    expect(scope).toContain('offline_access');
    // Read-only intent must not request calendar write access that was never asked for.
    expect(scope).not.toContain('Calendars.');

    const state = location.searchParams.get('state') ?? '';
    expect(state.length).toBeGreaterThan(20);
    const [insert] = queryCallsMatching('INSERT INTO oauth_authorization_flows');
    expect(insert).toBeDefined();
    // Only a hash of the state is stored: the raw value must not be in the row.
    expect(JSON.stringify(insert)).not.toContain(state);
  });

  it('asks for read-only calendar scope when the user chooses a viewer', async () => {
    const response = await startFlow('?purpose=calendar_enable&access=read_only');
    const scope = new URL(String(response.headers.get('location'))).searchParams.get('scope') ?? '';
    expect(scope).toContain('https://graph.microsoft.com/Calendars.Read');
    expect(scope).not.toContain('Calendars.ReadWrite');
    // Calendars never drag the mailbox along.
    expect(scope).not.toContain('Mail.');
  });

  it('rejects a target account the actor does not own', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (String(sql).includes('SELECT 1 FROM email_accounts')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });
    const response = await startFlow('?purpose=mail_migration&accountId=00000000-0000-0000-0000-0000000000aa');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('oauth_error=');
    expect(queryCallsMatching('INSERT INTO oauth_authorization_flows')).toHaveLength(0);
  });
});

describe('GET /oauth/provider/microsoft/callback', () => {
  it('rejects an unknown or replayed state without contacting Microsoft', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (String(sql).includes("SET status = 'exchanging'")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });
    const response = await callback('?state=unknown&code=code-1');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('oauth_error=');
    expect(providerCalls()).toHaveLength(0);
  });

  it('never attaches a grant when the callback arrives in another session', async () => {
    sessionUserId = 'user-2';
    const response = await callback('?state=state-1&code=code-1');
    expect(response.status).toBe(403);
    expect(queryCallsMatching('INSERT INTO oauth_grants')).toHaveLength(0);
    expect(queryCallsMatching('INSERT INTO provider_connections')).toHaveLength(0);
    const finish = queryCallsMatching('UPDATE oauth_authorization_flows').find(([sql]) => String(sql).includes('SET status = $2'));
    expect(JSON.stringify(finish)).toContain('SESSION_MISMATCH');
  });

  it('rejects a flow whose configuration changed before the callback', async () => {
    takenFlow = { ...takenFlow, config_revision: 'revision-from-before' };
    const response = await callback('?state=state-1&code=code-1');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('oauth_error=');
    expect(providerCalls()).toHaveLength(0);
    const finish = queryCallsMatching('UPDATE oauth_authorization_flows').find(([sql]) => String(sql).includes('SET status = $2'));
    expect(JSON.stringify(finish)).toContain('CONFIG_CHANGED');
  });

  it('exchanges the code, reads the Graph identity and stores connection and grant', async () => {
    const response = await callback('?state=state-1&code=code-1');
    expect(response.status).toBe(302);
    // The Graph connection is not an account sign-in, so it must not open Accounts.
    expect(response.headers.get('location')).toBe('/?oauth_success=microsoft_graph');

    const [[tokenUrl, tokenInit]] = providerCalls();
    expect(String(tokenUrl)).toBe('https://login.microsoftonline.com/consumers/oauth2/v2.0/token');
    const body = String((tokenInit as { body?: string }).body);
    expect(body).toContain('grant_type=authorization_code');
    expect(body).toContain('code_verifier=verifier-1');

    const [connection] = queryCallsMatching('INSERT INTO provider_connections');
    const connectionParams = JSON.stringify(connection);
    expect(connectionParams).toContain('microsoft');
    expect(connectionParams).toContain('https://login.microsoftonline.com');
    expect(connectionParams).toContain('ms-sub-1');

    const [grant] = queryCallsMatching('INSERT INTO oauth_grants');
    const grantParams = JSON.stringify(grant);
    expect(grantParams).toContain('https://graph.microsoft.com/');
    // The granted scopes win over the requested ones.
    expect(grantParams).toContain('Mail.Send');

    const finish = queryCallsMatching('UPDATE oauth_authorization_flows').find(([sql]) => String(sql).includes('SET status = $2'));
    expect(JSON.stringify(finish)).toContain('completed');
  });

  it('records a declined authorization as failed and redirects the user', async () => {
    const response = await callback('?error=access_denied&state=state-1');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('oauth_error=');
    expect(providerCalls()).toHaveLength(0);
    const finish = queryCallsMatching('UPDATE oauth_authorization_flows').find(([sql]) => String(sql).includes('SET status = $2'));
    expect(JSON.stringify(finish)).toContain('PROVIDER_DENIED');
  });

  it('fails the flow when the token exchange is rejected', async () => {
    tokenStatus = 400;
    tokenBody = { error: 'invalid_grant', error_description: 'AADSTS70008: The code has expired.' };
    const response = await callback('?state=state-1&code=code-1');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('oauth_error=');
    expect(queryCallsMatching('INSERT INTO oauth_grants')).toHaveLength(0);
    const finish = queryCallsMatching('UPDATE oauth_authorization_flows').find(([sql]) => String(sql).includes('SET status = $2'));
    expect(JSON.stringify(finish)).toContain('invalid_grant');
  });

  it('does not store a grant when Graph cannot identify the account', async () => {
    graphStatus = 403;
    const response = await callback('?state=state-1&code=code-1');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('oauth_error=');
    expect(queryCallsMatching('INSERT INTO oauth_grants')).toHaveLength(0);
    const finish = queryCallsMatching('UPDATE oauth_authorization_flows').find(([sql]) => String(sql).includes('SET status = $2'));
    expect(JSON.stringify(finish)).toContain('USERINFO_FAILED');
  });
});
