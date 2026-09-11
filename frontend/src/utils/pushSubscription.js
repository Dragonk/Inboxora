import { api } from './api.js';

let pending = null;
let lastSuccess = 0;
// Restore an already granted subscription on normal app launch, not only when
// the settings page is visited. Never request notification permission here.
export function restorePushSubscription() {
  if (!('serviceWorker' in navigator) || !('Notification' in window) || Notification.permission !== 'granted') return Promise.resolve(false);
  if (pending) return pending;
  if (Date.now() - lastSuccess < 60000) return Promise.resolve(true);
  pending = (async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg?.pushManager) return false;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return false;
    await api.pushSubscribe(sub.toJSON());
    lastSuccess = Date.now();
    return true;
  })().catch(() => false).finally(() => { pending = null; });
  return pending;
}
