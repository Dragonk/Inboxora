import { test } from 'node:test';
import assert from 'node:assert/strict';

// These tests run under plain Node (no Capacitor runtime), which is exactly the
// browser/PWA case: native push helpers must be inert so the existing Web Push
// path is never affected.
const { isNativePlatform, getNativePushStatus, clearNativePush, ensureNativePushRegistered } =
  await import('./nativePush.js');

test('native push helpers are inert outside a Capacitor native platform', async () => {
  delete globalThis.window;
  assert.equal(isNativePlatform(), false);

  const status = await getNativePushStatus();
  assert.equal(status.supported, false);
  assert.equal(status.status, 'unavailable');

  // Must resolve without touching the API or native bridge.
  await clearNativePush();
  const ensured = await ensureNativePushRegistered();
  assert.equal(ensured.status, 'unavailable');
});

test('a browser window without Capacitor is still treated as non-native', async () => {
  globalThis.window = {};
  assert.equal(isNativePlatform(), false);
  await clearNativePush();
  delete globalThis.window;
});
