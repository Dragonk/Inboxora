import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveInstantPushView } from './instantPushState.ts';

test('non-native platforms render nothing', () => {
  assert.equal(deriveInstantPushView({ platformSupported: false }).kind, 'unsupported');
  assert.equal(deriveInstantPushView(undefined).kind, 'unsupported');
});

test('permission denied points at system settings', () => {
  const view = deriveInstantPushView({ platformSupported: true, status: 'permission_denied' });
  assert.equal(view.kind, 'permission_denied');
  assert.equal(view.showSettings, true);
  assert.equal(view.showRetry, false);
});

test('pending keeps a retry and the delivery warnings', () => {
  const view = deriveInstantPushView({
    platformSupported: true,
    status: 'fallback',
    transport: 'live',
    live: 'disconnected',
    batteryOptimized: true,
  });
  assert.equal(view.kind, 'pending');
  assert.equal(view.showRetry, true);
  assert.equal(view.warnings.battery, true);
  assert.equal(view.warnings.exactAlarms, false);
  assert.equal(view.warnings.liveNotRunning, true);
});

test('connected without delivery problems is clean', () => {
  const view = deriveInstantPushView({
    platformSupported: true,
    status: 'connected',
    transport: 'live',
    live: 'connected',
    batteryOptimized: false,
    exactAlarmsGranted: true,
  });
  assert.equal(view.kind, 'connected');
  assert.equal(view.transport, 'live');
  assert.equal(view.warnings.battery, false);
  assert.equal(view.warnings.exactAlarms, false);
  assert.equal(view.warnings.liveNotRunning, false);
});

test('connected with battery optimization, a denied alarm permission and a dropped socket warns on all three', () => {
  const view = deriveInstantPushView({
    platformSupported: true,
    status: 'connected',
    transport: 'live',
    live: 'disconnected',
    batteryOptimized: true,
    exactAlarmsGranted: false,
  });
  assert.equal(view.kind, 'connected');
  assert.equal(view.warnings.battery, true);
  assert.equal(view.warnings.exactAlarms, true);
  assert.equal(view.warnings.liveNotRunning, true);
});

test('an FCM build never warns about the live socket it deliberately does not hold', () => {
  const view = deriveInstantPushView({
    platformSupported: true,
    status: 'connected',
    transport: 'fcm',
    live: 'stopped',
  });
  assert.equal(view.kind, 'connected');
  assert.equal(view.transport, 'fcm');
  assert.equal(view.warnings.liveNotRunning, false);
});

test('unknown device facts never fabricate battery or alarm warnings, an unknown live state counts as not running', () => {
  const view = deriveInstantPushView({ platformSupported: true, status: 'connected', transport: 'live' });
  assert.equal(view.kind, 'connected');
  assert.equal(view.warnings.battery, false);
  assert.equal(view.warnings.exactAlarms, false);
  assert.equal(view.warnings.liveNotRunning, true);
});
