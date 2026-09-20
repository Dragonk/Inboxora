import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listeningPort } from '../test/net.js';
import type { Server } from 'node:http';

/**
 * The public webhook endpoints.
 *
 * These are reachable from the internet, so what matters here is what they refuse and what they refuse to
 * reveal: an unknown subscription, a wrong secret, a wrong resource and a body that is not a notification are
 * all answered the same way, and a notification that does authenticate only ever records a sync hint. The
 * payload is never read as state — the tests assert the hint, not a local change.
 */

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  findSubscriptionByProviderId: vi.fn(),
  findLiveSubscription: vi.fn(),
  recordSubscriptionNotification: vi.fn(),
  enqueueProviderSyncHint: vi.fn(),
  triggerDrain: vi.fn(),
  createGraphSubscription: vi.fn(),
  renewGraphSubscription: vi.fn(),
  consume: vi.fn(),
}));

vi.mock('../services/db.js', () => ({ query: mocks.query }));
vi.mock('../services/rateLimiter.js', () => ({ consume: mocks.consume }));
vi.mock('../services/providerSyncHints.js', () => ({
  enqueueProviderSyncHint: mocks.enqueueProviderSyncHint,
  syncHintDiagnostics: vi.fn(),
}));
vi.mock('../services/providerSyncHintWorker.js', () => ({ triggerProviderSyncHintDrain: mocks.triggerDrain }));
vi.mock('../services/providerPushSubscriptions.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../services/providerPushSubscriptions.js')>()),
  findSubscriptionByProviderId: mocks.findSubscriptionByProviderId,
  findLiveSubscription: mocks.findLiveSubscription,
  recordSubscriptionNotification: mocks.recordSubscriptionNotification,
}));
vi.mock('../services/providerPushMicrosoft.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../services/providerPushMicrosoft.js')>()),
  createGraphSubscription: mocks.createGraphSubscription,
  renewGraphSubscription: mocks.renewGraphSubscription,
}));

import express from 'express';
import webhookRoutes from './providerWebhooks.js';
import { hashPushSecret } from '../services/providerPushSubscriptions.js';

const CLIENT_STATE = 'client-state-secret';
const CHANNEL_TOKEN = 'channel-token-secret';

const subscription = (overrides: Record<string, unknown> = {}) => ({
  id: 'subscription-1',
  user_id: 'user-1',
  provider_connection_id: 'connection-1',
  provider: 'microsoft',
  resource_type: 'mail',
  collection_id: null,
  provider_subscription_id: 'graph-subscription-1',
  provider_resource: '/me/messages',
  remote_resource_id: null,
  secret_kind: 'client_state',
  expires_at: null,
  status: 'active',
  last_notification_at: null,
  last_renewed_at: null,
  last_error_code: null,
  failure_count: 0,
  next_attempt_at: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

let server: Server;
let base = '';

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.PROVIDER_PUSH_ENABLED = 'true';
  process.env.APP_URL = 'https://mail.example.test';
  process.env.GOOGLE_PUBSUB_TOPIC = 'projects/example/topics/inboxora';
  process.env.GOOGLE_PUBSUB_VERIFICATION_TOKEN = 'pubsub-token-value-1234567890';
  mocks.consume.mockResolvedValue({ limited: false, resetMs: 0 });
  mocks.query.mockResolvedValue({ rows: [] });
  mocks.recordSubscriptionNotification.mockResolvedValue(undefined);
  mocks.enqueueProviderSyncHint.mockResolvedValue({ enqueued: true, coalesced: false });
  if (!server) {
    const app = express();
    app.use(express.json());
    app.use('/api/provider-webhooks', webhookRoutes);
    await new Promise<void>((resolve, reject) => { server = app.listen(0, () => resolve()); server.once('error', reject); });
    base = `http://127.0.0.1:${listeningPort(server)}`;
  }
});

