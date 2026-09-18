import { api } from './api.ts';
import { isElectronShell } from './desktopShell.ts';

let pending: Promise<boolean> | null = null;
let lastSuccess = 0;
// Restore an already granted subscription on normal app launch, not only when
// the settings page is visited. Never request notification permission here.
export function restorePushSubscription() {
  // The Electron shell shows native OS notifications straight from the Inboxora
  // WebSocket. Keeping a Web Push subscription alive as well would deliver a
  // second system notification for the same message, so Web Push stays a
  // browser/PWA-only path.
  if (isElectronShell()) return Promise.resolve(false);
  if (!('serviceWorker' in navigator) || !('Notification' in window) || Notification.permission !== 'granted') return Promise.resolve(false);
  if (pending) return pending;
  if (Date.now() - lastSuccess < 60000) return Promise.resolve(true);
  pending = (async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return false;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return false;
    await api.pushSubscribe(sub.toJSON());
    lastSuccess = Date.now();
    return true;
  })().catch(() => false).finally(() => { pending = null; });
  return pending;
}
