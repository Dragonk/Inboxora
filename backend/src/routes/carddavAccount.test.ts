import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { listeningPort } from '../test/net.js';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
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
vi.mock('../services/db.js', () => ({ query: mocks.query }));
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
