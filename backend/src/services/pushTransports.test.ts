import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  TRANSPORT_DELIVERED, TRANSPORT_DISABLED, TRANSPORT_INVALID, TRANSPORT_LIVE, TRANSPORT_RETRY,
  parseServiceAccount, fcmConfigured, sendFcmPush, sendNativePush,
} from './pushTransports.js';

const event = { type: 'mail.changed', eventId: 'msg-1' };

beforeEach(() => {
  vi.unstubAllEnvs();
});
afterEach(() => vi.unstubAllEnvs());

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

  function installFcmFetch(sendResponse: Response) {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes('oauth2.googleapis.com')) return new Response(JSON.stringify({ access_token: 'access-token', expires_in: 3600 }), { status: 200 });
      return sendResponse;
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('sends an opaque high-priority data message through the v1 API', async () => {
    vi.stubEnv('FCM_SERVICE_ACCOUNT_JSON', JSON.stringify({ project_id: 'proj', client_email: 'svc@proj.iam', private_key: '-----BEGIN PRIVATE KEY-----\\nkey' }));
    const fetchMock = installFcmFetch(new Response(null, { status: 200 }));

    await expect(sendFcmPush({ endpoint: 'device-fcm-token' }, event)).resolves.toBe(TRANSPORT_DELIVERED);

    const fcmCall = fetchMock.mock.calls.find((call) => String(call[0]).includes('fcm.googleapis.com'));
    if (!fcmCall) throw new Error('FCM request was not issued');
    const [url, options] = fcmCall;
    expect(url).toBe('https://fcm.googleapis.com/v1/projects/proj/messages:send');
    if (!options || typeof options.body !== 'string') throw new Error('FCM request body was not a string');
    const body = JSON.parse(options.body);
    expect(body.message.token).toBe('device-fcm-token');
    expect(body.message.data).toEqual({ type: 'mail.changed', eventId: 'msg-1' });
    expect(body.message.android.priority).toBe('high');
    // No message content in the provider payload.
    expect(JSON.stringify(body)).not.toMatch(/subject|from|body:/);
  });

  it('maps UNREGISTERED/404 to invalid and 5xx to retry', async () => {
    vi.stubEnv('FCM_SERVICE_ACCOUNT_JSON', JSON.stringify({ project_id: 'proj', client_email: 'svc@proj.iam', private_key: 'key' }));
    installFcmFetch(new Response(null, { status: 404 }));
    await expect(sendFcmPush({ endpoint: 'token' }, event)).resolves.toBe(TRANSPORT_INVALID);

    installFcmFetch(new Response(null, { status: 503 }));
    await expect(sendFcmPush({ endpoint: 'token' }, event)).resolves.toBe(TRANSPORT_RETRY);
  });
});

describe('sendNativePush routing', () => {
  it('routes by device transport and ignores unknown transports', async () => {
    await expect(sendNativePush({ transport: 'live' }, event)).resolves.toBe(TRANSPORT_LIVE);
    await expect(sendNativePush({ transport: 'carrier-pigeon', endpoint: 'x' }, event)).resolves.toBe(TRANSPORT_DISABLED);
  });
});
