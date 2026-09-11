import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock('./safeFetch.js', () => ({ safeFetch }));
vi.mock('jose', () => {
  class SignJWT {
    setProtectedHeader() { return this; }
    setIssuer() { return this; }
    setSubject() { return this; }
    setAudience() { return this; }
    setIssuedAt() { return this; }
    setExpirationTime() { return this; }
    async sign() { return 'signed-assertion'; }
  }
  return { SignJWT, importPKCS8: vi.fn(async () => 'private-key') };
});

import {
  TRANSPORT_DELIVERED, TRANSPORT_DISABLED, TRANSPORT_INVALID, TRANSPORT_RETRY,
  parseServiceAccount, fcmConfigured, sendFcmPush, sendNativePush, sendUnifiedPush,
} from './pushTransports.js';

const event = { type: 'mail.changed', eventId: 'msg-1' };

beforeEach(() => {
  safeFetch.mockReset();
  vi.unstubAllEnvs();
});
afterEach(() => vi.unstubAllEnvs());

describe('UnifiedPush transport', () => {
  it('POSTs the opaque event and reports delivery', async () => {
    safeFetch.mockResolvedValue({ ok: true, status: 200 });
    await expect(sendUnifiedPush({ endpoint: 'https://distributor.example/up/topic' }, event)).resolves.toBe(TRANSPORT_DELIVERED);
    const [url, options, policy] = safeFetch.mock.calls[0];
    expect(url).toBe('https://distributor.example/up/topic');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual(event);
    expect(policy).toEqual({ allowPrivate: false, requireHttps: true });
  });

  it('treats 404/410 as a permanent rejection and 503 as retryable', async () => {
    safeFetch.mockResolvedValue({ ok: false, status: 410 });
    await expect(sendUnifiedPush({ endpoint: 'https://x.example/up' }, event)).resolves.toBe(TRANSPORT_INVALID);
    safeFetch.mockResolvedValue({ ok: false, status: 503 });
    await expect(sendUnifiedPush({ endpoint: 'https://x.example/up' }, event)).resolves.toBe(TRANSPORT_RETRY);
  });

  it('refuses a private/blocked endpoint and retries transient network errors', async () => {
    safeFetch.mockRejectedValue(Object.assign(new Error('blocked'), { code: 'ERR_BLOCKED_PRIVATE_IP' }));
    await expect(sendUnifiedPush({ endpoint: 'https://internal/up' }, event)).resolves.toBe(TRANSPORT_INVALID);
    safeFetch.mockRejectedValue(new Error('socket hang up'));
    await expect(sendUnifiedPush({ endpoint: 'https://x.example/up' }, event)).resolves.toBe(TRANSPORT_RETRY);
  });

  it('allows a private distributor only when explicitly opted in', async () => {
    vi.stubEnv('PUSH_ALLOW_PRIVATE_ENDPOINTS', 'true');
    safeFetch.mockResolvedValue({ ok: true, status: 200 });
    await sendUnifiedPush({ endpoint: 'https://192.168.1.10/up' }, event);
    expect(safeFetch.mock.calls[0][2]).toEqual({ allowPrivate: true, requireHttps: false });
  });
});

describe('FCM transport', () => {
  it('parses a raw and a base64 service account and rejects malformed input', () => {
    const account = { project_id: 'proj', client_email: 'svc@proj.iam', private_key: '-----BEGIN PRIVATE KEY-----\\nkey' };
    expect(parseServiceAccount(JSON.stringify(account))).toEqual({ projectId: 'proj', clientEmail: 'svc@proj.iam', privateKey: '-----BEGIN PRIVATE KEY-----\nkey' });
    expect(parseServiceAccount(Buffer.from(JSON.stringify(account)).toString('base64'))).toEqual({ projectId: 'proj', clientEmail: 'svc@proj.iam', privateKey: '-----BEGIN PRIVATE KEY-----\nkey' });
    expect(parseServiceAccount('{}')).toBeNull();
    expect(parseServiceAccount('not json at all')).toBeNull();
    expect(parseServiceAccount(undefined)).toBeNull();
  });

  it('is disabled until the server has its own Firebase credentials', async () => {
    expect(fcmConfigured()).toBe(false);
    await expect(sendFcmPush({ endpoint: 'token' }, event)).resolves.toBe(TRANSPORT_DISABLED);
  });

  function installFcmFetch(sendResponse) {
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes('oauth2.googleapis.com')) return { ok: true, json: async () => ({ access_token: 'access-token', expires_in: 3600 }) };
      return sendResponse;
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('sends an opaque high-priority data message through the v1 API', async () => {
    vi.stubEnv('FCM_SERVICE_ACCOUNT_JSON', JSON.stringify({ project_id: 'proj', client_email: 'svc@proj.iam', private_key: '-----BEGIN PRIVATE KEY-----\\nkey' }));
    const fetchMock = installFcmFetch({ ok: true, status: 200 });

    await expect(sendFcmPush({ endpoint: 'device-fcm-token' }, event)).resolves.toBe(TRANSPORT_DELIVERED);

    const [url, options] = fetchMock.mock.calls.find((call) => String(call[0]).includes('fcm.googleapis.com'));
    expect(url).toBe('https://fcm.googleapis.com/v1/projects/proj/messages:send');
    const body = JSON.parse(options.body);
    expect(body.message.token).toBe('device-fcm-token');
    expect(body.message.data).toEqual({ type: 'mail.changed', eventId: 'msg-1' });
    expect(body.message.android.priority).toBe('high');
    // No message content in the provider payload.
    expect(JSON.stringify(body)).not.toMatch(/subject|from|body:/);
  });

  it('maps UNREGISTERED/404 to invalid and 5xx to retry', async () => {
    vi.stubEnv('FCM_SERVICE_ACCOUNT_JSON', JSON.stringify({ project_id: 'proj', client_email: 'svc@proj.iam', private_key: 'key' }));
    installFcmFetch({ ok: false, status: 404, json: async () => ({}) });
    await expect(sendFcmPush({ endpoint: 'token' }, event)).resolves.toBe(TRANSPORT_INVALID);

    installFcmFetch({ ok: false, status: 503, json: async () => ({}) });
    await expect(sendFcmPush({ endpoint: 'token' }, event)).resolves.toBe(TRANSPORT_RETRY);
  });
});

describe('sendNativePush routing', () => {
  it('routes by device transport and ignores unknown transports', async () => {
    safeFetch.mockResolvedValue({ ok: true, status: 200 });
    await expect(sendNativePush({ transport: 'unifiedpush', endpoint: 'https://x.example/up' }, event)).resolves.toBe(TRANSPORT_DELIVERED);
    await expect(sendNativePush({ transport: 'carrier-pigeon', endpoint: 'x' }, event)).resolves.toBe(TRANSPORT_DISABLED);
  });
});
