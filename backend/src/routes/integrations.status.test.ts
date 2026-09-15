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

interface IntegrationStatus {
  microsoft: {
    configured: boolean;
  };
}

function isIntegrationStatus(value: unknown): value is IntegrationStatus {
  if (typeof value !== 'object' || value === null || !('microsoft' in value)) return false;
  const { microsoft } = value;
  return typeof microsoft === 'object'
    && microsoft !== null
    && 'configured' in microsoft
    && typeof microsoft.configured === 'boolean';
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
const savedClientId = process.env.MS_CLIENT_ID;

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
  if (savedClientId === undefined) delete process.env.MS_CLIENT_ID;
  else process.env.MS_CLIENT_ID = savedClientId;
});

afterEach(() => { delete process.env.MS_CLIENT_ID; });

describe('GET /api/integrations/status (non-admin capability check)', () => {
  it('is reachable by a non-admin (not behind requireAdmin) and reports configured=true when MS_CLIENT_ID is set', async () => {
    process.env.MS_CLIENT_ID = 'some-client-id';
    const res = await fetch(`${integrationBase()}/api/integrations/status`);
    expect(res.status).toBe(200);
    await expect(integrationStatusBody(res)).resolves.toEqual({ microsoft: { configured: true } });
  });

  it('reports configured=false when MS_CLIENT_ID is unset', async () => {
    const res = await fetch(`${integrationBase()}/api/integrations/status`);
    expect(res.status).toBe(200);
    await expect(integrationStatusBody(res)).resolves.toEqual({ microsoft: { configured: false } });
  });

  it('never leaks credentials in the response', async () => {
    process.env.MS_CLIENT_ID = 'super-secret-client-id';
    const res = await fetch(`${integrationBase()}/api/integrations/status`);
    const body = await res.text();
    expect(body).not.toContain('super-secret-client-id');
  });
});

describe('GET /api/integrations (config read) stays admin-only', () => {
  it('is rejected with 403 for a non-admin', async () => {
    const res = await fetch(`${integrationBase()}/api/integrations`);
    expect(res.status).toBe(403);
  });
});
