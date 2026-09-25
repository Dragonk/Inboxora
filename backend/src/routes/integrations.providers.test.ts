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

type StoredConfig = Record<string, unknown>;
const storedConfigs = new Map<string, StoredConfig>();

const PROVIDER_ENV_KEYS = [
  'MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'MS_TENANT_ID', 'MS_REDIRECT_URI',
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI',
] as const;
const originalEnv = new Map(PROVIDER_ENV_KEYS.map(key => [key, process.env[key]]));

let server: Server;
let base = '';

function clearProviderEnv() {
  for (const key of PROVIDER_ENV_KEYS) delete process.env[key];
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
  for (const key of PROVIDER_ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  storedConfigs.clear();
  clearProviderEnv();
  mocks.query.mockReset();
  mocks.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (/INSERT INTO integration_config/i.test(sql)) {
      storedConfigs.set(String(params[0]), params[1] as StoredConfig);
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT provider, config(, updated_at)? FROM integration_config/i.test(sql)) {
      return { rows: [...storedConfigs].map(([provider, config]) => ({ provider, config, updated_at: new Date() })) };
    }
    if (/SELECT config FROM integration_config WHERE provider/i.test(sql)) {
      const config = storedConfigs.get(String(params[0]));
      return { rows: config === undefined ? [] : [{ config }] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
});

afterEach(() => clearProviderEnv());

async function save(provider: string, body: unknown): Promise<globalThis.Response> {
  return fetch(`${base}/api/integrations/${provider}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('Google provider configuration', () => {
  it('stores the secret encrypted, returns only the mask and applies the exact snapshot', async () => {
    process.env.GOOGLE_CLIENT_SECRET = 'stale-from-env';
    const res = await save('google', {
      clientId: 'google-client',
      clientSecret: 'google-secret',
      redirectUri: 'https://inboxora.example/oauth/google/callback',
    });
    expect(res.status).toBe(200);

    expect(storedConfigs.get('google')?.clientSecret).toBe('encrypted:google-secret');
    expect(process.env.GOOGLE_CLIENT_ID).toBe('google-client');
    expect(process.env.GOOGLE_CLIENT_SECRET).toBe('google-secret');
    expect(process.env.GOOGLE_REDIRECT_URI).toBe('https://inboxora.example/oauth/google/callback');

    const read = await fetch(`${base}/api/integrations`);
    const body = await read.json() as Record<string, StoredConfig>;
    expect(body.google.clientSecret).toBe('••••••••');
    expect(JSON.stringify(body)).not.toContain('google-secret');
  });

  it('preserves an existing secret when the edit omits it and never stores the sentinel', async () => {
    storedConfigs.set('google', { clientId: 'old-client', clientSecret: 'encrypted:old-secret' });
    const res = await save('google', { clientId: 'new-client', clientSecret: '••••••••', redirectUri: 'https://x/cb' });
    expect(res.status).toBe(200);
    expect(storedConfigs.get('google')?.clientSecret).toBe('encrypted:old-secret');
    expect(process.env.GOOGLE_CLIENT_SECRET).toBe('old-secret');
  });

  it('preserves an existing secret when the field is absent and clears it only explicitly', async () => {
    storedConfigs.set('google', { clientId: 'old-client', clientSecret: 'encrypted:old-secret' });
    await save('google', { clientId: 'old-client' });
    expect(storedConfigs.get('google')?.clientSecret).toBe('encrypted:old-secret');

    await save('google', { clientId: 'old-client', clientSecretClear: true });
    expect(storedConfigs.get('google')?.clientSecret).toBeUndefined();
    expect(process.env.GOOGLE_CLIENT_SECRET).toBeUndefined();
  });

  it('rejects an unknown provider without writing anything', async () => {
    const res = await save('yahoo', { clientId: 'x' });
    expect(res.status).toBe(400);
    expect(storedConfigs.size).toBe(0);
  });

  it('rejects Microsoft-only fields on the Google schema', async () => {
    for (const body of [{ tenantId: 'common' }, { deviceEnabled: true }]) {
      const res = await save('google', body);
      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error).toMatch(/Unknown field/);
    }
    expect(storedConfigs.size).toBe(0);
  });

  it('rejects wrong types and oversized values before writing', async () => {
    for (const body of [{ clientId: 42 }, { clientSecret: 'x'.repeat(9000) }, { apiEnabled: 'yes' }, {}]) {
      const candidate = body as Record<string, unknown>;
      if (Object.keys(candidate).length === 0) candidate.redirectUri = 7;
      const res = await save('google', candidate);
      expect(res.status).toBe(400);
    }
    expect(storedConfigs.size).toBe(0);
  });

  it('treats a non-object payload as invalid', async () => {
    const res = await fetch(`${base}/api/integrations/google`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '"nope"',
    });
    expect(res.status).toBe(400);
  });
});

describe('provider disable tombstone', () => {
  it('deleting a provider writes a tombstone and clears the env so a restart cannot resurrect it', async () => {
    process.env.GOOGLE_CLIENT_ID = 'env-client';
    process.env.GOOGLE_CLIENT_SECRET = 'env-secret';
    process.env.GOOGLE_REDIRECT_URI = 'https://env/cb';

    const res = await fetch(`${base}/api/integrations/google`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(storedConfigs.get('google')).toMatchObject({ disabled: true });
    expect(process.env.GOOGLE_CLIENT_ID).toBeUndefined();
    expect(process.env.GOOGLE_CLIENT_SECRET).toBeUndefined();

    // A restart with the previous .env values must not bring the provider back.
    process.env.GOOGLE_CLIENT_ID = 'env-client';
    process.env.GOOGLE_CLIENT_SECRET = 'env-secret';
    process.env.GOOGLE_REDIRECT_URI = 'https://env/cb';
    await loadIntegrationConfigs();
    expect(process.env.GOOGLE_CLIENT_ID).toBeUndefined();
    expect(process.env.GOOGLE_CLIENT_SECRET).toBeUndefined();
    expect(process.env.GOOGLE_REDIRECT_URI).toBeUndefined();
  });

  it('an explicit enabled:false disables the provider, and a later save re-enables it', async () => {
    await save('google', { clientId: 'c', clientSecret: 's', redirectUri: 'https://x/cb', enabled: false });
    expect(storedConfigs.get('google')).toMatchObject({ disabled: true });
    expect(process.env.GOOGLE_CLIENT_ID).toBeUndefined();

    await save('google', { clientId: 'c2', clientSecret: 's2', redirectUri: 'https://x/cb' });
    expect(storedConfigs.get('google')).toMatchObject({ clientId: 'c2', disabled: false });
    expect(process.env.GOOGLE_CLIENT_ID).toBe('c2');
  });

describe('a provider configuration can be tested, not just reported ready', () => {
  it('says the credentials are accepted when the provider refuses only the grant', async () => {
    storedConfigs.set('google', { clientId: 'client-1', clientSecret: 'encrypted:secret-1', redirectUri: 'https://x/cb' });
    const realFetch = globalThis.fetch;
    const seen: string[] = [];
    // The suite talks to its own server, so only the provider call is faked.
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (String(url).startsWith(base)) return realFetch(url, init);
      seen.push(`${String(url)}|${String(init?.body)}`);
      return { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) } as Response;
    });

    const response = await realFetch(`${base}/api/integrations/google/test`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
    });
    const body = await response.json() as { ok: boolean; code: string };
    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, code: 'CREDENTIALS_ACCEPTED' });
    // The stored secret was actually used, and it is not part of the answer.
    expect(seen[0]).toContain('client_secret=secret-1');
    expect(JSON.stringify(body)).not.toContain('secret-1');
    vi.unstubAllGlobals();
  });

  it('says the credentials are wrong when the provider refuses the client', async () => {
    storedConfigs.set('google', { clientId: 'client-2', clientSecret: 'encrypted:wrong', redirectUri: 'https://x/cb' });
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (String(url).startsWith(base)) return realFetch(url, init);
      return { ok: false, status: 401, json: async () => ({ error: 'invalid_client' }) } as Response;
    });

    const response = await realFetch(`${base}/api/integrations/google/test`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
    });
    expect(await response.json()).toEqual({ ok: false, code: 'invalid_client' });
    vi.unstubAllGlobals();
  });
});
});
