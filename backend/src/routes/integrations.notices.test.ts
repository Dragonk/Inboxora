import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  listActive: vi.fn(),
  suppress: vi.fn(),
}));

vi.mock('../services/db.js', () => ({ query: mocks.query }));
vi.mock('../services/accountNotices.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/accountNotices.js')>()),
  listActiveGoogleMailRecommendations: mocks.listActive,
  suppressGoogleMailRecommendation: mocks.suppress,
}));

import express from 'express';
import session from 'express-session';
import integrationsRouter from './integrations.js';
import { listeningPort } from '../test/net.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-session-secret', resave: false, saveUninitialized: true }));
  app.use((req, _res, next) => { req.session.userId = 'user-1'; next(); });
  app.use('/api/integrations', integrationsRouter);
  return app;
}

async function call(method: 'GET' | 'POST', path: string) {
  // `requireAuth` resolves the session's user first; no other query runs on these routes.
  mocks.query.mockResolvedValue({ rows: [{ id: 'user-1' }] });
  const server = createApp().listen(0);
  const response = await fetch(`http://127.0.0.1:${listeningPort(server)}/api/integrations${path}`, { method });
  const parsed = await response.json().catch(() => null) as Record<string, unknown> | null;
  await new Promise(resolve => server.close(resolve));
  return { status: response.status, body: parsed };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listActive.mockResolvedValue([]);
  mocks.suppress.mockResolvedValue({ ok: true });
});

describe('GET /notices', () => {
  it('returns the active recommendation with the account id, address and notice type', async () => {
    mocks.listActive.mockResolvedValueOnce([
      { accountId: 'account-1', address: 'me@gmail.test', noticeType: 'google_mail_api_recommendation' },
    ]);

    const response = await call('GET', '/notices');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      notices: [{ accountId: 'account-1', address: 'me@gmail.test', noticeType: 'google_mail_api_recommendation' }],
    });
    // The wording is the interface's: only identity crosses the wire.
    expect(Object.keys((response.body as { notices: Array<Record<string, unknown>> }).notices[0]).sort()).toEqual(['accountId', 'address', 'noticeType']);
    // Owner-scoped to the caller, never a parameter.
    expect(mocks.listActive).toHaveBeenCalledWith('user-1');
  });

  it('answers an empty list when nothing is active', async () => {
    const response = await call('GET', '/notices');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ notices: [] });
  });
});

describe('POST /notices/:accountId/suppress', () => {
  it('suppresses the caller’s own notice', async () => {
    const response = await call('POST', '/notices/account-1/suppress');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(mocks.suppress).toHaveBeenCalledWith('user-1', 'account-1');
  });

  it('answers 404 for an account that is not the caller’s', async () => {
    mocks.suppress.mockResolvedValueOnce({ ok: false, status: 404, error: 'Account not found' });
    const response = await call('POST', '/notices/account-9/suppress');
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: 'Account not found' });
  });
});
