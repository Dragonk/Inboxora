import { api } from './api.js';
import { installCapacitorNativeBridge } from './capacitorNativeBridge.js';

// Native (Android) push lifecycle, driven from JS but executed natively.
//
// The provider registration (UnifiedPush endpoint or FCM token) and the server
// POST /api/push/devices are owned by the native layer, because a new endpoint
// can arrive while the WebView process does not exist. JS is the coordinator:
// it triggers a refresh after login/host change and clears the device
// registration on logout, so the server never keeps a subscription for a session
// the user has left.

export function isNativePlatform() {
  return typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.() === true;
}

function unavailable(reason) {
  return { status: 'unavailable', transport: null, deviceId: null, supported: false, reason };
}

export async function getNativePushStatus() {
  if (!isNativePlatform()) return unavailable('not-native');
  await installCapacitorNativeBridge();
  const result = await window.inboxoraNative?.notifications?.getStatus?.().catch(() => null);
  return { status: 'unavailable', transport: null, deviceId: null, ...(result || {}), supported: true };
}

export async function registerNativePush() {
  if (!isNativePlatform()) return unavailable('not-native');
  await installCapacitorNativeBridge();
  const result = await window.inboxoraNative?.notifications?.register?.().catch(() => null);
  return { status: 'unavailable', transport: null, deviceId: null, ...(result || {}), supported: true };
}

// Idempotent launch-time check: only re-register when the native side does not
// already hold a confirmed endpoint + device token.
export async function ensureNativePushRegistered() {
  if (!isNativePlatform()) return unavailable('not-native');
  const status = await getNativePushStatus();
  if (status.status === 'connected') return status;
  return registerNativePush();
}

// Logout / host reset. Removes THIS device's server registration (scoped by the
// server to the session user) and every local secret, so no notification can
// arrive for the previous account. Other devices keep their own registrations.
export async function clearNativePush() {
  if (!isNativePlatform()) return;
  try {
    await installCapacitorNativeBridge();
    const status = await window.inboxoraNative?.notifications?.getStatus?.().catch(() => null);
    if (status?.deviceId) await api.removePushDevice(status.deviceId).catch(() => {});
    await window.inboxoraNative?.notifications?.clear?.().catch(() => {});
  } catch { /* never block sign-out on push cleanup */ }
}
