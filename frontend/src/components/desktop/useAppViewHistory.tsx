import { useEffect, useSyncExternalStore } from 'react';
import { useStore } from '../../store/index.ts';
import type { StoreState, StoreMessageRow } from '../../store/index.ts';
import { api } from '../../utils/api.ts';
import { toAppError } from '../../utils/errors.ts';
import {
  createViewHistory,
  viewSnapshotFromState,
  viewSnapshotsEqual,
  type ViewHistoryState,
  type ViewMessageHint,
  type ViewSnapshot,
  type ViewSourceState,
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
// The cache below only has to outlive the loaded page of the messages the history
// points at; the history itself is capped at 60 entries.
const MESSAGE_REF_CACHE_LIMIT = 200;
// The backend rejects a non-UUID accountId with 400, so only a real id is sent.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type StoreApi = typeof useStore;

export interface AppViewHistoryOptions {
  /**
   * Raw exact-row lookup by primary key (`GET /mail/messages/:id`, a direct
   * `WHERE m.id = $1`). Rejects like the API when the row is missing; the factory
   * turns a 404 into "gone" itself, so the seam stays the raw call.
   */
  lookupMessage?: (id: string) => Promise<StoreMessageRow | null>;
  /**
   * Durable reference lookup (the RFC Message-ID when known, else the row id),
   * scoped to its account. Defaults to api.resolveMessage().
   */
  resolveMessage?: (ref: string, accountId?: string) => Promise<StoreMessageRow | null>;
}

export function accountScope(accountId: string | null | undefined): string | undefined {
  return typeof accountId === 'string' && UUID_PATTERN.test(accountId) ? accountId : undefined;
}

/** A missing row is an expected outcome here, not a failure. */
function isNotFound(error: unknown): boolean {
  return toAppError(error).status === 404;
}

function defaultLookupMessage(id: string): Promise<StoreMessageRow | null> {
  return api.getMessage(id);
}

async function defaultResolveMessage(ref: string, accountId?: string): Promise<StoreMessageRow | null> {
  const message = await api.resolveMessage(ref, accountScope(accountId));
  return message && typeof message.id === 'string' ? message : null;
}

/**
 * A message restored by Back may live in a folder page that `setSelectedAccount()`
 * just cleared, so "not in the loaded arrays" does not mean "gone". Ask for the
 * exact row first and fall back to the durable reference only when it is really
 * gone — the same durable lookup the deep-link path uses, so a message that was
 * moved and re-created (new row id) is still found — then park it in
 * `threadMessages`, which `setMessages()` does not evict.
 */
export function createAppViewHistory(options: AppViewHistoryOptions = {}) {
  const store: StoreApi = useStore;
  const lookupMessage = options.lookupMessage ?? defaultLookupMessage;
  const resolveMessage = options.resolveMessage ?? defaultResolveMessage;
  const history = createViewHistory(viewSnapshotFromState(store.getState()));
  const listeners = new Set<() => void>();
  // Physical row id -> durable reference, learned while the row was still loaded.
  // Only the row carries the RFC Message-ID, and the history entry has to keep
  // pointing at the message after that page has been replaced.
  const messageRefs = new Map<string, Required<ViewMessageHint>>();
  // Latest-wins token: a slow resolve must never write into a view the user has
  // already left.
  let restoreToken = 0;

  function findOpenRow(state: StoreState, messageId: string): StoreMessageRow | null {
    const inMessages = state.messages.find((row) => row.id === messageId);
    if (inMessages) return inMessages;
    const inSearch = state.searchResults.find((row) => row.id === messageId);
    if (inSearch) return inSearch;
    for (const rows of Object.values(state.threadMessages)) {
      const match = rows.find((row) => row.id === messageId);
      if (match) return match;
    }
    return null;
  }

  function rememberMessageRef(row: StoreMessageRow): void {
    const accountId = typeof row.account_id === 'string' && row.account_id ? row.account_id : null;
    messageRefs.delete(row.id);
    messageRefs.set(row.id, { ref: row.message_id || row.id, accountId });
    while (messageRefs.size > MESSAGE_REF_CACHE_LIMIT) {
      const oldest = messageRefs.keys().next();
      if (oldest.done) break;
      messageRefs.delete(oldest.value);
    }
  }

  function rememberOpenMessage(): void {
    const state = store.getState();
    const messageId = state.selectedMessageId;
    if (!messageId) return;
    const row = findOpenRow(state, messageId);
    if (row) rememberMessageRef(row);
  }

  function snapshotFrom(state: StoreState, messageId: string | null, hint?: ViewMessageHint): ViewSnapshot {
    const source: ViewSourceState = {
      showContacts: state.showContacts,
      showCalendar: state.showCalendar,
      showAdmin: state.showAdmin,
      selectedMessageId: messageId,
      selectedAccountId: state.selectedAccountId,
      selectedFolder: state.selectedFolder,
      adminTab: state.adminTab,
    };
    return viewSnapshotFromState(source, hint);
  }

  function readSnapshot(): ViewSnapshot {
    const state = store.getState();
    const messageId = state.selectedMessageId ?? null;
    return snapshotFrom(state, messageId, messageId ? messageRefs.get(messageId) : undefined);
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

  /**
   * A message is only worth fetching when the reader cannot resolve it from the
   * loaded page.
   */
  function isMessageResolvable(messageId: string | null): boolean {
    if (!messageId) return false;
    return findOpenRow(store.getState(), messageId) !== null;
  }

  /**
   * The exact row, or null when it is really gone. The API rejects a missing row
   * with 404; that is the one failure that means "fall back", so it is normalized
   * here and every other error keeps propagating.
   */
  async function getExactMessage(messageId: string): Promise<StoreMessageRow | null> {
    try {
      const message = await lookupMessage(messageId);
      return message && typeof message.id === 'string' ? message : null;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async function hydrateRestoredMessage(target: ViewSnapshot, authEpoch: number): Promise<void> {
    const token = ++restoreToken;
    const physicalId = target.messageId;
    const reference = target.messageRef ?? physicalId;
    if (!physicalId || !reference) return;

    try {
      // 1) The exact physical row wins. The same Message-ID can exist in more than
      //    one folder of an account (INBOX + Archive), and the durable lookup
      //    prefers the INBOX copy — which would silently swap the copy the user was
      //    reading. A row that is gone reports null (404), never a throw, so the
      //    fallback below is reachable.
      let message = await getExactMessage(physicalId);
      if (token !== restoreToken) return;

      if (!message && reference !== physicalId) {
        // 2) The row is gone (moved or re-synced): fall back to the durable
        //    reference, scoped to the account because the same Message-ID can exist
        //    on two connected accounts. Only a genuine 404 gets here; any other
        //    failure propagates to the catch below and the copy is left alone.
        message = await resolveMessage(reference, target.messageAccountId ?? undefined);
        if (token !== restoreToken) return;
      }
      if (!message) return;

      const state = store.getState();
      // A message fetched for a previous session, or after the user navigated on,
      // must never be injected into the current view.
      if (state.authEpoch !== authEpoch) return;
      if (state.selectedMessageId !== target.messageId) return;

      rememberMessageRef(message);
      state.setThreadMessages(`${PENDING_MESSAGE_PREFIX}${message.id}`, [message]);
      // The resolved row can carry a different physical id (the message moved and
      // was re-created). That is still the same history step, so record the new id
      // in place — otherwise the recorder would treat it as a new navigation and
      // truncate Forward. Done before selecting, so the entry is already correct
      // whenever the recorder's effect runs.
      history.replaceCurrent(snapshotFrom(state, message.id, {
        ref: message.message_id || message.id,
        accountId: message.account_id ?? null,
      }));
      state.setSelectedMessage(message.id);
    } catch (error) {
      // Navigation must not break because a lookup failed, and a message that is
      // simply gone (404) is an expected outcome. Anything else is a real failure
      // worth surfacing instead of hiding.
      if (!isNotFound(error)) {
        console.error('Could not restore the message from the desktop history:', toAppError(error).message);
      }
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
      rememberOpenMessage();
      history.record(readSnapshot());
      notify();
    },

    /** Re-root the history at the current view (app mount). */
    reset(): void {
      rememberOpenMessage();
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
        void hydrateRestoredMessage(target, authEpoch);
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
