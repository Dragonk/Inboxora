// One badge writer in the service worker. Never treat a delayed push count as
// current server truth. This script performs no fetch interception or caching.
(() => {
  let enabled;
  let generation = 0;
  let desired = false;
  let work = null;
  let preferenceWrites = Promise.resolve();

  function preferenceStore(writeValue) {
    return new Promise(resolve => {
      let done = false;
      const finish = value => { if (!done) { done = true; resolve(value); } };
      const timeout = setTimeout(() => finish(false), 3000);
      const settle = value => { clearTimeout(timeout); finish(value); };
      try {
        const request = indexedDB.open('mailflow-nav', 1);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains('kv')) request.result.createObjectStore('kv');
        };
        request.onerror = () => settle(false);
        request.onblocked = () => settle(false);
        request.onsuccess = () => {
          const db = request.result;
          if (done) { db.close(); return; }
          try {
            const tx = db.transaction('kv', writeValue === undefined ? 'readonly' : 'readwrite');
            const store = tx.objectStore('kv');
            const op = writeValue === undefined ? store.get('badge_enabled') : store.put(writeValue, 'badge_enabled');
            tx.oncomplete = () => { db.close(); settle(writeValue === undefined ? op.result === true : writeValue); };
            tx.onerror = tx.onabort = () => { db.close(); settle(false); };
          } catch (_) { db.close(); settle(false); }
        };
      } catch (_) { settle(false); }
    });
  }

  async function apply(count) {
    const nav = self.navigator;
    if (count > 0 && typeof nav?.setAppBadge === 'function') await nav.setAppBadge(count);
    else if (typeof nav?.clearAppBadge === 'function') await nav.clearAppBadge();
    else if (typeof nav?.setAppBadge === 'function') await nav.setAppBadge(0);
  }

  function request() {
    desired = true;
    if (work) return work;
    work = (async () => {
      while (desired) {
        desired = false;
        if (enabled === undefined) {
          const before = generation;
          const stored = await preferenceStore();
          if (generation === before) enabled = stored;
        }
        const before = generation;
        if (!enabled) { await apply(0).catch(() => {}); continue; }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        try {
          const response = await fetch('/api/mail/unread-counts', {
            credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
            headers: { 'X-Requested-With': 'MailFlow' },
          });
          if (response.status === 401 || response.status === 423) {
            if (generation === before) await apply(0);
            continue;
          }
          if (!response.ok) continue; // retain the last badge on transient failure
          const counts = await response.json();
          if (generation !== before) continue; // a newer preference/session owns the badge
          if (!Number.isSafeInteger(counts.total) || counts.total < 0) continue;
          await apply(enabled ? counts.total : 0);
        } catch (_) { /* Offline/denied badges do not prevent notifications or page refresh. */ }
        finally { clearTimeout(timeout); }
      }
    })().finally(() => {
      work = null;
      // Cover a request arriving in the final microtask after the loop finished.
      if (desired) return request();
    });
    return work;
  }

  self.addEventListener('message', event => {
    if (event.data?.type !== 'inboxora_badge_preferences' || typeof event.data.enabled !== 'boolean') return;
    try {
      if (!event.source?.url || new URL(event.source.url).origin !== self.location.origin) return;
    } catch (_) { return; }
    generation += 1;
    enabled = event.data.enabled;
    const writeValue = enabled;
    // Preserve preference order even if separate IndexedDB opens resolve late.
    preferenceWrites = preferenceWrites.then(() => preferenceStore(writeValue));
    event.waitUntil(Promise.allSettled([preferenceWrites, request()]));
  });
  self.inboxoraRefreshBadge = request;
})();
