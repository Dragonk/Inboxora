import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listeningPort } from '../test/net.js';
import type { Server } from 'node:http';
import type { JsonBody } from '../test/json.js';

/**
 * `POST /api/accounts/native` — adding a **native** mailbox for an authorization the user already gave.
 *
 * The route is what lets the interface keep two ideas apart: Integrations configures the provider
 * application, Accounts connects mailboxes. These cases pin the contract the Add-account screen depends on:
 * the identity comes from the provider, an existing account is never duplicated (the migration is offered
 * instead), ownership is enforced, and nothing here touches the IMAP create path.
 */

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  createNative: vi.fn(),
  candidates: vi.fn(),
  readiness: vi.fn(),
}));

vi.mock('../services/db.js', () => ({ query: mocks.query, withTransaction: vi.fn(async (callback: (client: { query: typeof mocks.query }) => unknown) => callback({ query: mocks.query })) }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: { headers: Record<string, string>; session?: { userId?: string } }, _res: unknown, next: () => void) => {
    req.session = { userId: '11111111-1111-1111-1111-111111111111' };
    next();
  },
  requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../services/nativeAccountService.js', () => ({
  createNativeMailAccount: mocks.createNative,
  describeNativeCandidates: mocks.candidates,
  nativeProviderReadiness: mocks.readiness,
}));

vi.mock('../index.js', () => ({
  imapManager: { connectAccount: vi.fn(), disconnectAccount: vi.fn(), broadcast: vi.fn() },
}));
vi.mock('../services/rateLimiter.js', () => ({ consume: vi.fn(async () => ({ limited: false, resetMs: 0 })) }));
vi.mock('../services/connectionPolicy.js', () => ({
  getConnectionPolicy: vi.fn().mockResolvedValue({ allowPrivateHosts: false, allowInsecureTls: false, allowNonstandardPorts: false }),
}));
vi.mock('../services/providerSyncScheduler.js', () => ({
  runProviderSyncForHint: vi.fn(), providerSyncIntervalMinutes: vi.fn(() => 15), startProviderSyncScheduler: vi.fn(), stopProviderSyncScheduler: vi.fn(), listProviderSyncTargets: vi.fn(async () => []),
}));

import express from 'express';
import accountRoutes from './accounts.js';

let server: Server;
let base = '';

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.readiness.mockReturnValue({ microsoft: true, google: false });
  if (!server) {
    const app = express();
    app.use(express.json());
    app.use('/api/accounts', accountRoutes);
    await new Promise<void>((resolve, reject) => { server = app.listen(0, () => resolve()); server.once('error', reject); });
    base = `http://127.0.0.1:${listeningPort(server)}`;
  }
});

const add = (body: unknown) => fetch(`${base}/api/accounts/native`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('adding a native mailbox', () => {
  it('returns the created account, on the provider transport', async () => {
    mocks.createNative.mockResolvedValue({
      status: 'created',
      connectionId: 'connection-1',
      discovered: true,
      folders: 6,
      account: { id: 'account-1', email_address: 'user@outlook.com', mail_transport: 'microsoft_graph', protocol: 'microsoft_graph' },
    });

    const response = await add({ provider: 'microsoft' });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      ok: true, created: true, connectionId: 'connection-1', discovered: true, folders: 6,
    });
    // The identity came from the provider, so the route passes no address of its own.
    expect(mocks.createNative).toHaveBeenCalledWith(expect.objectContaining({ provider: 'microsoft' }));
    expect(mocks.createNative.mock.calls[0]?.[0]).not.toHaveProperty('email_address');
  });

  it('is idempotent for a mailbox that is already on this transport', async () => {
    mocks.createNative.mockResolvedValue({
      status: 'exists_native',
      connectionId: 'connection-1',
      account: { id: 'account-1', email_address: 'user@outlook.com', mail_transport: 'microsoft_graph' },
    });

    const response = await add({ provider: 'microsoft' });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, created: false });
  });

  it('offers the migration instead of duplicating a mailbox that exists over IMAP', async () => {
    mocks.createNative.mockResolvedValue({
      status: 'exists_other_transport',
      code: 'ACCOUNT_EXISTS',
      httpStatus: 409,
      message: 'user@gmail.com is already added as an IMAP/SMTP account.',
      existingAccountId: 'account-existing',
      existingTransport: 'imap_smtp',
      suggestion: 'migrate_google',
    });

    const response = await add({ provider: 'google' });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'ACCOUNT_EXISTS', existingAccountId: 'account-existing', existingTransport: 'imap_smtp', suggestion: 'migrate_google',
    });
  });

  it('refuses a connection that is not the caller’s', async () => {
    mocks.createNative.mockResolvedValue({
      status: 'refused', code: 'CONNECTION_NOT_FOUND', httpStatus: 404, message: 'That provider connection does not belong to this user',
    });

    const response = await add({ provider: 'microsoft', connectionId: '22222222-2222-2222-2222-222222222222' });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'CONNECTION_NOT_FOUND' });
  });

  it('refuses a missing authorization without pretending an account was made', async () => {
    mocks.createNative.mockResolvedValue({
      status: 'refused', code: 'PROVIDER_AUTH_REQUIRED', httpStatus: 409, message: 'No Microsoft authorization exists yet.',
    });

    const response = await add({ provider: 'microsoft' });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'PROVIDER_AUTH_REQUIRED' });
  });

  it('rejects an unknown provider and a malformed connection id before doing anything', async () => {
    expect((await add({ provider: 'imap' })).status).toBe(400);
    expect((await add({ provider: 'google', connectionId: 'not-a-uuid' })).status).toBe(400);
    expect(mocks.createNative).not.toHaveBeenCalled();
  });

  it('reports the authorized mailboxes and whether one is already an account', async () => {
    mocks.candidates.mockResolvedValue([
      { address: 'user@gmail.com', connectionId: 'connection-2', existingAccountId: 'account-existing', existingTransport: 'imap_smtp' },
    ]);

    const response = await fetch(`${base}/api/accounts/native/candidates?provider=google`);
    const body = await response.json() as JsonBody;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ provider: 'google', readiness: false });
    expect((body.candidates as JsonBody[])[0]).toMatchObject({ existingAccountId: 'account-existing', existingTransport: 'imap_smtp' });
  });
});
