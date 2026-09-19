import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { listeningPort } from '../test/net.js';

const mocks = vi.hoisted(() => ({ query: vi.fn(), syncGraphContacts: vi.fn(), configured: { value: true }, browserReady: { value: true } }));

vi.mock('../services/db.js', () => ({
  query: mocks.query,
  withTransaction: async (fn: (client: { query: typeof mocks.query }) => unknown) => fn({ query: mocks.query }),
}));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: { session?: { userId?: string } }, _res: unknown, next: () => void) => {
    req.session = { userId: 'user-1' };
    next();
  },
}));
// Keep every real export and override only what this suite needs.
vi.mock('../services/providerAuthService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/providerAuthService.js')>()),
  microsoftConfigFromEnv: () => ({ clientId: 'client-1', clientSecret: 'secret-1', redirectUri: 'https://x/cb', tenantId: 'common' }),
  isMicrosoftConfigured: () => mocks.configured.value,
  // The status flag is stricter than refresh readiness: it gates a "connect" hint.
  isMicrosoftBrowserFlowReady: () => mocks.browserReady.value,
}));
vi.mock('../services/providers/microsoft/graphContactsSync.js', () => ({ syncGraphContacts: mocks.syncGraphContacts }));

import contactsRouter from './contacts.js';
import { GraphApiError } from '../services/providers/microsoft/graphApiClient.js';

let server: Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/contacts', contactsRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  base = `http://127.0.0.1:${listeningPort(server)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  mocks.configured.value = true;
  mocks.browserReady.value = true;
  mocks.query.mockReset();
  mocks.syncGraphContacts.mockReset();
});

const status = () => fetch(`${base}/api/contacts/providers/microsoft/status`);
const sync = () => fetch(`${base}/api/contacts/providers/microsoft/sync`, { method: 'POST' });

describe('Microsoft contacts connector routes', () => {
  it('scopes the reported books to the Microsoft connections', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: 'connection-1' }] })
      .mockResolvedValueOnce({ rows: [{
        connection_id: 'connection-1', address_book_id: 'book-1', name: 'Microsoft Contacts',
        contact_count: 7, last_success_at: '2026-09-14T10:00:00.000Z', last_error_code: null, last_error_at: null,
      }] });

    const response = await status();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      configured: true,
      connected: true,
      connections: 1,
      books: [{
        connectionId: 'connection-1', addressBookId: 'book-1', name: 'Microsoft Contacts',
        contactCount: 7, lastSyncedAt: '2026-09-14T10:00:00.000Z', lastErrorCode: null, lastErrorAt: null,
      }],
    });
    const [connectionSql, connectionParams] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(connectionSql).toContain("provider = 'microsoft'");
    expect(connectionParams).toEqual(['user-1']);
    // A Google book must never be reported by the Microsoft connector (and vice versa).
    const [bookSql, bookParams] = mocks.query.mock.calls[1] as [string, unknown[]];
    expect(bookSql).toContain("pc.provider = 'microsoft'");
    expect(bookSql).toContain('ic.user_id = $1');
    expect(bookParams).toEqual(['user-1']);
  });

  it('reports not connected when the user has no Microsoft connection', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    expect(await (await status()).json()).toEqual({ configured: true, connected: false, connections: 0, books: [] });
  });

  it('asks the user to connect an account when there is no Microsoft connection', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    const response = await sync();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Connect a Microsoft account before syncing contacts' });
    expect(mocks.syncGraphContacts).not.toHaveBeenCalled();
  });

  it('reports missing administrator configuration instead of attempting the sync', async () => {
    mocks.configured.value = false;
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'connection-1' }] });
    const response = await sync();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Microsoft API is not configured by the administrator' });
    expect(mocks.syncGraphContacts).not.toHaveBeenCalled();
  });

  it('returns a per-connection result without hiding one failure behind another', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'connection-1' }, { id: 'connection-2' }] });
    mocks.syncGraphContacts
      .mockResolvedValueOnce({ addressBookId: 'book-1', created: 4, updated: 1, deleted: 0, skipped: 0, fullSync: true, cursor: 'delta-1' })
      .mockRejectedValueOnce(new GraphApiError({ code: 'PROVIDER_AUTH_REQUIRED', message: 'Invalid authentication token', status: 401 }));

    const response = await sync();
    expect(response.status).toBe(200);
    const body = await response.json() as { results: Array<Record<string, unknown>> };
    expect(body.results[0]).toMatchObject({ connectionId: 'connection-1', created: 4, fullSync: true });
    expect(body.results[1]).toEqual({
      connectionId: 'connection-2',
      error: { code: 'PROVIDER_AUTH_REQUIRED', message: 'Invalid authentication token', retryable: false },
    });
  });
});

describe('Microsoft connector readiness', () => {
  it('does not offer the connection when only a client id exists', async () => {
    // A public client can refresh a token but cannot run the browser flow, so a status
    // that said "configured" here would send the user into a flow that fails at Microsoft.
    mocks.browserReady.value = false;
    mocks.query.mockResolvedValue({ rows: [] });
    expect(await (await status()).json()).toMatchObject({ configured: false });
  });

  it('still allows syncing when a client id exists but the browser flow is not ready', async () => {
    // Refreshing a stored grant needs no secret; only the connect action does.
    mocks.browserReady.value = false;
    mocks.configured.value = true;
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'connection-1' }] });
    mocks.syncGraphContacts.mockResolvedValueOnce({ addressBookId: 'book-1', created: 1, updated: 0, deleted: 0, skipped: 0, fullSync: true, cursor: 'delta-1' });

    const response = await sync();
    expect(response.status).toBe(200);
    expect((await response.json() as { results: Array<Record<string, unknown>> }).results[0]).toMatchObject({ created: 1 });
  });
});
