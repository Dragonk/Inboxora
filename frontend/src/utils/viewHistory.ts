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
  /**
   * A durable reference for the open message: the RFC `Message-ID` header when it
   * is known, else the row id. The physical row id is not stable — moving or
   * re-syncing a message regenerates it — so `messageId` alone cannot be used to
   * bring the message back (see api.resolveMessage()).
   */
  messageRef: string | null;
  /** Account the message belongs to; the same Message-ID can exist on two accounts. */
  messageAccountId: string | null;
  accountId: string | null;
  folder: string;
  adminTab: string;
}

/** What the binding knows about the open message while its row is still loaded. */
export interface ViewMessageHint {
  ref?: string | null;
  accountId?: string | null;
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
  /**
   * Replace the view stored at the current position without moving through the
   * history. Used when a restore resolves to a different physical row (a message
   * that moved and was re-created): that is still the same history step, not a new
   * navigation, and it must not truncate Forward.
   */
  replaceCurrent(snapshot: ViewSnapshot): void;
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
 *
 * `hint` carries what the caller knows about the open message's durable reference
 * and account, which is only available while its row is loaded.
 */
export function viewSnapshotFromState(state: ViewSourceState, hint?: ViewMessageHint): ViewSnapshot {
  const messageId = state.selectedMessageId ?? null;
  return {
    surface: state.showAdmin ? 'settings' : state.showContacts ? 'contacts' : state.showCalendar ? 'calendar' : 'mail',
    messageId,
    messageRef: hint?.ref ?? null,
    messageAccountId: hint?.accountId ?? null,
    accountId: state.selectedAccountId ?? null,
    folder: state.selectedFolder || 'INBOX',
    adminTab: state.adminTab,
  };
}

export function viewSnapshotsEqual(a: ViewSnapshot, b: ViewSnapshot): boolean {
  return a.surface === b.surface
    && a.messageId === b.messageId
    && a.messageRef === b.messageRef
    && a.messageAccountId === b.messageAccountId
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

    replaceCurrent(snapshot) {
      entries[index] = snapshot;
      pendingRestore = false;
    },

    cancelPendingRestore() {
      pendingRestore = false;
    },

    size() {
      return entries.length;
    },
  };
}
