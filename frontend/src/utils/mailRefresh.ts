import { invalidateMailListCache } from './mailListCache.ts';
import { api } from './api.ts';
import { useStore } from '../store/index.ts';
import { refreshUnreadCounts, invalidateUnreadCountRequests } from './unreadRefresh.ts';
import { accountAffectsUnifiedInbox } from './unifiedInbox.ts';
import { createCoalescedTask } from './coalescedTask.ts';
import { recordDiagEvent } from './diagEvents.ts';

let sessionEpoch: number | undefined;
let lifetime = 0;
let allAccounts = false;
let accounts = new Set<string>();
let worker: ReturnType<typeof createCoalescedTask> | undefined;
let loadedKey = '';
let loadedAt = 0;
let lastCountsAttemptAt = 0;

/** A successful GET belongs to the current authenticated view, not socket liveness. */
function viewKey(): string {
  const state = useStore.getState();
  return JSON.stringify([state.authEpoch, state.selectedAccountId, state.selectedFolder,
    state.searchQuery, state.messagesRefreshToken]);
}
export function noteMailListLoaded(): void {
  loadedKey = viewKey();
  loadedAt = Date.now();
}
export function mailListNeedsRefresh(maxAgeMs = 50_000): boolean {
  const state = useStore.getState();
  if (state.showContacts || state.showCalendar) return Date.now() - lastCountsAttemptAt >= maxAgeMs;
  return loadedKey !== viewKey() || Date.now() - loadedAt >= maxAgeMs || Date.now() < loadedAt;
}

/** Tear down pending work on lock/logout; every asynchronous write also checks authEpoch. */
export function cancelMailRefresh(): void {
  invalidateMailListCache();
  lifetime += 1;
  invalidateUnreadCountRequests();
  worker?.dispose();
  worker = undefined;
  allAccounts = false;
  accounts = new Set();
  loadedKey = '';
  loadedAt = 0;
  lastCountsAttemptAt = 0;
  sessionEpoch = undefined;
}

/** Merge WS, SW, visibility and fallback hints. No provider sync or whole-page reload. */
export function requestMailRefresh(accountId?: string): void {
  const state = useStore.getState();
  if (!state.user || state.isLocked) return;
  invalidateMailListCache(accountId);
  if (sessionEpoch !== state.authEpoch) {
    cancelMailRefresh();
    sessionEpoch = state.authEpoch;
  }
  if (accountId) accounts.add(accountId);
  else allAccounts = true;
  if (!worker) {
    const epoch = state.authEpoch;
    const generation = lifetime;
    worker = createCoalescedTask(async () => {
      const state = useStore.getState();
      if (lifetime !== generation || state.authEpoch !== epoch || !state.user || state.isLocked) return;
      const global = allAccounts;
      const affected = accounts;
      allAccounts = false;
      accounts = new Set();
      const relevant = global || [...affected].some(id => state.selectedAccountId === id
        || (state.selectedAccountId === null && accountAffectsUnifiedInbox(state.accounts, id)));
      if (relevant) {
        window.dispatchEvent(new CustomEvent('inboxora:refresh', { detail: { refreshThreads: true } }));
        window.dispatchEvent(new CustomEvent('inboxora:sync_done'));
      }
      const folderAccounts = global ? Object.keys(state.folders) : [...affected].filter(id => state.folders[id]);
      lastCountsAttemptAt = Date.now();
      await Promise.all([
        refreshUnreadCounts(),
        ...folderAccounts.map(async id => {
          try {
            const folders = await api.getFolders(id);
            const current = useStore.getState();
            if (lifetime === generation && current.authEpoch === epoch && current.user && !current.isLocked) current.setFolders(id, folders);
          } catch { /* Keep the last snapshot. The next event or freshness check retries. */ }
        }),
      ]);
    }, { onError: () => recordDiagEvent({ category: 'event', type: 'mail_refresh_failed' }) });
  }
  worker.request();
}
