import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { listeningPort } from '../test/net.js';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  transactionQuery: vi.fn(),
  withTransaction: vi.fn(),
  getCardavConfig: vi.fn(),
  listCardavConfigs: vi.fn(),
  scheduleCardavUser: vi.fn(),
  stopCardavUser: vi.fn(),
  syncUser: vi.fn(),
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: { session?: { userId?: string } }, _res: unknown, next: () => void) => {
    req.session = { userId: 'user-1' };
    next();
  },
}));
vi.mock('../services/db.js', () => ({ query: mocks.query, withTransaction: mocks.withTransaction }));
vi.mock('../services/encryption.js', () => ({ encrypt: (value: string) => value }));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn() }));
vi.mock('../services/connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
vi.mock('../services/carddavClient.js', () => ({ discoverAddressBooks: vi.fn() }));
vi.mock('../services/carddavSync.js', () => ({
  getCardavConfig: mocks.getCardavConfig,
  listCardavConfigs: mocks.listCardavConfigs,
  scheduleCardavUser: mocks.scheduleCardavUser,
  stopCardavUser: mocks.stopCardavUser,
  syncUser: mocks.syncUser,
}));

import express from 'express';
import carddavAccountRouter from './carddavAccount.js';

let server: Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/carddav', carddavAccountRouter);
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, () => resolve());
    server.once('error', reject);
  });
  base = `http://127.0.0.1:${listeningPort(server)}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getCardavConfig.mockResolvedValue({ serverUrl: 'https://b.example' });
  mocks.listCardavConfigs.mockResolvedValue([
    { id: 'source-a', label: null, config: { serverUrl: 'https://a.example' } },
    { id: 'source-b', label: 'B', config: { serverUrl: 'https://b.example' } },
  ]);
  mocks.query.mockResolvedValue({ rows: [] });
  mocks.transactionQuery.mockResolvedValue({ rows: [] });
  mocks.withTransaction.mockImplementation(async callback => callback({ query: mocks.transactionQuery }));
});

describe('DELETE /api/carddav legacy source cleanup', () => {
  const connectionId = '11111111-1111-4111-8111-111111111111';
  const bookId = '22222222-2222-4222-8222-222222222222';

  it('forgets an orphaned legacy CardDAV connection locally', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: connectionId, integration_id: null }] });

    const response = await fetch(
      `${base}/api/carddav/legacy/${encodeURIComponent(`carddav:connection:${connectionId}`)}`,
      { method: 'DELETE' },
    );

    expect(response.status).toBe(204);
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.withTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.transactionQuery).toHaveBeenCalledTimes(2);
    expect(String(mocks.transactionQuery.mock.calls[0]?.[0])).toContain("ab.source = 'carddav'");
    expect(mocks.transactionQuery.mock.calls[0]?.[1]).toEqual(['user-1', connectionId]);
    expect(String(mocks.transactionQuery.mock.calls[1]?.[0])).toContain('integration_id IS NULL');
    expect(mocks.transactionQuery.mock.calls[1]?.[1]).toEqual([connectionId, 'user-1']);
  });

  it('refuses to forget a current integration-backed CardDAV connection', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ id: connectionId, integration_id: '33333333-3333-4333-8333-333333333333' }],
    });

    const response = await fetch(
      `${base}/api/carddav/legacy/${encodeURIComponent(`carddav:connection:${connectionId}`)}`,
      { method: 'DELETE' },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'CURRENT_SOURCE' });
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it('forgets an ownerless legacy CardDAV book only by exact book id', async () => {
    mocks.query
      .mockResolvedValueOnce({
        rows: [{ id: bookId, source_connection_id: null, linked: false }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const response = await fetch(
      `${base}/api/carddav/legacy/${encodeURIComponent(`carddav:book:${bookId}`)}`,
      { method: 'DELETE' },
    );

    expect(response.status).toBe(204);
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(String(mocks.query.mock.calls[1]?.[0])).toContain("source = 'carddav'");
    expect(mocks.query.mock.calls[1]?.[1]).toEqual([bookId, 'user-1']);
  });

  it('refuses a legacy book that is still linked to a source', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ id: bookId, source_connection_id: connectionId, linked: true }],
    });

    const response = await fetch(
      `${base}/api/carddav/legacy/${encodeURIComponent(`carddav:book:${bookId}`)}`,
      { method: 'DELETE' },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'CURRENT_SOURCE' });
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed legacy source identities', async () => {
    const response = await fetch(`${base}/api/carddav/legacy/not-a-source`, {
      method: 'DELETE',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'INVALID_LEGACY_SOURCE' });
    expect(mocks.query).not.toHaveBeenCalled();
  });
});


describe('DELETE /api/carddav source isolation', () => {
  it('disconnects only the requested source and its linked address books', async () => {
    const response = await fetch(`${base}/api/carddav/`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceId: 'source-b' }),
    });

    expect(response.status).toBe(200);
    expect(mocks.stopCardavUser).toHaveBeenCalledWith('source-b');
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(String(mocks.query.mock.calls[0]?.[0])).toContain('sc.integration_id = $2');
    expect(mocks.query.mock.calls[0]?.[1]).toEqual(['user-1', 'source-b']);
    expect(mocks.query.mock.calls[1]).toEqual([
      'DELETE FROM user_integrations WHERE id = $1 AND user_id = $2 AND provider = \'carddav\'',
      ['source-b', 'user-1'],
    ]);
  });
});
