import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveInstantPushView } from './instantPushState.js';

test('non-native platforms render nothing', () => {
  assert.equal(deriveInstantPushView({ platformSupported: false }).kind, 'unsupported');
  assert.equal(deriveInstantPushView(undefined).kind, 'unsupported');
});

test('permission denied points at system settings', () => {
  const view = deriveInstantPushView({ platformSupported: true, status: 'permission_denied' });
  assert.equal(view.kind, 'permission_denied');
  assert.equal(view.showSettings, true);
});

test('no distributor asks for the extra app and shows the push server URL', () => {
  const view = deriveInstantPushView({
    platformSupported: true,
    status: 'unavailable',
    distributors: [],
    pushBaseUrl: 'https://mail.example.com/push',
  });
  assert.equal(view.kind, 'no_distributor');
  assert.equal(view.showInstall, true);
  assert.equal(view.showHelp, true);
  assert.equal(view.pushBaseUrl, 'https://mail.example.com/push');
});

test('an installed distributor that is not registered yet shows the pending instructions', () => {
  const view = deriveInstantPushView({
    platformSupported: true,
    status: 'fallback',
    distributors: ['io.heckel.ntfy'],
    distributorLabel: 'ntfy',
    pushBaseUrl: 'https://mail.example.com/push',
  });
  assert.equal(view.kind, 'pending');
  assert.equal(view.distributorName, 'ntfy');
  assert.equal(view.showOpenDistributor, true);
  assert.equal(view.showRetry, true);
  assert.equal(view.showInstall, false);
});

test('connected shows the provider and the push server', () => {
  const view = deriveInstantPushView({
    platformSupported: true,
    status: 'connected',
    transport: 'unifiedpush',
    distributors: ['io.heckel.ntfy'],
    distributorLabel: 'ntfy',
    hasEndpoint: true,
    pushBaseUrl: 'https://mail.example.com/push',
  });
  assert.equal(view.kind, 'connected');
  assert.equal(view.distributorName, 'ntfy');
  assert.equal(view.pushBaseUrl, 'https://mail.example.com/push');
  assert.equal(view.showRetry, false);
});

test('a connected non-distributor transport (e.g. bring-your-own FCM) still reports connected', () => {
  const view = deriveInstantPushView({
    platformSupported: true,
    status: 'connected',
    transport: 'fcm',
    distributors: [],
    pushBaseUrl: 'https://mail.example.com/push',
  });
  assert.equal(view.kind, 'connected');
  assert.equal(view.transport, 'fcm');
});
