import { useEffect, useSyncExternalStore } from 'react';
import { useStore } from '../../store/index.ts';
import type { StoreState, StoreMessageRow } from '../../store/index.ts';
import { api } from '../../utils/api.ts';
import {
  createViewHistory,
  viewSnapshotFromState,
  viewSnapshotsEqual,
  type ViewHistoryState,
  type ViewSnapshot,
} from '../../utils/viewHistory.ts';

/**
 * Binds the pure view history to the Inboxora store.
 *
 * `AppViewHistoryRecorder` observes the fields that make up a "view" and appends
 * one history entry per change; the desktop title bar reads availability from
 * here and calls `navigateAppHistory()`. This is what makes Back/Forward follow
 * Inbox → message → Calendar → Contacts → Settings, which the browser's own
 * navigation history never sees (those are Zustand state swaps, not documents).
 *
 * The store is injectable so the restore rules can be exercised against the real
 * `setSelectedAccount()` in tests without rendering React.
 */

const IDLE_STATE: ViewHistoryState = { canGoBack: false, canGoForward: false };
const PENDING_MESSAGE_PREFIX = '__history_';

type StoreApi = typeof useStore;

export interface AppViewHistoryOptions {
  /** Fetch a message that is not on the loaded page (defaults to api.resolveMessage). */
  resolveMessage?: (messageId: string) => Promise<StoreMessageRow | null>;
}

async function defaultResolveMessage(messageId: string): Promise<StoreMessageRow | null> {
  const message = await api.resolveMessage(messageId);
  return message && typeof message.id === 'string' ? message : null;
}

/**
 * A message restored by Back may live in a folder page that `setSelectedAccount()`
 * just cleared, so "not in the loaded arrays" does not mean "gone". Resolve it the
 * same durable way the deep-link path does (stable Message-ID first, then UUID) and
 * park it in `threadMessages`, which `setMessages()` does not evict.
 */
export function createAppViewHistory(options: AppViewHistoryOptions = {}) {
  const store: StoreApi = useStore;
  const resolveMessage = options.resolveMessage ?? defaultResolveMessage;
  const history = createViewHistory(viewSnapshotFromState(store.getState()));
  const listeners = new Set<() => void>();
  // Latest-wins token: a slow resolve must never write into a view the user has
  // already left.
  let restoreToken = 0;

  const readSnapshot = (): ViewSnapshot => viewSnapshotFromState(store.getState());

  function notify(): void {
    listeners.forEach((listener) => {
      try {
        listener();
      } catch {
        // A subscriber error must not break navigation.
      }
    });
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  /**
   * A message is only worth fetching when the reader cannot resolve it from the
   * loaded page.
   */
  function isMessageResolvable(messageId: string | null): boolean {
    if (!messageId) return false;
    const state = store.getState();
    if (state.messages.some((item) => item.id === messageId)) return true;
    if (state.searchResults.some((item) => item.id === messageId)) return true;
    return Object.values(state.threadMessages).some((rows) => rows.some((item) => item.id === messageId));
  }

  async function hydrateRestoredMessage(messageId: string, authEpoch: number): Promise<void> {
    const token = ++restoreToken;
    try {
      const message = await resolveMessage(messageId);
      if (!message || token !== restoreToken) return;

      const state = store.getState();
      // A message fetched for a previous session, or after the user navigated on,
      // must never be injected into the current view.
      if (state.authEpoch !== authEpoch) return;
      if (state.selectedMessageId !== messageId) return;

      state.setThreadMessages(`${PENDING_MESSAGE_PREFIX}${message.id}`, [message]);
      state.setSelectedMessage(message.id);
    } catch {
      // Leave the reader as it is; the history entry already points at the message.
    }
  }

  /** Restore a stored view. Returns whether the store actually changed. */
  function applySnapshot(snapshot: ViewSnapshot): boolean {
    const before = readSnapshot();
    const state = store.getState();

    state.setAdminTab(snapshot.adminTab);
    if (snapshot.surface === 'settings') {
      // Settings is an overlay: leave the surface under it untouched so closing the
      // panel returns to the view the user opened it from.
      state.setShowAdmin(true);
    } else {
      state.setShowAdmin(false);
    }

    // setSelectedAccount() resets the list and clears the open message, so it must
    // run before the message is restored — and only when it would actually change.
    if ((state.selectedAccountId ?? null) !== snapshot.accountId || state.selectedFolder !== snapshot.folder) {
      state.setSelectedAccount(snapshot.accountId, snapshot.folder);
    }

    if (snapshot.surface !== 'settings') {
      state.setShowContacts(snapshot.surface === 'contacts');
      state.setShowCalendar(snapshot.surface === 'calendar');
    }

    // Selected unconditionally — even when the row is not on the loaded page, which
    // is the normal case after a folder change. hydrateRestoredMessage() then makes
    // the reader able to render it, and because the stored view is reproduced
    // exactly the recorder's echo keeps Forward available.
    state.setSelectedMessage(snapshot.messageId);

    return !viewSnapshotsEqual(before, readSnapshot());
  }

  return {
    subscribe,
    getState: (): ViewHistoryState => history.state(),

    /** Called by the recorder after every observed view change. */
    record(): void {
      history.record(readSnapshot());
      notify();
    },

    /** Re-root the history at the current view (app mount). */
    reset(): void {
      history.reset(readSnapshot());
      notify();
    },

    /** Step through the Inboxora view history. No-op at either end. */
    navigate(direction: 'back' | 'forward'): void {
      const target = direction === 'back' ? history.back() : history.forward();
      if (!target) return;

      const authEpoch = store.getState().authEpoch;
      if (!applySnapshot(target)) {
        // Nothing changed, so no record() will follow to consume the correction.
        history.cancelPendingRestore();
      }
      notify();

      if (target.messageId && !isMessageResolvable(target.messageId)) {
        void hydrateRestoredMessage(target.messageId, authEpoch);
      }
    },
  };
}

export type AppViewHistory = ReturnType<typeof createAppViewHistory>;

export const appViewHistory = createAppViewHistory();

/** Back / forward availability, stable until it actually changes. */
export function useAppViewHistoryState(): ViewHistoryState {
  return useSyncExternalStore(appViewHistory.subscribe, appViewHistory.getState, () => IDLE_STATE);
}

/** Step through the Inboxora view history. No-op at either end. */
export function navigateAppHistory(direction: 'back' | 'forward'): void {
  appViewHistory.navigate(direction);
}

/** Mounted once with the mail app; records every view transition. */
export function AppViewHistoryRecorder() {
  const surface = useStore((state: StoreState) => (
    state.showAdmin ? 'settings' : state.showContacts ? 'contacts' : state.showCalendar ? 'calendar' : 'mail'
  ));
  const messageId = useStore((state: StoreState) => state.selectedMessageId);
  const accountId = useStore((state: StoreState) => state.selectedAccountId);
  const folder = useStore((state: StoreState) => state.selectedFolder);
  const adminTab = useStore((state: StoreState) => state.adminTab);

  // Root the history at the first real app view so the login screen is never a
  // Back target and a re-login does not inherit the previous session's trail.
  useEffect(() => {
    appViewHistory.reset();
  }, []);

  useEffect(() => {
    appViewHistory.record();
  }, [accountId, adminTab, folder, messageId, surface]);

  return null;
}
