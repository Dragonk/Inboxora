import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { pushStateFor, type ProviderPushStatus } from './ProviderPushControls.tsx';

/**
 * The instant-synchronisation card.
 *
 * Push is an accelerator: the card has to say what is happening without ever implying the account is broken
 * when there is no push. These cases pin the state the reader sees and the wiring that makes the buttons do
 * what they say.
 */

const status = (overrides: Partial<ProviderPushStatus> = {}): ProviderPushStatus => ({
  enabled: true,
  webhookBaseUrl: 'https://mail.example.test',
  reason: null,
  subscriptions: [],
  ...overrides,
});

const subscription = (overrides: Record<string, unknown> = {}) => ({
  id: 'subscription-1',
  connectionId: 'connection-1',
  provider: 'microsoft',
  resourceType: 'mail',
  status: 'active',
  expiresAt: '2026-12-31T00:00:00.000Z',
  lastNotificationAt: null,
  lastRenewedAt: null,
  lastErrorCode: null,
  ...overrides,
});

test('the card reports the state that matters, in order', () => {
  // Not configured at all: a state, not an error.
  assert.equal(pushStateFor({ provider: 'microsoft', status: status({ enabled: false, webhookBaseUrl: null, reason: 'PROVIDER_PUSH_DISABLED' }), subscriptions: [] }), 'disabled');
  assert.equal(pushStateFor({ provider: 'microsoft', status: status({ webhookBaseUrl: null, reason: 'PUBLIC_URL_NOT_CONFIGURED' }), subscriptions: [] }), 'needs_url');
  // A renewal failure is the most actionable thing on the card.
  assert.equal(pushStateFor({ provider: 'microsoft', status: status(), subscriptions: [subscription({ lastErrorCode: 'RATE_LIMITED' })] }), 'renewal_error');
  assert.equal(pushStateFor({ provider: 'microsoft', status: status(), subscriptions: [subscription()] }), 'active');
  // Configured but not enabled for this connection: the user can turn it on.
  assert.equal(pushStateFor({ provider: 'microsoft', status: status(), subscriptions: [] }), 'available');
  // A missing status payload must not break the card.
  assert.equal(pushStateFor({ provider: 'microsoft', status: null, subscriptions: [] }), 'available');
});

test('the card enables, disables and reports the fallback through the server, never a typed URL', async () => {
  const source = await readFile(new URL('./ProviderPushControls.tsx', import.meta.url), 'utf8');
  assert.match(source, /api\.enableConnectionPush\(connectionId\)/);
  assert.match(source, /api\.disableConnectionPush\(connectionId\)/);
  assert.match(source, /api\.getProviderPushStatus\(\)/);
  // The URL comes from the server's `webhookBaseUrl`; the component never builds one.
  assert.doesNotMatch(source, /https:\/\//);
  // The polling fallback is stated, and Contacts are described as polling-only for Google.
  assert.match(source, /admin\.integrations\.push\.pollingFallback/);
  assert.match(source, /admin\.integrations\.push\.contactsPollingOnly/);
  assert.match(source, /data-testid=\{`provider-push-state-\$\{provider\}`\}/);
  assert.match(source, /data-testid=\{`provider-push-enable-\$\{provider\}`\}/);
  assert.match(source, /data-testid=\{`provider-push-disable-\$\{provider\}`\}/);
});

test('both provider cards render the controls for each connection', async () => {
  const panel = await readFile(new URL('./AdminPanel.tsx', import.meta.url), 'utf8');
  assert.match(panel, /provider="microsoft"/);
  assert.match(panel, /provider="google"/);
  assert.match(panel, /reloadStatus=\{loadPushStatus\}/);
  // The status is fetched once for the tab rather than per card.
  assert.equal((panel.match(/api\.getProviderPushStatus\(\)/g) ?? []).length, 1);
});

test('the API client calls the endpoints the server exposes', async () => {
  const api = await readFile(new URL('../utils/api.ts', import.meta.url), 'utf8');
  assert.match(api, /getProviderPushStatus: \(\) => request\('GET', '\/integrations\/push-status'\)/);
  assert.match(api, /enableConnectionPush: \(connectionId: string\) => request\('POST', `\/integrations\/push\/connections\/\$\{encodeURIComponent\(connectionId\)\}\/enable`/);
  assert.match(api, /disableConnectionPush: \(connectionId: string\) => request\('POST', `\/integrations\/push\/connections\/\$\{encodeURIComponent\(connectionId\)\}\/disable`/);
});
