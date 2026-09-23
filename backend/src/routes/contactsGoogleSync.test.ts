import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { listeningPort } from '../test/net.js';

const mocks = vi.hoisted(() => ({ query: vi.fn(), syncGoogleContacts: vi.fn(), configured: { value: true } }));

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
// Keep every real export and override only what this suite needs: the routers pull
// the token service in transitively, so a narrower mock breaks module evaluation.
vi.mock('../services/providerAuthService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/providerAuthService.js')>()),
  googleConfigFromEnv: () => ({ clientId: 'client-1', clientSecret: 'secret-1', redirectUri: 'https://inboxora.example/oauth/google/callback' }),
  isGoogleConfigured: () => mocks.configured.value,
}));
vi.mock('../services/providers/google/googleContactsSync.js', () => ({
  syncGoogleContacts: mocks.syncGoogleContacts,
}));
vi.mock('../services/accountProviderFeatureSettings.js', () => ({
  providerConnectionFeatureEnabled: vi.fn(async () => true),
}));

import contactsRouter from './contacts.js';
// The preflight and the failure describer read the grant and the account; this suite is about the route's
// per-connection fan-out, so they answer directly rather than through the database mock.
vi.mock('../services/providerSyncDiagnostics.js', () => ({
  providerSyncPreflight: vi.fn(async () => null),
  describeProviderSyncFailure: vi.fn(async (input: { connectionId: string; feature: string; caught: unknown }) => {
    const failure = input.caught as { code?: string; message?: string } | null;
    return {
      connectionId: input.connectionId,
      accountId: null,
      feature: input.feature,
      code: failure?.code ?? 'PROVIDER_ERROR',
      providerStatus: null,
      message: failure?.message ?? 'failed',
      retryable: false,
    };
  }),
}));

import { GoogleApiError } from '../services/providers/google/googleApiClient.js';

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
  mocks.query.mockReset();
  mocks.syncGoogleContacts.mockReset();
});

const sync = () => fetch(`${base}/api/contacts/providers/google/sync`, { method: 'POST' });
const status = () => fetch(`${base}/api/contacts/providers/google/status`);

describe('GET /api/contacts/providers/google/status', () => {
  it('reports readiness, the connection count and per-book progress without secrets', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: 'connection-1' }] })
      .mockResolvedValueOnce({ rows: [{
        connection_id: 'connection-1', address_book_id: 'book-1', name: 'Google Contacts',
        contact_count: 12, last_success_at: '2026-09-14T10:00:00.000Z', last_error_code: null, last_error_at: null,
      }] });

    const response = await status();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      configured: true,
      connected: true,
      connections: 1,
      books: [{
        connectionId: 'connection-1', addressBookId: 'book-1', name: 'Google Contacts',
        contactCount: 12, lastSyncedAt: '2026-09-14T10:00:00.000Z', lastErrorCode: null, lastErrorAt: null,
      }],
    });
    // The status reads only counts/timestamps and the caller's own connections.
    const [connectionSql, connectionParams] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(connectionSql).toContain("provider = 'google'");
    expect(connectionParams).toEqual(['user-1']);
    const [bookSql, bookParams] = mocks.query.mock.calls[1] as [string, unknown[]];
    // Scoped to the Google connections, so a Microsoft book is never reported here.
    expect(bookSql).toContain("pc.provider = 'google'");
    expect(bookSql).toContain('ic.user_id = $1');
    expect(bookParams).toEqual(['user-1']);
  });

  it('reports not connected when the user has no Google connection', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    expect(await (await status()).json()).toEqual({ configured: true, connected: false, connections: 0, books: [] });
  });
});

describe('POST /api/contacts/providers/google/sync', () => {
  it('asks the user to connect an account when there is no Google connection', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    const response = await sync();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Connect a Google account before syncing contacts' });
    expect(mocks.syncGoogleContacts).not.toHaveBeenCalled();
  });

  it('reports missing administrator configuration instead of attempting the sync', async () => {
    mocks.configured.value = false;
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'connection-1' }] });
    const response = await sync();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Google API is not configured by the administrator' });
    expect(mocks.syncGoogleContacts).not.toHaveBeenCalled();
  });

  it('returns a per-connection result and does not hide one failure behind another', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'connection-1' }, { id: 'connection-2' }] });
    mocks.syncGoogleContacts
      .mockResolvedValueOnce({ addressBookId: 'book-1', created: 3, updated: 0, deleted: 0, skipped: 0, fullSync: true, cursor: 'sync-1' })
      .mockRejectedValueOnce(new GoogleApiError({ code: 'PROVIDER_AUTH_REQUIRED', message: 'Invalid Credentials', status: 401 }));

    const response = await sync();
    expect(response.status).toBe(200);
    const body = await response.json() as { results: Array<Record<string, unknown>> };
    expect(body.results).toHaveLength(2);
    expect(body.results[0]).toMatchObject({ connectionId: 'connection-1', created: 3, fullSync: true, cursor: 'sync-1' });
    expect(body.results[1]).toEqual({
      connectionId: 'connection-2',
      error: { code: 'PROVIDER_AUTH_REQUIRED', message: 'Invalid Credentials', retryable: false },
    });
    // Only the signed-in user's active Google connections are considered.
    const [sql, params] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("provider = 'google'");
    expect(sql).toContain("status = 'active'");
    expect(params).toEqual(['user-1']);
  });
});
