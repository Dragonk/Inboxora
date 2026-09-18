/**
 * Application-level view history for the desktop title bar's Back / Forward.
 *
 * Inboxora navigates mostly by swapping Zustand state, not by pushing browser
 * documents, so `webContents.navigationHistory` never contains "the message I
 * had open" or "the Calendar view" — it only tracks real document loads (login,
 * OAuth). The title bar therefore walks this explicit history instead.
 *
 * This module is deliberately React- and store-free so the rules below are
 * unit-testable; `useAppViewHistory.tsx` is the binding.
 */

export type ViewSurface = 'mail' | 'calendar' | 'contacts' | 'settings';

export interface ViewSnapshot {
  surface: ViewSurface;
  messageId: string | null;
  accountId: string | null;
  folder: string;
  adminTab: string;
}

export interface ViewHistoryState {
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface ViewHistory {
  /** Append a view, unless it repeats the current position. */
  record(snapshot: ViewSnapshot): void;
  /** Step back; returns the view to restore, or null at the start. */
  back(): ViewSnapshot | null;
  /** Step forward; returns the view to restore, or null at the end. */
  forward(): ViewSnapshot | null;
  current(): ViewSnapshot;
  /** Cached so React's useSyncExternalStore sees a stable reference. */
  state(): ViewHistoryState;
  /** Root the history at a fresh view (used when the app mounts). */
  reset(snapshot: ViewSnapshot): void;
  /** Drop a restore that never produced a state change. */
  cancelPendingRestore(): void;
  size(): number;
}

export const VIEW_HISTORY_LIMIT = 60;

/** The store fields that make up a view. */
export interface ViewSourceState {
  showContacts: boolean;
  showCalendar: boolean;
  showAdmin: boolean;
  selectedMessageId: string | null;
  selectedAccountId: string | null;
  selectedFolder: string;
  adminTab: string;
}

/**
 * The single place that decides what a "view" is. The Settings overlay wins over
 * the surface under it so opening it is its own step; `applyViewSnapshot` in the
 * React binding keeps that underlying surface, so closing Settings returns where
 * the user was.
 */
export function viewSnapshotFromState(state: ViewSourceState): ViewSnapshot {
  return {
    surface: state.showAdmin ? 'settings' : state.showContacts ? 'contacts' : state.showCalendar ? 'calendar' : 'mail',
    messageId: state.selectedMessageId ?? null,
    accountId: state.selectedAccountId ?? null,
    folder: state.selectedFolder || 'INBOX',
    adminTab: state.adminTab,
  };
}

export function viewSnapshotsEqual(a: ViewSnapshot, b: ViewSnapshot): boolean {
  return a.surface === b.surface
    && a.messageId === b.messageId
    && a.accountId === b.accountId
    && a.folder === b.folder
    && a.adminTab === b.adminTab;
}

export function createViewHistory(initial: ViewSnapshot, limit = VIEW_HISTORY_LIMIT): ViewHistory {
  let entries: ViewSnapshot[] = [initial];
  let index = 0;
  // Set while a stored view is being restored. The store cannot always reproduce a
  // snapshot exactly — for example a message that is no longer on the loaded page
  // falls back to "no message open". That echo must correct the current entry
  // rather than count as a brand-new view, or Forward would be silently stranded.
  let pendingRestore = false;
  let stateCache: ViewHistoryState = { canGoBack: false, canGoForward: false };

  const refreshState = (): ViewHistoryState => {
    const next: ViewHistoryState = {
      canGoBack: index > 0,
      canGoForward: index < entries.length - 1,
    };
    if (next.canGoBack !== stateCache.canGoBack || next.canGoForward !== stateCache.canGoForward) {
      stateCache = next;
    }
    return stateCache;
  };

  return {
    record(snapshot) {
      if (viewSnapshotsEqual(snapshot, entries[index])) {
        pendingRestore = false;
        return;
      }

      if (pendingRestore) {
        pendingRestore = false;
        entries[index] = snapshot;
        return;
      }

      entries = entries.slice(0, index + 1);
      entries.push(snapshot);
      if (entries.length > limit) entries = entries.slice(entries.length - limit);
      index = entries.length - 1;
      refreshState();
    },

    back() {
      if (index === 0) return null;
      index -= 1;
      pendingRestore = true;
      refreshState();
      return entries[index];
    },

    forward() {
      if (index >= entries.length - 1) return null;
      index += 1;
      pendingRestore = true;
      refreshState();
      return entries[index];
    },

    current() {
      return entries[index];
    },

    state() {
      return refreshState();
    },

    reset(snapshot) {
      entries = [snapshot];
      index = 0;
      pendingRestore = false;
      refreshState();
    },

    cancelPendingRestore() {
      pendingRestore = false;
    },

    size() {
      return entries.length;
    },
  };
}
