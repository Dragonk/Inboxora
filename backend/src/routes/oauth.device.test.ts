import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { listeningPort } from '../test/net.js';

// The module reads the app's imap manager indirectly, so the entry point is stubbed as the
// existing oauth test does.
vi.mock('../index.js', () => ({ imapManager: {} }));
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../services/db.js', () => ({ query, withTransaction: vi.fn() }));
vi.mock('../services/encryption.js', () => ({ encrypt: (value: string) => value, decrypt: (value: string) => value }));

import oauthRouter from './oauth.js';

// Capture the real fetch before the per-test stub replaces it.
const realFetch = globalThis.fetch.bind(globalThis) as typeof fetch;

let server: Server;
let base = '';
let sessionUserId: string | null = 'user-1';
const originalEnv = { MS_CLIENT_ID: process.env.MS_CLIENT_ID, MS_TENANT_ID: process.env.MS_TENANT_ID };

const DEVICE_RESPONSE = {
  device_code: 'device-code-1', user_code: 'ABCD-EFGH', verification_uri: 'https://microsoft.com/devicelogin',
  expires_in: 900, interval: 5,
};

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as unknown as { session: { userId: string | null } }).session = { userId: sessionUserId }; next(); });
  app.use('/oauth', oauthRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  base = `http://127.0.0.1:${listeningPort(server)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  sessionUserId = 'user-1';
  process.env.MS_CLIENT_ID = 'client-1';
  process.env.MS_TENANT_ID = 'common';
  query.mockReset();
  query.mockResolvedValue({ rows: [{ config: {} }] });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).startsWith(base)) return realFetch(url, init);
    return { ok: true, status: 200, json: async () => DEVICE_RESPONSE } as Response;
  }));
});

afterEach(() => { vi.unstubAllGlobals(); });

const startDevice = () => realFetch(`${base}/oauth/microsoft/device`, { method: 'POST' });

describe('POST /oauth/microsoft/device', () => {
  it('refuses an unauthenticated caller', async () => {
    sessionUserId = null;
    expect((await startDevice()).status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it('explains that the integration is not configured', async () => {
    delete process.env.MS_CLIENT_ID;
    const response = await startDevice();
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toContain('not configured');
  });

  it('refuses the method the administrator switched off, instead of starting it', async () => {
    // The readiness report says the method is unavailable; without this the route would
    // still start it, making the switch decoration for anything bypassing the interface.
    query.mockResolvedValue({ rows: [{ config: { deviceEnabled: false } }] });
    const response = await startDevice();
    expect(response.status).toBe(403);
    expect((await response.json() as { error: string }).error).toContain('disabled');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('refuses the method when the whole provider is switched off', async () => {
    query.mockResolvedValue({ rows: [{ config: { disabled: true } }] });
    const response = await startDevice();
    expect(response.status).toBe(403);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('does not call Microsoft again before the interval it asked for', async () => {
    // Each poll is a provider call, and the interface respects the interval while nothing stopped another
    // caller from ignoring it.
    const started = await (await startDevice()).json() as { flowId?: string };
    // From here the token endpoint answers "pending", which is what a device grant returns until the user
    // approves it.
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith(base)) return realFetch(url, init);
      return { ok: true, status: 200, json: async () => ({ error: 'authorization_pending' }) } as Response;
    }));
    const first = await realFetch(`${base}/oauth/microsoft/device/poll?flowId=${started.flowId}`);
    expect(first.status).toBe(200);
    expect((await first.json() as { status: string }).status).toBe('pending');
    const providerCallsAfterFirst = vi.mocked(fetch).mock.calls.length;

    const second = await realFetch(`${base}/oauth/microsoft/device/poll?flowId=${started.flowId}`);
    expect((await second.json() as { status: string }).status).toBe('pending');
    // The second poll answered from the flow's own state: no further call reached the provider.
    expect(vi.mocked(fetch).mock.calls.length).toBe(providerCallsAfterFirst);
  });

  it('keeps a second flow for the same user separate from the first', async () => {
    // The map used to be keyed by the user, so a second start replaced the first: the first poll would
    // report the second flow's state and completing the first code would be invisible.
    const first = await (await startDevice()).json() as { flowId?: string; userCode?: string };
    const second = await (await startDevice()).json() as { flowId?: string; userCode?: string };
    expect(first.flowId).toBeTruthy();
    expect(second.flowId).toBeTruthy();
    expect(first.flowId).not.toBe(second.flowId);

    // Polling each id reaches its own flow rather than whichever started last.
    const polledFirst = await realFetch(`${base}/oauth/microsoft/device/poll?flowId=${first.flowId}`);
    expect(polledFirst.status).toBe(200);
    const polledSecond = await realFetch(`${base}/oauth/microsoft/device/poll?flowId=${second.flowId}`);
    expect(polledSecond.status).toBe(200);

    // And an id that is not this user's is refused rather than served.
    const foreign = await realFetch(`${base}/oauth/microsoft/device/poll?flowId=not-a-flow`);
    expect(foreign.status).toBe(400);
  });

  it('starts the flow when the method is enabled, returning only what the user needs', async () => {
    const response = await startDevice();
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ userCode: 'ABCD-EFGH', verificationUri: 'https://microsoft.com/devicelogin', expiresIn: 900, interval: 5 });
    // The flow id is what makes a second, parallel flow addressable; the client polls with it.
    expect(typeof body.flowId).toBe('string');
    // The device token is never sent to the browser; only the user code.
    expect(JSON.stringify(body)).not.toContain('device-code-1');
    // The route sends URLSearchParams, so stringify before matching.
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, { body: unknown }];
    expect(String(init.body)).toContain('client_id=client-1');
    expect(String(init.body)).toContain('IMAP.AccessAsUser.All');
  });

  it('starts the flow when the configuration cannot be read, rather than failing closed', async () => {
    // An absent row means "not switched off"; a read failure must not disable a method.
    query.mockRejectedValue(new Error('relation does not exist'));
    expect((await startDevice()).status).toBe(200);
  });
});
