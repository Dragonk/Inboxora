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
vi.mock('../services/providerAuthService.js', () => ({
  googleConfigFromEnv: () => ({ clientId: 'client-1', clientSecret: 'secret-1', redirectUri: 'https://inboxora.example/oauth/google/callback' }),
  isGoogleConfigured: () => mocks.configured.value,
}));
vi.mock('../services/providers/google/googleContactsSync.js', () => ({
  syncGoogleContacts: mocks.syncGoogleContacts,
}));

import contactsRouter from './contacts.js';
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