const post = (path: string, body?: unknown, headers: Record<string, string> = {}) => fetch(`${base}/api/provider-webhooks${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

describe('Microsoft Graph notifications', () => {
  it('answers the validation handshake as plain text, exactly as sent', async () => {
    const response = await post('/microsoft?validationToken=abc%20123');
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toBe('abc 123');
    expect(response.headers.get('content-type')).toContain('text/plain');
    // The handshake carries no subscription to look up and records no work.
    expect(mocks.enqueueProviderSyncHint).not.toHaveBeenCalled();
  });

  it('records one sync hint for a valid notification and never trusts its payload', async () => {
    mocks.findSubscriptionByProviderId.mockResolvedValue(subscription());
    mocks.query.mockResolvedValueOnce({ rows: [{ secret_hash: hashPushSecret(CLIENT_STATE) }] });

    const response = await post('/microsoft', {
      value: [{
        subscriptionId: 'graph-subscription-1',
        clientState: CLIENT_STATE,
        changeType: 'created',
        resource: '/Users/other-user/Messages/AAA',
        resourceData: { id: 'AAA', subject: 'Should never be read' },
      }],
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ accepted: true, count: 1 });
    expect(mocks.enqueueProviderSyncHint).toHaveBeenCalledWith({
      userId: 'user-1', connectionId: 'connection-1', provider: 'microsoft', resourceType: 'mail',
    });
    expect(mocks.triggerDrain).toHaveBeenCalled();
    expect(mocks.recordSubscriptionNotification).toHaveBeenCalledWith('subscription-1');
  });

  it('rejects a wrong clientState without saying which check failed', async () => {
    mocks.findSubscriptionByProviderId.mockResolvedValue(subscription());
    mocks.query.mockResolvedValueOnce({ rows: [{ secret_hash: hashPushSecret(CLIENT_STATE) }] });

    const response = await post('/microsoft', {
      value: [{ subscriptionId: 'graph-subscription-1', clientState: 'not-the-secret', changeType: 'created' }],
    });

    expect(await response.json()).toEqual({ accepted: false, count: 0 });
    expect(mocks.enqueueProviderSyncHint).not.toHaveBeenCalled();
  });

  it('rejects an unknown subscription id', async () => {
    mocks.findSubscriptionByProviderId.mockResolvedValue(null);

    const response = await post('/microsoft', {
      value: [{ subscriptionId: 'unknown', clientState: CLIENT_STATE, changeType: 'created' }],
    });

    expect(await response.json()).toEqual({ accepted: false, count: 0 });
    expect(mocks.enqueueProviderSyncHint).not.toHaveBeenCalled();
  });

  it('turns a missed lifecycle notification into a delta sync rather than a replay', async () => {
    mocks.findSubscriptionByProviderId.mockResolvedValue(subscription());
    mocks.query.mockResolvedValueOnce({ rows: [{ secret_hash: hashPushSecret(CLIENT_STATE) }] });

    await post('/microsoft', {
      value: [{ subscriptionId: 'graph-subscription-1', clientState: CLIENT_STATE, lifecycleEvent: 'missed' }],
    });

    expect(mocks.enqueueProviderSyncHint).toHaveBeenCalledWith(expect.objectContaining({ resourceType: 'mail' }));
    // Nothing replays individual notifications; the hint is the recovery.
    expect(mocks.createGraphSubscription).not.toHaveBeenCalled();
  });

  it('recreates a removed subscription and covers the gap with a sync', async () => {
    mocks.findSubscriptionByProviderId.mockResolvedValue(subscription());
    mocks.query.mockResolvedValueOnce({ rows: [{ secret_hash: hashPushSecret(CLIENT_STATE) }] });
    mocks.createGraphSubscription.mockResolvedValue(subscription());

    await post('/microsoft', {
      value: [{ subscriptionId: 'graph-subscription-1', clientState: CLIENT_STATE, lifecycleEvent: 'subscriptionRemoved' }],
    });

    expect(mocks.createGraphSubscription).toHaveBeenCalledWith(expect.objectContaining({ resourceType: 'mail' }));
    expect(mocks.enqueueProviderSyncHint).toHaveBeenCalled();
  });

  it('renews on reauthorizationRequired and does not fail the notification when it cannot', async () => {
    mocks.findSubscriptionByProviderId.mockResolvedValue(subscription());
    mocks.query.mockResolvedValueOnce({ rows: [{ secret_hash: hashPushSecret(CLIENT_STATE) }] });
    mocks.renewGraphSubscription.mockRejectedValue(Object.assign(new Error('invalid grant'), { code: 'REAUTH_REQUIRED' }));

    const response = await post('/microsoft', {
      value: [{ subscriptionId: 'graph-subscription-1', clientState: CLIENT_STATE, lifecycleEvent: 'reauthorizationRequired' }],
    });

    // A grant that cannot be refreshed is the account's problem to show, not a webhook failure: polling still
    // carries the mailbox, and the renewal loop must not hammer a dead grant.
    expect(response.status).toBe(202);
    expect(mocks.renewGraphSubscription).toHaveBeenCalled();
  });

  it('refuses a body that is not a notification', async () => {
    expect((await post('/microsoft', { value: [] })).status).toBe(202);
    expect((await post('/microsoft', { value: 'not-an-array' })).status).toBe(202);
    expect((await post('/microsoft', { value: new Array(1001).fill({ subscriptionId: 'x' }) })).status).toBe(202);
    expect(mocks.enqueueProviderSyncHint).not.toHaveBeenCalled();
  });

  it('refuses an oversized body', async () => {
    // A real oversized payload: the bound is enforced from the request's own length, so it holds whether or
    // not a body parser ran first.
    const response = await fetch(`${base}/api/provider-webhooks/microsoft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: [{ subscriptionId: 'x', padding: 'p'.repeat(80 * 1024) }] }),
    });
    expect(response.status).toBe(413);
    expect(mocks.enqueueProviderSyncHint).not.toHaveBeenCalled();
  });

  it('refuses an unsupported content type', async () => {
    const response = await fetch(`${base}/api/provider-webhooks/microsoft`, {
      method: 'POST',
      headers: { 'content-type': 'application/xml' },
      body: '<xml/>',
    });
    expect(response.status).toBe(415);
  });

  it('answers 404 when push is switched off, so nothing is registered by accident', async () => {
    process.env.PROVIDER_PUSH_ENABLED = 'false';
    const response = await post('/microsoft?validationToken=abc');
    expect(response.status).toBe(404);
  });

  it('rate-limits a flood', async () => {
    mocks.consume.mockResolvedValue({ limited: true, resetMs: 30_000 });
    const response = await post('/microsoft', { value: [] });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('30');
  });
});

