import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import session from 'express-session';
import type { Server } from 'node:http';
import type { DbQueryResult } from '../services/db.js';
import { listeningPort } from '../test/net.js';

// The /status capability endpoint (#315) must be reachable by any authenticated user,
// NOT just admins: a non-admin needs to learn that Microsoft OAuth is configured so the
// connect buttons enable, without ever seeing the credentials. These tests mount the real
// integrations router with a requireAdmin stub that ALWAYS rejects, proving /status does
// not sit behind the admin gate while GET / still does. db/encryption are stubbed since the
// status route touches neither.
async function query<T>(_text: string, _params: unknown[] = []): Promise<DbQueryResult<T>> {
  return { rows: [] };
}

function encrypt(value: string): string {
  return value;
}

function decrypt(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function isEncrypted(_value: unknown): boolean {
  return false;
}

vi.mock('../services/db.js', () => ({ query }));
vi.mock('../services/encryption.js', () => ({ encrypt, decrypt, isEncrypted }));
vi.mock('../middleware/auth.js', () => ({
  // Authenticated, but deliberately NOT an admin — requireAdmin always 403s here.
  requireAuth: (req: Request, _res: Response, next: NextFunction): void => {
    req.session.userId = 'u1';
    next();
  },
  requireAdmin: (_req: Request, res: Response, _next: NextFunction): Response => res.status(403).json({ error: 'Admin access required' }),
}));

import 'express-async-errors';
import integrationsRoutes from './integrations.js';

interface ProviderReadiness {
  configured: boolean;
  enabled: boolean;
  mailPolicy: string;
  browser: { ready: boolean; missing: string[] };
  deviceCode: { supported: boolean; ready: boolean; reason?: string };
}

interface IntegrationStatus {
  microsoft: ProviderReadiness;
  google: ProviderReadiness & { traditionalImapAvailableInInboxora: boolean };
}

function isReadiness(value: unknown): value is ProviderReadiness {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const browser = candidate.browser as Record<string, unknown> | undefined;
  const deviceCode = candidate.deviceCode as Record<string, unknown> | undefined;
  return typeof candidate.configured === 'boolean'
    && typeof candidate.enabled === 'boolean'
    && typeof candidate.mailPolicy === 'string'
    && typeof browser === 'object' && browser !== null
    && typeof browser.ready === 'boolean' && Array.isArray(browser.missing)
    && typeof deviceCode === 'object' && deviceCode !== null
    && typeof deviceCode.supported === 'boolean' && typeof deviceCode.ready === 'boolean';
}

function isIntegrationStatus(value: unknown): value is IntegrationStatus {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return isReadiness(candidate.microsoft) && isReadiness(candidate.google);
}

async function integrationStatusBody(response: globalThis.Response): Promise<IntegrationStatus> {
  const body: unknown = await response.json();
  if (!isIntegrationStatus(body)) {
    throw new Error('Integration status response has an invalid shape');
  }
  return body;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-session-secret', resave: false, saveUninitialized: true }));
  app.use('/api/integrations', integrationsRoutes);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    void err;
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => {
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

let server: Server | undefined;
let base: string | undefined;
const PROVIDER_ENV_KEYS = [
  'MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'MS_REDIRECT_URI',
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI',
] as const;
const originalProviderEnv = new Map(PROVIDER_ENV_KEYS.map(key => [key, process.env[key]]));

function clearProviderEnv() {
  for (const key of PROVIDER_ENV_KEYS) delete process.env[key];
}

function integrationBase(): string {
  if (base === undefined) throw new Error('Integration test server has not started');
  return base;
}

beforeAll(async () => {
  const app = buildApp();
  server = await new Promise<Server>((resolve, reject) => {
    const listeningServer = app.listen(0);
    listeningServer.once('listening', () => resolve(listeningServer));
    listeningServer.once('error', reject);
  });
  base = `http://127.0.0.1:${listeningPort(server)}`;
});

afterAll(async () => {
  if (server !== undefined) await closeServer(server);
  for (const key of PROVIDER_ENV_KEYS) {
    const value = originalProviderEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

afterEach(() => { clearProviderEnv(); });

describe('GET /api/integrations/status (non-admin capability check)', () => {
  it('is reachable by a non-admin and reports Microsoft device readiness from a Client ID alone', async () => {
    process.env.MS_CLIENT_ID = 'some-client-id';
    const res = await fetch(`${integrationBase()}/api/integrations/status`);
    expect(res.status).toBe(200);
    const body = await integrationStatusBody(res);
    expect(body.microsoft.configured).toBe(true);
    expect(body.microsoft.enabled).toBe(true);
    // Device code needs no redirect URI and no secret; web does.
    expect(body.microsoft.deviceCode).toMatchObject({ supported: true, ready: true });
    expect(body.microsoft.browser.ready).toBe(false);
    expect(body.microsoft.browser.missing).toEqual(['clientSecret', 'redirectUri']);
    expect(body.microsoft.mailPolicy).toBe('required');
  });

  it('reports Microsoft web readiness only once every web field is present', async () => {
    process.env.MS_CLIENT_ID = 'some-client-id';
    process.env.MS_CLIENT_SECRET = 'some-secret';
    process.env.MS_REDIRECT_URI = 'https://inboxora.example/oauth/microsoft/callback';
    const body = await integrationStatusBody(await fetch(`${integrationBase()}/api/integrations/status`));
    expect(body.microsoft.browser).toEqual({ ready: true, missing: [] });
  });

  it('reports configured=false when MS_CLIENT_ID is unset', async () => {
    const res = await fetch(`${integrationBase()}/api/integrations/status`);
    expect(res.status).toBe(200);
    const body = await integrationStatusBody(res);
    expect(body.microsoft.configured).toBe(false);
    expect(body.microsoft.enabled).toBe(false);
    expect(body.microsoft.browser.ready).toBe(false);
    expect(body.microsoft.deviceCode).toMatchObject({ supported: true, ready: false, reason: 'missing_client_id' });
  });

  it('never advertises a Google device-code flow and keeps IMAP/SMTP available', async () => {
    const body = await integrationStatusBody(await fetch(`${integrationBase()}/api/integrations/status`));
    expect(body.google.mailPolicy).toBe('recommended');
    expect(body.google.traditionalImapAvailableInInboxora).toBe(true);
    expect(body.google.deviceCode).toEqual({ supported: false, ready: false, reason: 'not_supported' });
    expect(body.google.browser.ready).toBe(false);
    expect(body.google.browser.missing).toEqual(['clientId', 'clientSecret', 'redirectUri']);
  });

  it('reports Google browser readiness once the web fields are present', async () => {
    process.env.GOOGLE_CLIENT_ID = 'google-client';
    process.env.GOOGLE_CLIENT_SECRET = 'google-secret';
    process.env.GOOGLE_REDIRECT_URI = 'https://inboxora.example/oauth/google/callback';
    try {
      const body = await integrationStatusBody(await fetch(`${integrationBase()}/api/integrations/status`));
      expect(body.google.browser).toEqual({ ready: true, missing: [] });
      expect(body.microsoft.configured).toBe(false);
    } finally {
      delete process.env.GOOGLE_CLIENT_ID;
      delete process.env.GOOGLE_CLIENT_SECRET;
      delete process.env.GOOGLE_REDIRECT_URI;
    }
  });

  it('never leaks credentials in the response', async () => {
    process.env.MS_CLIENT_ID = 'super-secret-client-id';
    process.env.MS_CLIENT_SECRET = 'super-secret-value';
    try {
      const res = await fetch(`${integrationBase()}/api/integrations/status`);
      const body = await res.text();
      expect(body).not.toContain('super-secret-client-id');
      expect(body).not.toContain('super-secret-value');
    } finally {
      delete process.env.MS_CLIENT_SECRET;
    }
  });
});

describe('GET /api/integrations (config read) stays admin-only', () => {
  it('is rejected with 403 for a non-admin', async () => {
    const res = await fetch(`${integrationBase()}/api/integrations`);
    expect(res.status).toBe(403);
  });
});
