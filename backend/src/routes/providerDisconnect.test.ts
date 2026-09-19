import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { listeningPort } from '../test/net.js';

const mocks = vi.hoisted(() => ({ query: vi.fn(), sessionUserId: { value: 'user-1' as string | null } }));

vi.mock('../services/db.js', () => ({
  query: mocks.query,
  withTransaction: async (fn: (client: { query: typeof mocks.query }) => unknown) => fn({ query: mocks.query }),
}));
vi.mock('../middleware/auth.js', () => ({
  // Mirrors the real middleware: it authenticates from the session, so a test that clears the
  // session must not be given one back.
  requireAuth: (req: { session?: { userId?: string } }, _res: unknown, next: () => void) => {
    const userId = mocks.sessionUserId.value;
    req.session = userId ? { userId } : {};
    next();
  },
  requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import integrationsRouter from './integrations.js';

let server: Server;
let base = '';
let sessionUserId: string | null = 'user-1';
const setSession = (value: string | null) => { sessionUserId = value; mocks.sessionUserId.value = value; };

const queryCallsMatching = (fragment: string): unknown[][] =>
  mocks.query.mock.calls.filter(([sql]) => String(sql).includes(fragment));

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as unknown as { session: { userId: string | null } }).session = { userId: sessionUserId }; next(); });
  app.use('/api/integrations', integrationsRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  base = `http://127.0.0.1:${listeningPort(server)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  setSession('user-1');
  mocks.query.mockReset();
  mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

const disconnect = (id = 'connection-1') =>
  fetch(`${base}/api/integrations/provider-connections/${id}/disconnect`, { method: 'POST' });

describe('POST /api/integrations/provider-connections/:id/disconnect', () => {
  it('revokes the grant, clears the stored tokens and stops the collections refreshing', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: 'connection-1' }] }) // owned
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })          // grant revoked
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })          // connection status
      .mockResolvedValueOnce({ rows: [], rowCount: 2 });         // collections disabled

    const response = await disconnect();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ connectionId: 'connection-1', collectionsDisabled: 2 });

    const [grantSql] = queryCallsMatching('UPDATE oauth_grants')[0] as [string];
    expect(grantSql).toContain("status = 'revoked'");
    // A revoked grant has no use for tokens, and a stored refresh token is the thing worth
    // not keeping.
    expect(grantSql).toContain('access_token_encrypted = NULL');
    expect(grantSql).toContain('refresh_token_encrypted = NULL');
    expect(queryCallsMatching('UPDATE provider_connections')[0]?.[0]).toContain("status = 'revoked'");
    // The schedule selects enabled collections, so this is what stops the refresh.
    expect(String(queryCallsMatching('UPDATE integration_collections')[0]?.[0])).toContain('enabled = false');
    // Nothing imported is deleted: the data stays the user's, and removing it is a separate
    // decision rather than a side effect of disconnecting.
    expect(mocks.query.mock.calls.some(([sql]) => /DELETE FROM (contacts|calendars|calendar_events|address_books)/.test(String(sql)))).toBe(false);
  });

  it('refuses a connection belonging to somebody else, touching nothing', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    const response = await disconnect('someone-elses');
    expect(response.status).toBe(404);
    expect(queryCallsMatching('UPDATE oauth_grants')).toHaveLength(0);
    const [ownershipSql, params] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(ownershipSql).toContain('user_id = $2');
    expect(params).toEqual(['someone-elses', 'user-1']);
  });

  it('requires a session', async () => {
    setSession(null);
    expect((await disconnect()).status).toBe(401);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
