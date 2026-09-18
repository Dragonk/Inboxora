import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { listeningPort } from '../test/net.js';
import type { Server } from 'node:http';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: { headers: Record<string, string>; session?: { userId?: string } }, _res: unknown, next: () => void) => {
    req.session = { userId: 'user-1' };
    next();
  },
}));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../services/connectionPolicy.js', () => ({
  getConnectionPolicy: vi.fn().mockResolvedValue({
    allowPrivateHosts: false,
    allowInsecureTls: false,
    allowNonstandardPorts: false,
  }),
}));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: { collectHook: vi.fn().mockResolvedValue([]) } }));

import express from 'express';
import accountRoutes from './accounts.js';
import { query as __mock_query } from '../services/db.js';

const query = vi.mocked(__mock_query);
const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/accounts', accountRoutes);
  return app;
}

async function put(base: string, body: unknown) {
  return fetch(`${base}/api/accounts/${ACCOUNT_ID}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('PUT /api/accounts/:id antispam fields', () => {
  let server: Server;
  let base = '';

  beforeAll(async () => {
    await new Promise(resolve => {
      server = buildApp().listen(0, resolve);
    });
    base = `http://127.0.0.1:${listeningPort(server)}`;
  });

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  beforeEach(() => {
    query.mockReset();
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id FROM email_accounts WHERE id = $1')) return { rows: [{ id: ACCOUNT_ID }] };
      if (sql.startsWith('UPDATE email_accounts SET')) {
        return { rows: [{ id: ACCOUNT_ID, antispam_enabled: true, trusted_authserv_id: 'mx.google.com' }] };
      }
      return { rows: [] };
    });
  });

  it('accepts antispam_enabled and trusted_authserv_id', async () => {
    const res = await put(base, { antispam_enabled: true, trusted_authserv_id: 'mx.google.com' });
    expect(res.status).toBe(200);
    const update = query.mock.calls.find(([sql]) => String(sql).startsWith('UPDATE email_accounts SET'));
    expect(String(update?.[0])).toContain('antispam_enabled');
    expect(String(update?.[0])).toContain('trusted_authserv_id');
  });

  it('rejects a non-boolean antispam_enabled', async () => {
    const res = await put(base, { antispam_enabled: 'yes' });
    expect(res.status).toBe(400);
  });

  it('returns the new columns on GET /', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM email_accounts WHERE user_id')) {
        return { rows: [{ id: ACCOUNT_ID, antispam_enabled: true, trusted_authserv_id: 'mx.example.com' }] };
      }
      return { rows: [] };
    });
    const res = await fetch(`${base}/api/accounts/`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body[0]).toMatchObject({ antispam_enabled: true, trusted_authserv_id: 'mx.example.com' });
  });
});