describe('Google Calendar channel notifications', () => {
  const channelHeaders = (token = CHANNEL_TOKEN, resourceId = 'resource-1') => ({
    'x-goog-channel-id': 'inboxora-collection-1',
    'x-goog-resource-id': resourceId,
    'x-goog-channel-token': token,
    'x-goog-resource-state': 'exists',
  });

  it('answers the channel opening handshake without syncing', async () => {
    const response = await post('/google-calendar', {}, {
      'x-goog-channel-id': 'inboxora-collection-1',
      'x-goog-resource-id': 'resource-1',
      'x-goog-resource-state': 'sync',
    });
    expect(response.status).toBe(200);
    expect(mocks.enqueueProviderSyncHint).not.toHaveBeenCalled();
  });

  it('records a collection-scoped hint for an authenticated change', async () => {
    mocks.findSubscriptionByProviderId.mockResolvedValue(subscription({
      provider: 'google', resource_type: 'calendar', collection_id: 'collection-1',
      provider_subscription_id: 'inboxora-collection-1', remote_resource_id: 'resource-1', secret_kind: 'channel_token',
    }));
    mocks.query.mockResolvedValueOnce({ rows: [{ secret_hash: hashPushSecret(CHANNEL_TOKEN) }] });

    const response = await post('/google-calendar', {}, channelHeaders());

    expect(response.status).toBe(200);
    expect(mocks.enqueueProviderSyncHint).toHaveBeenCalledWith({
      userId: 'user-1', connectionId: 'connection-1', provider: 'google',
      resourceType: 'calendar', collectionId: 'collection-1',
    });
  });

  it('rejects a wrong channel token', async () => {
    mocks.findSubscriptionByProviderId.mockResolvedValue(subscription({
      provider: 'google', resource_type: 'calendar', remote_resource_id: 'resource-1',
    }));
    mocks.query.mockResolvedValueOnce({ rows: [{ secret_hash: hashPushSecret(CHANNEL_TOKEN) }] });

    expect(await (await post('/google-calendar', {}, channelHeaders('wrong'))).json()).toEqual({ accepted: false });
    expect(mocks.enqueueProviderSyncHint).not.toHaveBeenCalled();
  });

  it('rejects a notification for a resource the channel was not opened for', async () => {
    mocks.findSubscriptionByProviderId.mockResolvedValue(subscription({
      provider: 'google', resource_type: 'calendar', remote_resource_id: 'resource-1',
    }));
    mocks.query.mockResolvedValueOnce({ rows: [{ secret_hash: hashPushSecret(CHANNEL_TOKEN) }] });

    expect(await (await post('/google-calendar', {}, channelHeaders(CHANNEL_TOKEN, 'other-resource'))).json())
      .toEqual({ accepted: false });
    expect(mocks.enqueueProviderSyncHint).not.toHaveBeenCalled();
  });

  it('rejects an unknown channel id and a missing one', async () => {
    mocks.findSubscriptionByProviderId.mockResolvedValue(null);
    expect(await (await post('/google-calendar', {}, channelHeaders())).json()).toEqual({ accepted: false });
    expect(await (await post('/google-calendar', {}, { 'x-goog-resource-state': 'exists' })).json()).toEqual({ accepted: false });
    expect(mocks.enqueueProviderSyncHint).not.toHaveBeenCalled();
  });
});

