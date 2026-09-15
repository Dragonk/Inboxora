import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { listeningPort } from '../test/net.js';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('../services/db.js', () => ({ query: mocks.query }));
vi.mock('../services/encryption.js', () => ({
  encrypt: (value: string) => `encrypted:${value}`,
  decrypt: (value: unknown) => typeof value === 'string' ? value.replace(/^encrypted:/, '') : null,
  isEncrypted: (value: unknown) => typeof value === 'string' && value.startsWith('encrypted:'),
}));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: { session: { userId?: string } }, _res: unknown, next: () => void) => {
    req.session = { userId: 'user-1' };
    next();
  },
  requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import integrationsRoutes, { loadIntegrationConfigs } from './integrations.js';

type MicrosoftConfig = Record<string, unknown>;
const MS_ENV_KEYS = ['MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'MS_TENANT_ID', 'MS_REDIRECT_URI'] as const;
const originalEnv = new Map(MS_ENV_KEYS.map((key) => [key, process.env[key]]));
let savedMicrosoftConfig: MicrosoftConfig | null = null;
let server: Server;
let base = '';

function clearMicrosoftEnv() {
  for (const key of MS_ENV_KEYS) delete process.env[key];
}

function expectPartialSnapshot() {
  expect(process.env.MS_CLIENT_ID).toBe('partial-client');
  expect(process.env.MS_CLIENT_SECRET).toBeUndefined();
  expect(process.env.MS_TENANT_ID).toBeUndefined();
  expect(process.env.MS_REDIRECT_URI).toBeUndefined();
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/integrations', integrationsRoutes);
  server = await new Promise<Server>((resolve, reject) => {
    const candidate = app.listen(0);
    candidate.once('listening', () => resolve(candidate));
    candidate.once('error', reject);
  });
  base = `http://127.0.0.1:${listeningPort(server)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  for (const key of MS_ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  savedMicrosoftConfig = null;
  clearMicrosoftEnv();
  mocks.query.mockReset();
  mocks.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (/INSERT INTO integration_config/i.test(sql)) {
      savedMicrosoftConfig = params[1] as MicrosoftConfig;
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT provider, config FROM integration_config/i.test(sql)) {
      return { rows: savedMicrosoftConfig === null ? [] : [{ provider: 'microsoft', config: savedMicrosoftConfig }] };
    }
    if (/SELECT config FROM integration_config WHERE provider/i.test(sql)) {
      return { rows: savedMicrosoftConfig === null ? [] : [{ config: savedMicrosoftConfig }] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
});

afterEach(() => clearMicrosoftEnv());

describe('partial Microsoft integration configuration', () => {
  it('uses the saved row as the exact runtime and restart snapshot', async () => {
    process.env.MS_CLIENT_ID = 'previous-client';
    process.env.MS_CLIENT_SECRET = 'previous-secret';
    process.env.MS_TENANT_ID = 'previous-tenant';
    process.env.MS_REDIRECT_URI = 'https://previous.example/callback';

    const response = await fetch(`${base}/api/integrations/microsoft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'partial-client' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expectPartialSnapshot();

    // A restart may begin with unrelated environment values, but loading the same
    // partial DB row must produce exactly the runtime state above.
    process.env.MS_CLIENT_ID = 'restart-client';
    process.env.MS_CLIENT_SECRET = 'restart-secret';
    process.env.MS_TENANT_ID = 'restart-tenant';
    process.env.MS_REDIRECT_URI = 'https://restart.example/callback';
    await loadIntegrationConfigs();
    expectPartialSnapshot();
  });
});
