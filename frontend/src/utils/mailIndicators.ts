/** Serial badge writes: a slow older promise must not leave a newer zero undone. */
export function createBadgeWriter(apply: (count: number) => Promise<unknown>) {
  let desired = 0;
  let version = 0;
  let written = 0;
  let running: Promise<void> | undefined;
  const drain = (): Promise<void> => {
    if (running) return running;
    running = (async () => {
      while (written !== version) {
        const observed = version;
        try { await apply(desired); }
        catch { /* Unsupported/denied badge APIs must never break mail rendering. */ }
        written = observed;
      }
    })().finally(() => {
      running = undefined;
      // A preference can arrive in the microtask between loop completion/finally.
      if (written !== version) return drain();
    });
    return running;
  };
  return (count: number): Promise<void> => {
    desired = Number.isSafeInteger(count) && count > 0 ? count : 0;
    version += 1;
    return drain();
  };
}

/** Global unread scope is independent of the currently selected mailbox. */
export function mailIndicatorTitle(count: number, enabled: boolean): string {
  return enabled && Number.isSafeInteger(count) && count > 0 ? `(${count}) Inboxora` : 'Inboxora';
}

let current = { count: 0, enabled: false };
let observingController = false;
const writeBadge = createBadgeWriter(async count => {
  const nav = navigator;
  // A controlled PWA uses one SW writer and an authoritative count. It does not
  // mix stale push payload counts with a window's optimistic read state.
  const controller = nav.serviceWorker?.controller;
  if (controller) {
    controller.postMessage({ type: 'inboxora_badge_preferences', enabled: current.enabled });
    return;
  }
  if (count > 0 && typeof nav.setAppBadge === 'function') await nav.setAppBadge(count);
  else if (typeof nav.clearAppBadge === 'function') await nav.clearAppBadge();
  else if (typeof nav.setAppBadge === 'function') await nav.setAppBadge(0);
});
const writeNativeBadge = createBadgeWriter(async count => {
  await window.inboxoraNative?.badges?.setUnreadCount?.(count);
});

/** Title is the fallback in a normal tab; platform badges remain capability-dependent. */
export function syncMailIndicators(count: number, enabled: boolean): void {
  const normalized = Number.isSafeInteger(count) && count > 0 ? count : 0;
  current = { count: normalized, enabled };
  const value = enabled ? normalized : 0;
  document.title = mailIndicatorTitle(normalized, enabled);
  try {
    if (!observingController && navigator.serviceWorker) {
      observingController = true;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        void writeBadge(current.enabled ? current.count : 0);
      });
    }
  } catch { /* A blocked worker capability still leaves the browser title usable. */ }
  void writeBadge(value);
  void writeNativeBadge(value);
}

/** Clear private unread indicators on lock/logout/unmount, not on folder selection. */
export function clearMailIndicators(): void { syncMailIndicators(0, false); }