describe('Gmail Pub/Sub notifications', () => {
  const envelope = (emailAddress = 'user@gmail.test') => ({
    message: {
      data: Buffer.from(JSON.stringify({ emailAddress, historyId: '12345' }), 'utf8').toString('base64'),
      messageId: '1',
    },
    subscription: 'projects/example/subscriptions/inboxora',
  });

  const authHeaders = { 'x-inboxora-pubsub-token': 'pubsub-token-value-1234567890' };

  it('records a mailbox hint for an authenticated message and does not adopt its historyId', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'connection-1', user_id: 'user-1' }] });
    mocks.findLiveSubscription.mockResolvedValue(subscription({
      provider: 'google', resource_type: 'mail', provider_subscription_id: 'gmail-watch', secret_kind: 'pubsub_token',
    }));

    const response = await post('/gmail', envelope(), authHeaders);

    expect(response.status).toBe(200);
    expect(mocks.enqueueProviderSyncHint).toHaveBeenCalledWith({
      userId: 'user-1', connectionId: 'connection-1', provider: 'google', resourceType: 'mail',
    });
    // The history sync owns its cursor: no cursor is written from the notification.
    expect(mocks.query.mock.calls.some(([sql]) => /UPDATE .*history/i.test(String(sql)))).toBe(false);
  });

  it('rejects a wrong or missing Pub/Sub token', async () => {
    expect(await (await post('/gmail', envelope(), { 'x-inboxora-pubsub-token': 'wrong' })).json()).toEqual({ accepted: false });
    expect(await (await post('/gmail', envelope())).json()).toEqual({ accepted: false });
    expect(mocks.enqueueProviderSyncHint).not.toHaveBeenCalled();
  });

  it('rejects a malformed message and one for an unknown mailbox', async () => {
    expect(await (await post('/gmail', { message: { data: 'not-base64-json' } }, authHeaders)).json()).toEqual({ accepted: false });
    expect(await (await post('/gmail', { message: {} }, authHeaders)).json()).toEqual({ accepted: false });

    mocks.query.mockResolvedValueOnce({ rows: [] });
    expect(await (await post('/gmail', envelope('stranger@gmail.test'), authHeaders)).json()).toEqual({ accepted: false });

    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'connection-1', user_id: 'user-1' }] });
    mocks.findLiveSubscription.mockResolvedValue(null);
    expect(await (await post('/gmail', envelope(), authHeaders)).json()).toEqual({ accepted: false });
    expect(mocks.enqueueProviderSyncHint).not.toHaveBeenCalled();
  });
});
