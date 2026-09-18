import { api } from './api.ts';
import { isElectronShell } from './desktopShell.ts';

/**
 * Removes the Web Push path from an existing Electron installation.
 *
 * Earlier desktop builds exposed the browser Web Push card in Settings, so an
 * upgrader can already hold an active push subscription. That subscription lives
 * in the service worker and would keep showing OS notifications while the
 * Electron shell shows its own from the WebSocket — the exact duplicate this
 * feature is meant to prevent. The service worker serves nothing else in the
 * desktop shell (`public/sw.js` only handles push), so it is removed entirely.
 *
 * Endpoints whose server-side row could not be deleted yet (for example because
 * no session was available) are remembered and retried on the next call, which
 * `App` triggers again after sign-in. The local cleanup always runs regardless, so
 * duplicates stop immediately; the server prunes a dead endpoint on the next send.
 */

interface PushSubscriptionLike {
  endpoint: string;
  unsubscribe(): Promise<boolean>;
}

interface PushRegistrationLike {
  pushManager?: { getSubscription(): Promise<PushSubscriptionLike | null> } | null;
  unregister(): Promise<boolean>;
}

interface ServiceWorkerLike {
  getRegistrations(): Promise<readonly PushRegistrationLike[]>;
}

export interface DesktopPushCleanupDeps {
  isElectronShell(): boolean;
  getServiceWorker(): ServiceWorkerLike | undefined;
  pushUnsubscribe(payload: { endpoint: string }): Promise<unknown>;
  warn(message: string, error: unknown): void;
}

export interface DesktopPushCleanup {
  cleanup(): Promise<void>;
  /** Endpoints still awaiting their server-side removal (test/diagnostics seam). */
  pendingServerUnsubscribes(): string[];
}

async function readPushSubscription(registration: PushRegistrationLike): Promise<PushSubscriptionLike | null> {
  try {
    if (!registration.pushManager) return null;
    return await registration.pushManager.getSubscription();
  } catch {
    // No active worker / push service unavailable: treat as "no subscription".
    return null;
  }
}

export function createDesktopWebPushCleanup(deps: DesktopPushCleanupDeps): DesktopPushCleanup {
  const pending = new Set<string>();

  async function flushPendingServerUnsubscribes(): Promise<void> {
    for (const endpoint of [...pending]) {
      try {
        await deps.pushUnsubscribe({ endpoint });
        pending.delete(endpoint);
      } catch (error) {
        deps.warn('Could not remove the desktop Web Push subscription on the server.', error);
      }
    }
  }

  return {
    async cleanup() {
      if (!deps.isElectronShell()) return;

      const serviceWorker = deps.getServiceWorker();
      if (serviceWorker) {
        const registrations = await serviceWorker.getRegistrations().catch(() => []);
        for (const registration of registrations) {
          const subscription = await readPushSubscription(registration);
          if (subscription) {
            // Record first: the endpoint must be retried even if the local
            // unsubscribe below throws.
            pending.add(subscription.endpoint);
            await subscription.unsubscribe().catch(() => {});
          }
          await registration.unregister().catch(() => {});
        }
      }

      await flushPendingServerUnsubscribes();
    },

    pendingServerUnsubscribes() {
      return [...pending];
    },
  };
}

export const desktopWebPushCleanup = createDesktopWebPushCleanup({
  isElectronShell,
  getServiceWorker: () => (typeof navigator === 'undefined' ? undefined : navigator.serviceWorker),
  pushUnsubscribe: (payload) => api.pushUnsubscribe(payload),
  warn: (message, error) => console.warn(message, error),
});

export function cleanupDesktopWebPush(): Promise<void> {
  return desktopWebPushCleanup.cleanup();
}
