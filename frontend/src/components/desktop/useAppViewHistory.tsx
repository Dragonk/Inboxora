import { useEffect, useSyncExternalStore } from 'react';
import { useStore } from '../../store/index.ts';
import type { StoreState } from '../../store/index.ts';
import {
  createViewHistory,
  viewSnapshotFromState,
  viewSnapshotsEqual,
  type ViewHistory,
  type ViewSnapshot,
  type ViewHistoryState,
} from '../../utils/viewHistory.ts';

/**
 * Binds the pure view history to the Inboxora store.
 *
 * `AppViewHistoryRecorder` observes the fields that make up a "view" and appends
 * one history entry per change; the desktop title bar reads availability from
 * here and calls `navigateAppHistory()`. This is what makes Back/Forward follow
 * Inbox → message → Calendar → Contacts → Settings, which the browser's own
 * navigation history never sees (those are Zustand state swaps, not documents).
 */

const IDLE_STATE: ViewHistoryState = { canGoBack: false, canGoForward: false };

let history: ViewHistory | null = null;
const listeners = new Set<() => void>();

function readSnapshot(): ViewSnapshot {
  return viewSnapshotFromState(useStore.getState());
}

function getHistory(): ViewHistory {
  if (!history) history = createViewHistory(readSnapshot());
  return history;
}

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

/** Back / forward availability, stable until it actually changes. */
export function useAppViewHistoryState(): ViewHistoryState {
  return useSyncExternalStore(subscribe, () => getHistory().state(), () => IDLE_STATE);
}

/**
 * A message is only worth restoring when the reader can actually resolve it from
 * the loaded page. Otherwise the restore deliberately drops it (the history
 * entry is corrected) instead of opening an empty reading pane.
 */
function isMessageResolvable(messageId: string | null): boolean {
  if (!messageId) return false;
  const state = useStore.getState();
  if (state.messages.some((item) => item.id === messageId)) return true;
  if (state.searchResults.some((item) => item.id === messageId)) return true;
  return Object.values(state.threadMessages).some((rows) => rows.some((item) => item.id === messageId));
}

/** Restore a stored view. Returns whether the store actually changed. */
function applyViewSnapshot(snapshot: ViewSnapshot): boolean {
  const before = readSnapshot();
  const state = useStore.getState();

  state.setAdminTab(snapshot.adminTab);
  if (snapshot.surface === 'settings') {
    // Settings is an overlay: leave the surface under it untouched so closing the
    // panel returns to the view the user opened it from.
    state.setShowAdmin(true);
  } else {
    state.setShowAdmin(false);
    // setSelectedAccount() clears both surface flags, so the surface is applied
    // after it below.
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

  state.setSelectedMessage(isMessageResolvable(snapshot.messageId) ? snapshot.messageId : null);

  return !viewSnapshotsEqual(before, readSnapshot());
}

/** Step through the Inboxora view history. No-op at either end. */
export function navigateAppHistory(direction: 'back' | 'forward'): void {
  const current = getHistory();
  const target = direction === 'back' ? current.back() : current.forward();
  if (!target) return;

  if (!applyViewSnapshot(target)) {
    // Nothing changed, so no record() will follow to consume the correction.
    current.cancelPendingRestore();
  }
  notify();
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
    getHistory().reset(readSnapshot());
    notify();
  }, []);

  useEffect(() => {
    getHistory().record({
      surface,
      messageId: messageId ?? null,
      accountId: accountId ?? null,
      folder: folder || 'INBOX',
      adminTab,
    });
    notify();
  }, [accountId, adminTab, folder, messageId, surface]);

  return null;
}
