// Route coverage for the P12 in-place Microsoft Graph cutover and the reconnect guard that keeps a
// native account from being reconnected over IMAP.
//
// The cutover service itself is covered against real PostgreSQL in
// `providerMailCutover.integration.test.ts`; here the question is what the HTTP surface does with
// each outcome — the status, the body, whether the IMAP session is torn down, and that a native
// account never reaches `imapManager.connectAccount`.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { listeningPort } from '../test/net.js';
import type { Server } from 'node:http';
import type { JsonBody } from '../test/json.js';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: { headers: Record<string, string>; session?: { userId?: string } }, _res: unknown, next: () => void) => {
    req.session = { userId: '11111111-1111-1111-1111-111111111111' };
    next();
  },
}));
vi.mock('../index.js', () => ({
  imapManager: {
    connectAccount: vi.fn().mockResolvedValue(true),
    disconnectAccount: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('../services/connectionPolicy.js', () => ({
  getConnectionPolicy: vi.fn().mockResolvedValue({
    allowPrivateHosts: false,
    allowInsecureTls: false,
    allowNonstandardPorts: false,
  }),
}));
// The route classifies the account first, with the same service the recommendation uses.
vi.mock('../services/providerAccountClassifier.js', () => ({
  classifyProviderAccount: vi.fn(() => 'microsoft'),
  classifyProviderAccountById: vi.fn(async () => ({ kind: 'microsoft', account: { email_address: 'user@example.test' } })),
  providerConnectionSignals: vi.fn(async () => []),
}));

vi.mock('../services/providerMailCutover.js', () => ({
  cutOverMicrosoftMailAccount: vi.fn(),
}));
// The route asks the other provider only when the first declines, so the Google half is stubbed here and
// exercised by its own suite; without it the real service would run against this suite's db mock.
vi.mock('../services/providerGoogleMailCutover.js', () => ({
  cutOverGoogleMailAccount: vi.fn(),
}));

import express from 'express';
import accountRoutes from './accounts.js';
import { query as __mock_query } from '../services/db.js';
import { imapManager as __mock_imapManager } from '../index.js';
import { cutOverMicrosoftMailAccount as __mock_cutover } from '../services/providerMailCutover.js';
import { cutOverGoogleMailAccount as __mock_googleCutover } from '../services/providerGoogleMailCutover.js';

const query = vi.mocked(__mock_query);
const imapManager = vi.mocked(__mock_imapManager, true);
const cutover = vi.mocked(__mock_cutover);
const googleCutover = vi.mocked(__mock_googleCutover);

const ACCOUNT_ID = '22222222-2222-2222-2222-222222222222';
const CONNECTION_ID = '33333333-3333-3333-3333-333333333333';

const nativeAccount = {
  id: ACCOUNT_ID,
  email_address: 'user@outlook.com',
  mail_transport: 'microsoft_graph',
  protocol: 'microsoft_graph',
  provider_connection_id: CONNECTION_ID,
  provider_mailbox_id: 'graph-subject',
  migration_state: 'active_native',
  migration_required: false,
  mail_method_preference: 'microsoft_graph',
  transport_generation: 2,
} as const;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/accounts', accountRoutes);
  return app;
}

describe('POST /api/accounts/:id/migrate', () => {
  let server: Server;
  let base = '';

  beforeAll(async () => {
    await new Promise(resolve => {
      server = buildApp().listen(0, resolve);
    });
    base = `http://127.0.0.1:${listeningPort(server)}`;
  });

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  beforeEach(() => {
    query.mockReset();
    cutover.mockReset();
    googleCutover.mockReset();
    // The Google half is not the subject here: it declines, as it would for an account that is not Google.
    googleCutover.mockResolvedValue({ status: 'not_applicable', reason: 'This account is not a Google account' });
    imapManager.connectAccount.mockClear();
    imapManager.disconnectAccount.mockClear();
  });

  function migrate(body: unknown = {}) {
    return fetch(`${base}/api/accounts/${ACCOUNT_ID}/migrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('reports a successful in-place switch and tears the IMAP session down', async () => {
    cutover.mockResolvedValue({
      status: 'migrated',
      account: nativeAccount,
      connectionId: CONNECTION_ID,
      transitions: [{ from: 'not_applicable', to: 'active_native' }],
      foldersDiscovered: true,
      folders: 7,
    });

    const response = await migrate();

    expect(response.status).toBe(200);
    const body = (await response.json()) as JsonBody & {
      ok?: boolean; transport?: string; connectionId?: string;
      transitions?: unknown[]; account?: { migration_state?: string };
    };
    expect(body.ok).toBe(true);
    expect(body.transport).toBe('microsoft_graph');
    expect(body.connectionId).toBe(CONNECTION_ID);
    expect(body.transitions).toEqual([{ from: 'not_applicable', to: 'active_native' }]);
    expect(body.account?.migration_state).toBe('active_native');
    // The account id the service was asked to move is the one from the path, and the actor's id is
    // the session user — ownership is decided by the service, not by the body.
    expect(cutover).toHaveBeenCalledWith({
      userId: '11111111-1111-1111-1111-111111111111',
      accountId: ACCOUNT_ID,
      connectionId: null,
      allowIdentityMismatch: false,
    });
    expect(imapManager.disconnectAccount).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(imapManager.connectAccount).not.toHaveBeenCalled();
  });

  it('passes an explicit connection through and validates its uuid', async () => {
    cutover.mockResolvedValue({
      status: 'migrated',
      account: nativeAccount,
      connectionId: CONNECTION_ID,
      transitions: [],
      foldersDiscovered: false,
      folders: 0,
    });

    expect((await migrate({ connectionId: CONNECTION_ID })).status).toBe(200);
    expect(cutover).toHaveBeenCalledWith({
      userId: '11111111-1111-1111-1111-111111111111',
      accountId: ACCOUNT_ID,
      connectionId: CONNECTION_ID,
      allowIdentityMismatch: false,
    });

    cutover.mockClear();
    const malformed = await migrate({ connectionId: 'not-a-uuid' });
    expect(malformed.status).toBe(400);
    expect(cutover).not.toHaveBeenCalled();
  });

  it('passes a deliberate identity mismatch through and rejects a malformed one', async () => {
    cutover.mockResolvedValue({
      status: 'migrated', account: nativeAccount, connectionId: CONNECTION_ID, transitions: [], foldersDiscovered: false, folders: 0,
    });

    expect((await migrate({ connectionId: CONNECTION_ID, allowIdentityMismatch: true })).status).toBe(200);
    expect(cutover).toHaveBeenCalledWith(expect.objectContaining({ connectionId: CONNECTION_ID, allowIdentityMismatch: true }));

    cutover.mockClear();
    const malformed = await migrate({ connectionId: CONNECTION_ID, allowIdentityMismatch: 'yes' });
    expect(malformed.status).toBe(400);
    expect(cutover).not.toHaveBeenCalled();
  });

  it('answers an already-native account as an idempotent no-op and does not reconnect anything', async () => {
    cutover.mockResolvedValue({
      status: 'already_native',
      account: nativeAccount,
      connectionId: CONNECTION_ID,
      transitions: [],
    });

    const response = await migrate();
    expect(response.status).toBe(200);
    const body = (await response.json()) as JsonBody & { alreadyNative?: boolean };
    expect(body.alreadyNative).toBe(true);
    expect(imapManager.disconnectAccount).not.toHaveBeenCalled();
    expect(imapManager.connectAccount).not.toHaveBeenCalled();
  });

  it('surfaces a refusal with its code and the scopes the grant is missing', async () => {
    cutover.mockResolvedValue({
      status: 'refused',
      httpStatus: 409,
      code: 'PROVIDER_AUTH_REQUIRED',
      message: 'The Microsoft grant is missing the scopes the Graph transport needs: Mail.Send',
      missingScopes: ['Mail.Send'],
      migrationState: 'authorization_required',
      recorded: true,
    });

    const response = await migrate();
    expect(response.status).toBe(409);
    const body = (await response.json()) as JsonBody & { missingScopes?: string[]; migrationState?: string };
    expect(body.code).toBe('PROVIDER_AUTH_REQUIRED');
    expect(body.missingScopes).toEqual(['Mail.Send']);
    expect(body.migrationState).toBe('authorization_required');
    // A refusal must not pretend to have switched anything.
    expect(imapManager.disconnectAccount).not.toHaveBeenCalled();
  });

  it('refuses an account that is not a Microsoft account', async () => {
    cutover.mockResolvedValue({ status: 'not_applicable', reason: 'This account is not a Microsoft account' });

    const response = await migrate();
    expect(response.status).toBe(409);
    expect(((await response.json()) as JsonBody).code).toBe('ACCOUNT_MIGRATION_NOT_APPLICABLE');
  });

  it('reports a missing account as 404', async () => {
    cutover.mockResolvedValue({ status: 'not_found' });
    expect((await migrate()).status).toBe(404);
  });
});

describe('POST /api/accounts/:id/reconnect and the native transport', () => {
  let server: Server;
  let base = '';

  beforeAll(async () => {
    await new Promise(resolve => {
      server = buildApp().listen(0, resolve);
    });
    base = `http://127.0.0.1:${listeningPort(server)}`;
  });

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  beforeEach(() => {
    query.mockReset();
    imapManager.connectAccount.mockClear();
  });

  it('never opens an IMAP session for a native account', async () => {
    query.mockResolvedValueOnce({ rows: [nativeAccount] });

    const response = await fetch(`${base}/api/accounts/${ACCOUNT_ID}/reconnect`, { method: 'POST' });
    expect(response.status).toBe(409);
    const body = (await response.json()) as JsonBody & { transport?: string };
    expect(body.code).toBe('PROVIDER_MANAGED_TRANSPORT');
    expect(body.transport).toBe('microsoft_graph');
    expect(imapManager.connectAccount).not.toHaveBeenCalled();
  });

  it('still reconnects an IMAP account', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, mail_transport: null, protocol: 'imap' }] });

    const response = await fetch(`${base}/api/accounts/${ACCOUNT_ID}/reconnect`, { method: 'POST' });
    expect(response.status).toBe(200);
    expect(imapManager.connectAccount).toHaveBeenCalledTimes(1);
    expect(imapManager.connectAccount.mock.calls[0][0]).toMatchObject({ id: ACCOUNT_ID });
  });
});

describe('GET /api/accounts exposes the transport and migration state', () => {
  let server: Server;
  let base = '';

  beforeAll(async () => {
    await new Promise(resolve => {
      server = buildApp().listen(0, resolve);
    });
    base = `http://127.0.0.1:${listeningPort(server)}`;
  });

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  beforeEach(() => {
    query.mockReset();
  });

  it('returns the fields the account card needs to tell the user what happened', async () => {
    // First call: the account list. Second: the alias lookup.
    query
      .mockResolvedValueOnce({ rows: [nativeAccount] })
      .mockResolvedValueOnce({ rows: [] });

    const response = await fetch(`${base}/api/accounts`);
    expect(response.status).toBe(200);
    const accounts = (await response.json()) as Array<Record<string, unknown>>;
    expect(accounts[0]?.mail_transport).toBe('microsoft_graph');
    expect(accounts[0]?.migration_state).toBe('active_native');
    expect(accounts[0]?.migration_required).toBe(false);
    // And no credential-shaped field rides along with them.
    expect(accounts[0]).not.toHaveProperty('auth_pass');
    expect(accounts[0]).not.toHaveProperty('oauth_refresh_token');
  });
});
