import { resolveSelectedAccount, pruneFolders } from '../utils/accountScope.ts';
import { create } from 'zustand';
import { api } from '../utils/api.ts';
import { accountAffectsUnifiedInbox } from '../utils/unifiedInbox.ts';
import {
  applyTheme,
  applyCustomCss,
  resolveTheme,
  readThemePrefs,
  normalizeThemeMode,
  themeTone,
  THEME_MODES, isThemeName } from '../themes.ts';
import { applyFontSet, applyFontSize, effectiveFontSet, isRetroFont, isThemeFont } from '../fonts.ts';
import type { GtdSections , GtdRemovalSnapshot } from '../utils/gtd.ts';
import { applyLayout, normalizeLayout } from '../layouts.ts';
import { PANEL_WIDTH_STORAGE_KEY, savedPanelWidth } from '../utils/panelWidth.ts';
import { DEFAULT_AI_ACTIONS } from '../aiActions.ts';
import {
  removeGtdThreadFromSections,
  restoreGtdThreadRemoval,
  setGtdThreadReadInSections,
  snapshotGtdThreadRemoval,
  appendMessagesByIdentity,
  dedupeByIdentity,
  missingByIdentity,
} from '../utils/gtd.ts';
import { applyGtdRemovalGuard } from '../utils/pendingGtdRemovals.ts';
import { clampRightSidebarWidth } from '../utils/rightSidebar.ts';
import {
  cacheFolderOrderFromPreferences,
  mergeFolderOrder,
  readFolderOrder,
} from './folderOrder.ts';
import { removeThreadCacheEntry } from '../utils/threadedArchive.ts';
import { DEFAULT_CALENDAR_PREFERENCES, normalizeCalendarWorkDays, normalizeCalendarWorkTime } from '../utils/calendarPreferences.ts';
import i18n from '../i18n.ts';

/** A message row as the store holds it. */
/** The signed-in user as the store holds it. */
/** A favourite folder entry. */
interface FavoriteFolderRow { accountId?: string; path: string; name?: string; label?: string; [key: string]: unknown }

export interface StoreUserRow { id?: string; username?: string; email?: string; displayName?: string; avatar?: string | null; isAdmin?: boolean; [key: string]: unknown }

/**
 * The store state. Written from the store itself (every member is declared here so the
 * store no longer needs create<any>).
 */
/**
 * The store state. Written from the store itself (every member is declared here so the store
 * no longer needs create<any>).
 */
/** The draft the compose window opens with. */
export interface ComposeDraft {
  accountId?: string;
  aliasId?: string | null;
  to?: string | string[] | Array<{ email: string; name?: string | null }>;
  cc?: string | string[] | Array<{ email: string; name?: string | null }>;
  bcc?: string | string[] | Array<{ email: string; name?: string | null }>;
  subject?: string;
  body?: string;
  bodyIsHtml?: boolean;
  quotedBody?: string;
  quotedBodyHtml?: string | null;
  isReply?: boolean;
  isReplyAll?: boolean;
  isForward?: boolean;
  inReplyTo?: string | null;
  references?: string | null;
  originalFrom?: string | string[] | Array<{ email: string; name?: string | null }>;
  allRecipients?: string[];
  forwardedAttachments?: Array<{ messageId?: string; part?: string; filename?: string | null; size?: number | null; [key: string]: unknown }>;
  threadId?: string;
  threadCacheId?: string;
  conversationId?: string;
  draftFolder?: string;
  draftUid?: number;
  [key: string]: unknown;
}


export interface StoreState {
  user: StoreUserRow | null;
  setUser: (user: StoreUserRow | null) => void;
  updateUser: (updates: Record<string, unknown>) => void;
  enabledPlugins: string[];
  setPluginActivated: (id: string, activated: boolean) => Promise<void>;
  todoistConnected: boolean;
  setTodoistConnected: (connected: boolean) => void;
  isLocked: boolean;
  setLocked: (locked: boolean) => void;
  lockScreen: () => void;
  autoLockMinutes: number;
  setAutoLockMinutes: (m: number) => void;
  accounts: Array<{ id: string; name?: string | null; email_address?: string | null; sender_name?: string | null; color?: string | null; signature?: string | null; sync_error?: string | null; last_sync?: string | number | null; imap_host?: string | null; imap_port?: number | string | null; categorization_enabled?: boolean; enabled?: boolean; include_in_unified_inbox?: boolean; aliases?: Array<{ id: string; email?: string | null; name?: string | null; signature?: string | null; [key: string]: unknown }>; folder_mappings?: { inbox?: string | null; spam?: string | null; sent?: string | null; drafts?: string | null; trash?: string | null; archive?: string | null; [key: string]: unknown } | null; [key: string]: unknown }>;
  accountsReady: boolean;
  setAccounts: (accounts: Array<{
      id: string;
      enabled?: boolean;
      include_in_unified_inbox?: boolean;
      [key: string]: unknown;
  }>) => void;
  updateAccount: (id: string, updates: Record<string, unknown>) => void;
  selectedAccountId: string | null;
  selectedFolder: string;
  messagesRefreshToken: number;
  setSelectedAccount: (accountId: string | null, folder?: string) => void;
  messages: StoreMessageRow[];
  setMessages: (messages: StoreMessageRow[]) => void;
  appendMessages: (newMessages: StoreMessageRow[]) => void;
  updateMessage: (id: string, updates: Record<string, unknown>) => void;
  removeMessage: (id: string) => void;
  removeMessages: (ids: string[]) => void;
  restoreMessages: (msgs: StoreMessageRow[]) => void;
  messagesOffset: number;
  setMessagesOffset: (offset: number) => void;
  messagesTotal: number;
  setMessagesTotal: (total: number) => void;
  hasMoreMessages: boolean;
  setHasMoreMessages: (v: boolean) => void;
  selectedMessageId: string | null;
  lastViewedMessageId: string | null;
  setSelectedMessage: (id: string) => void;
  unreadCounts: {
      total: number;
      byAccount: Record<string, number>;
  };
  setUnreadCounts: (counts: { total: number; byAccount: Record<string, number> }) => void;
  decrementUnread: (accountId: string, count?: number) => void;
  incrementUnread: (accountId: string, count?: number) => void;
  folders: Record<string, Array<{ path: string; name?: string | null; special_use?: string | null; unread_count?: number; [key: string]: unknown }>>;
  setFolders: (accountId: string, folders: Array<{ path: string; unread_count?: number }>) => void;
  adjustFolderUnread: (accountId: string, folderPath: string | undefined, delta: number) => void;
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  sidebarWidth: number;
  setSidebarWidth: (w: number) => void;
  isSidebarResizing: boolean;
  setIsSidebarResizing: (v: boolean) => void;
  pageSize: number;
  setPageSize: (size: number) => void;
  scrollMode: string;
  setScrollMode: (mode: string) => void;
  searchAllFolders: boolean;
  setSearchAllFolders: (v: boolean) => void;
  swipeActions: { left?: string; right?: string; [key: string]: unknown };
  setSwipeAction: (direction: string, action: string) => void;
  syncInterval: number;
  setSyncInterval: (seconds: number) => void;
  folderSyncInterval: number;
  setFolderSyncInterval: (seconds: number) => void;
  notificationSound: string;
  setNotificationSound: (sound: string) => void;
  customSoundDataUrl: string | null;
  setCustomSoundDataUrl: (dataUrl: string) => void;
  composing: boolean;
  composeData: ComposeDraft | null;
  openCompose: (data?: ComposeDraft | null) => void;
  closeCompose: () => void;
  messageWindows: Array<{ winId?: string; messageId?: string; z?: number; id?: string; [key: string]: unknown }>;
  _winSeq: number;
  openMessageWindow: (messageId: string) => void;
  closeMessageWindow: (winId: string) => void;
  focusMessageWindow: (winId: string) => void;
  setMessageWindowMinimized: (winId: string, minimized: boolean) => void;
  updateMessageWindowRect: (winId: string, rect: {
      x?: number;
      y?: number;
      width?: number;
      height?: number;
  }) => void;
  closeAllMessageWindows: () => void;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  isSearching: boolean;
  setIsSearching: (v: boolean) => void;
  searchResults: StoreMessageRow[];
  setSearchResults: (r: StoreMessageRow[]) => void;
  loadingMessages: boolean;
  setLoadingMessages: (v: boolean) => void;
  notifications: Array<{ id: string; [key: string]: unknown }>;
  addNotification: (n: {
      id?: string;
      [key: string]: unknown;
  }) => void;
  removeNotification: (id: string) => void;
  showAdmin: boolean;
  adminTab: string;
  setShowAdmin: (v: boolean) => void;
  setAdminTab: (t: string) => void;
  showContacts: boolean;
  setShowContacts: (showContacts: boolean) => void;
  showCalendar: boolean;
  setShowCalendar: (showCalendar: boolean) => void;
  calendarWeekStartsOn: number;
  setCalendarWeekStartsOn: (calendarWeekStartsOn: number) => void;
  visibleCalendarIds: string[] | null;
  setVisibleCalendarIds: (visibleCalendarIds: string[]) => void;
  mobileNavigationPosition: string;
  setMobileNavigationPosition: (mobileNavigationPosition: string) => void;
  calendarInviteAccountId: string;
  setCalendarInviteAccountId: (calendarInviteAccountId: string | null) => void;
  calendarWorkDays: number[];
  setCalendarWorkDays: (calendarWorkDays: number[]) => void;
  calendarWorkHoursStart: string;
  calendarWorkHoursPersisted: {
      start: string;
      end: string;
  };
  calendarWorkHoursError: string;
  setCalendarWorkHoursStart: (value: string) => void;
  calendarWorkHoursEnd: string;
  setCalendarWorkHoursEnd: (value: string) => void;
  rulesPreFill: { fromEmail?: string | null; fromName?: string | null; subject?: string | null; [key: string]: unknown } | null;
  setRulesPreFill: (v: { fromEmail?: string | null; fromName?: string | null; subject?: string | null; [key: string]: unknown } | null) => void;
  backfillProgress: Record<string, { total?: number; synced?: number; [key: string]: unknown }>;
  setBackfillProgress: (accountId: string, progress: Record<string, unknown>) => void;
  mobileSidebarOpen: boolean;
  setMobileSidebarOpen: (v: boolean) => void;
  language: string;
  setLanguage: (lng: string) => void;
  conversationReaderViewEnabled: boolean;
  setConversationReaderViewEnabled: (val: boolean) => void;
  threadedView: boolean;
  setThreadedView: (val: boolean) => void;
  plaintextEmail: boolean;
  setPlaintextEmail: (val: boolean) => void;
  hoverQuickActions: boolean;
  setHoverQuickActions: (val: boolean) => void;
  showMobileAvatars: boolean;
  setShowMobileAvatars: (val: boolean) => void;
  gravatarAvatars: boolean;
  setGravatarAvatars: (val: boolean) => void;
  showMessagePreviews: boolean;
  setShowMessagePreviews: (val: boolean) => void;
  replyDefault: string;
  setReplyDefault: (val: string) => void;
  markReadBehavior: string;
  setMarkReadBehavior: (val: string) => void;
  markReadDelay: number;
  setMarkReadDelay: (val: string | number) => void;
  expandedThreadId: string | null;
  setExpandedThreadId: (id: string | null) => void;
  threadMessages: Record<string, StoreMessageRow[]>;
  setThreadMessages: (threadId: string, msgs: StoreMessageRow[]) => void;
  clearThreadMessages: (threadId: string) => void;
  loadingThread: string | null;
  setLoadingThread: (id: string | null) => void;
  themeMode: string;
  lightTheme: string;
  darkTheme: string;
  theme: string;
  applyThemeSelection: (partial: {
      light?: string;
      dark?: string;
      [key: string]: unknown;
  }) => void;
  setThemeMode: (mode: string) => void;
  setLightTheme: (theme: string) => void;
  setDarkTheme: (theme: string) => void;
  setTheme: (theme: string) => void;
  syncSystemTheme: () => void;
  fontSet: string;
  setFontSet: (fontSet: string) => void;
  fontSize: number;
  setFontSize: (pct: number) => void;
  showAppBadge: boolean;
  setShowAppBadge: (val: boolean) => void;
  categorizationEnabled: boolean;
  setCategorizationEnabled: (val: boolean) => void;
  categoryCounts: Record<string, number>;
  setCategoryCounts: (counts: Record<string, number>) => void;
  adjustCategoryCount: (category: string | null | undefined, delta: number) => void;
  rightSidebarWidth: number;
  setRightSidebarWidth: (w: number) => void;
  isRightSidebarResizing: boolean;
  setIsRightSidebarResizing: (v: boolean) => void;
  rightSidebarHidden: boolean;
  toggleRightSidebarHidden: () => void;
  gtdCollapsedSections: Record<string, boolean>;
  toggleGtdSection: (section: string) => void;
  activeGtdTab: string | null;
  setActiveGtdTab: (tab: string | null) => void;
  gtdSections: GtdSections | null;
  fetchGtdSections: () => Promise<void>;
  scheduleGtdSectionsFetch: () => void;
  removeGtdThread: (identity: string, states: string[]) => void;
  restoreGtdThread: (snapshot: GtdRemovalSnapshot) => void;
  markGtdThreadRead: (identity: string, isRead: boolean) => void;
  markGtdThreadStarred: (identity: string, isStarred: boolean) => void;
  gtdPetSlug: string | null;
  setGtdPetSlug: (slug: string) => void;
  layout: string;
  setLayout: (layout: string) => void;
  blockRemoteImages: boolean;
  imageWhitelist: {
      addresses: string[];
      domains: string[];
  };
  senderFaviconsLoaded: boolean;
  senderFavicons: boolean;
  senderFaviconsSaving: boolean;
  senderFaviconsEpoch: number;
  setSenderFavicons: (enabled: boolean) => Promise<void>;
  setBlockRemoteImages: (val: boolean) => void;
  setImageWhitelist: (whitelist: { addresses: string[]; domains: string[] }) => void;
  addToImageWhitelist: ({ type, value }: {
      type: string;
      value: string;
  }) => void;
  shortcuts: Record<string, string | null | undefined>;
  setShortcuts: (overrides: Record<string, string | null | undefined>) => void;
  aiActions: Array<{ id: string; label: string; prompt?: string; [key: string]: unknown }> | null;
  setAiActions: (actions: Array<{ id: string; label: string; prompt?: string; [key: string]: unknown }>) => void;
  hiddenFolders: string[];
  setHiddenFolders: (hf: string[]) => void;
  folderOrder: Record<string, string[]>;
  setFolderOrder: (accountId: string, paths: string[]) => void;
  expandedAccounts: Record<string, boolean>;
  setExpandedAccounts: (updater: (prev: Record<string, boolean>) => Record<string, boolean>) => void;
  collapsedFolders: string[];
  toggleCollapsedFolder: (accountId: string, path: string) => void;
  favoriteFolders: FavoriteFolderRow[];
  addFavoriteFolder: ({ accountId, path, name }: { accountId: string; path: string; name?: string }) => void;
  removeFavoriteFolder: ({ accountId, path }: {
      accountId: string;
      path: string;
  }) => void;
  renameFavoriteFolder: ({ accountId, path, label }: {
      accountId: string;
      path: string;
      label: string;
  }) => void;
  reorderFavoriteFolders: (next: FavoriteFolderRow[]) => void;
  recentFolders: FavoriteFolderRow[];
  recordRecentFolder: ({ accountId, path }: {
      accountId: string;
      path: string;
  }) => void;
  loadPreferences: () => Promise<void>;
}

export interface StoreMessageRow {
  id: string;
  account_id: string;
  has_contact_photo?: boolean | null;
  account_name?: string;
  account_color?: string;
  folder?: string;
  is_read?: boolean;
  is_starred?: boolean;
  message_id?: string | null;
  thread_id?: string;
  thread_key?: string;
  uid?: number;
  message_count?: number | string | null;
  unread_count?: number | string | null;
  date?: string | number | Date | null;
  subject?: string | null;
  snippet?: string | null;
  from_name?: string | null;
  from_email?: string | null;
  to_addresses?: string | null;
  cc_addresses?: string | null;
  reply_to?: string | null;
  delivery_addresses?: string | Array<{ email?: string | null; address?: string | null } | string> | null;
  category?: string | null;
  [key: string]: unknown;
}

/** The store fields its own set()/get() callbacks read. */
/**
 * The state fields the store's own set()/setState() callbacks read. Derived from StoreState so
 * the two can never disagree about a field's type.
 */
type StoreStateRead = Pick<StoreState,
  | '_winSeq'
  | 'accounts'
  | 'backfillProgress'
  | 'calendarWorkHoursEnd'
  | 'calendarWorkHoursPersisted'
  | 'calendarWorkHoursStart'
  | 'categoryCounts'
  | 'enabledPlugins'
  | 'folders'
  | 'gtdCollapsedSections'
  | 'gtdSections'
  | 'messageWindows'
  | 'messages'
  | 'messagesRefreshToken'
  | 'notifications'
  | 'rightSidebarHidden'
  | 'searchAllFolders'
  | 'searchQuery'
  | 'searchResults'
  | 'selectedAccountId'
  | 'selectedFolder'
  | 'selectedMessageId'
  | 'senderFaviconsEpoch'
  | 'showCalendar'
  | 'showContacts'
  | 'sidebarCollapsed'
  | 'swipeActions'
  | 'threadMessages'

  | 'threadedView'
  | 'unreadCounts'
  | 'user'
>;

// Accumulate rapid preference changes and flush at most once per second.
let _prefFlushTimer: ReturnType<typeof setTimeout> | null = null;
let _pendingPrefs: Record<string, unknown> = {};
let _calendarWorkHoursFlushTimer: ReturnType<typeof setTimeout> | null = null;
let _calendarWorkHoursSaveChain: Promise<unknown> = Promise.resolve();
function schedulePrefSave(prefs: Record<string, unknown>): void {
  Object.assign(_pendingPrefs, prefs);
  if (_prefFlushTimer) clearTimeout(_prefFlushTimer);
  _prefFlushTimer = setTimeout(() => {
    const toSave = _pendingPrefs;
    _pendingPrefs = {};
    api.savePreferences(toSave).catch(() => {});
  }, 1000);
}
function calendarWorkTimeMinutes(value: string): number {
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}
function isValidCalendarWorkRange(start: string, end: string): boolean {
  return calendarWorkTimeMinutes(start) < calendarWorkTimeMinutes(end);
}
function scheduleCalendarWorkHoursSave(prefs: Record<string, unknown>, next: { start: string; end: string }): void {
  if (_calendarWorkHoursFlushTimer) clearTimeout(_calendarWorkHoursFlushTimer);
  _calendarWorkHoursFlushTimer = setTimeout(() => {
    const userId = useStore.getState().user?.id;
    const save = _calendarWorkHoursSaveChain.then(() => api.savePreferences(prefs));
    _calendarWorkHoursSaveChain = save.catch(() => {});
    save
      .then(() => useStore.setState((state: StoreStateRead) => state.user?.id === userId ? { calendarWorkHoursPersisted: next } : {}))
      .catch(() => useStore.setState((state: StoreStateRead) => {
        if (state.user?.id !== userId) return {};
        if (state.calendarWorkHoursStart !== next.start || state.calendarWorkHoursEnd !== next.end) return {};
        return {
          calendarWorkHoursStart: state.calendarWorkHoursPersisted.start,
          calendarWorkHoursEnd: state.calendarWorkHoursPersisted.end,
          calendarWorkHoursError: 'Working hours could not be saved. The previous range was restored.',
        };
      }));
  }, 1000);
}
// Drop any queued preference flush. Called on logout / account switch: a pending debounce
// belongs to the previous user's session, so letting it fire would either save into the new
// user's account or hit a dead session (401). The prefs are already applied locally; only the
// deferred network write is discarded.
function cancelPendingPrefSave() {
  if (_prefFlushTimer) clearTimeout(_prefFlushTimer);
  _prefFlushTimer = null;
  _pendingPrefs = {};
  if (_calendarWorkHoursFlushTimer) clearTimeout(_calendarWorkHoursFlushTimer);
  _calendarWorkHoursFlushTimer = null;
}

// GTD sections fetch coordination. A monotonic seq guards against stale
// responses landing after a newer context switch; the timer debounces the
// WS-driven refetch (gtd_sections_updated can fire several times per tick).
let _gtdSectionsSeq = 0;
let _gtdFetchTimer: ReturnType<typeof setTimeout> | null = null;

function readGtdCollapsedSections() {
  try {
    const raw = JSON.parse(localStorage.getItem('mailflow_gtd_collapsed_sections') || 'null');
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  } catch { /* fall through to default */ }
  // Someday is collapsed by default — lowest-priority section, out of the way
  // until the user wants it.
  return { someday: true };
}

// The stored light/dark theme defaults are read once at startup; the active theme
// is derived from them plus the OS colour scheme (mode 'system').
const _initialThemePrefs = readThemePrefs();

// The store shape is intentionally typed as `any` for now: it is a large,
// dynamically-composed slice object, and typing it in full is tracked as part of
export const useStore = create<StoreState>()((set, get) => ({
  // Auth
  user: null,
  setUser: (user: StoreUserRow | null) =>{
    // On a real identity change (login, logout, account switch) drop any queued preference
    // flush so the previous user's debounce can't save into the new/absent session.
    if (get().user?.id !== user?.id) cancelPendingPrefSave();
    set((state: StoreStateRead) => ({
      user,
      ...(state.user?.id !== user?.id ? {
        senderFaviconsLoaded: false,
        senderFavicons: false,
        senderFaviconsSaving: false,
      } : {}),
    }));
  },
  updateUser: (updates: Record<string, unknown>) =>set((state: StoreStateRead) => ({ user: state.user ? { ...state.user, ...updates } : state.user })),

  // Plugin activation — the per-user set of activated plugin ids (users.preferences.enabledPlugins).
  // Hydrated in loadPreferences and mutated only via setPluginActivated (the Plugins settings
  // section). Independent of a plugin's own per-account config; a plugin's UI gates on membership
  // here (e.g. GTD's gtdActiveForContext requires 'gtd' to be present).
  enabledPlugins: [],
  setPluginActivated: async (id: string, activated: boolean) =>{
    await api.plugins.setActivated(id, activated);
    set((state: StoreStateRead) => {
      const next = new Set(state.enabledPlugins);
      if (activated) next.add(id); else next.delete(id);
      return { enabledPlugins: [...next] };
    });
  },

  // Todoist integration status (persisted across page loads via localStorage)
  todoistConnected: localStorage.getItem('mailflow_todoist_connected') === '1',
  setTodoistConnected: (connected: boolean) =>{
    if (connected) localStorage.setItem('mailflow_todoist_connected', '1');
    else localStorage.removeItem('mailflow_todoist_connected');
    set({ todoistConnected: connected });
  },

  // Lock screen
  isLocked: localStorage.getItem('mailflow_locked') === '1',
  setLocked: (locked: boolean) =>{
    if (locked) {
      const { selectedMessageId } = get();
      if (selectedMessageId) localStorage.setItem('mailflow_locked_message', selectedMessageId);
      localStorage.setItem('mailflow_locked', '1');
      set({
        isLocked: true,
        messages: [], searchResults: [], searchQuery: '',
        accounts: [], accountsReady: false,
        folders: {}, selectedMessageId: null,
        unreadCounts: { total: 0, byAccount: {} },
        notifications: [], threadMessages: {}, expandedThreadId: null,
        backfillProgress: {},
        gtdSections: null, categoryCounts: {}, activeGtdTab: null,
      });
    } else {
      const restoredMessageId = localStorage.getItem('mailflow_locked_message') || null;
      localStorage.removeItem('mailflow_locked_message');
      localStorage.removeItem('mailflow_locked');
      set({ isLocked: false, selectedMessageId: restoredMessageId });
    }
  },
  // Lock now: tell the server (it then 423s the API until unlocked), then drop into
  // the lock overlay locally. Lock the UI even if the server call fails (#235).
  lockScreen: () => {
    // Lock the UI immediately (never block on the network), then enforce server-side.
    get().setLocked(true);
    api.lock().catch(() => {});
  },
  autoLockMinutes: 0,
  setAutoLockMinutes: (m: number) =>{
    const v = [0, 1, 5, 15, 30].includes(Number(m)) ? Number(m) : 0;
    set({ autoLockMinutes: v });
    schedulePrefSave({ autoLockMinutes: String(v) });
  },

  // Accounts
  accounts: [],
  accountsReady: false, // true once the initial getAccounts() call has resolved
  setAccounts: (accounts: Array<{ id: string; enabled?: boolean; include_in_unified_inbox?: boolean; [key: string]: unknown }>) =>{
    if (!Array.isArray(accounts)) return;
    const previous = get().selectedAccountId;
    const selected = resolveSelectedAccount(accounts, previous);
    set((state: StoreStateRead) => ({ accounts, accountsReady: true, folders: pruneFolders(state.folders, accounts) }));
    if (selected !== previous) get().setSelectedAccount(selected);
  },
  updateAccount: (id: string, updates: Record<string, unknown>) =>set((state: StoreStateRead) => ({
    accounts: state.accounts.map(a => a.id === id ? { ...a, ...updates } : a)
  })),

  // Navigation
  selectedAccountId: localStorage.getItem('mailflow_selected_account') || null, // '' stored as null
  selectedFolder: localStorage.getItem('mailflow_selected_folder') || 'INBOX',
  messagesRefreshToken: 0, // incremented on every nav click so the effect always re-fires
  setSelectedAccount: (accountId: string | null, folder = 'INBOX') =>{
    localStorage.setItem('mailflow_selected_account', accountId ?? '');
    localStorage.setItem('mailflow_selected_folder', folder);
    return set((state: StoreStateRead) => {
      // #221: auto-close a folder-scoped search when navigating to a different
      // folder/account. A scoped search (a specific account with "Search all folders"
      // off) targets the current folder, so its results are stale once you leave it;
      // an all-folders search spans everything and is left intact. Clearing only
      // searchQuery lets the search effect tear down the rest of the search state,
      // exactly like the in-box clear (X) button does.
      const navChanged = state.selectedAccountId !== accountId || state.selectedFolder !== folder;
      const wasScopedSearch = !!state.selectedAccountId && !state.searchAllFolders && !!state.searchQuery.trim();
      // Returning from Calendar/Contacts is a presentation change, not a reload.
      // The mounted mail list still receives background updates. Preserve its
      // loaded pages, scroll position and native thread membership immediately.
      if (!navChanged && (state.showCalendar || state.showContacts)) {
        return { showContacts: false, showCalendar: false, selectedMessageId: null, mobileSidebarOpen: false };
      }
      return {
        selectedAccountId: accountId,
        mobileSidebarOpen: false,
        selectedFolder: folder,
        selectedMessageId: null,
        messages: [],
        messagesOffset: 0,
        hasMoreMessages: true,
        messagesRefreshToken: state.messagesRefreshToken + 1,
        expandedThreadId: null,
        threadMessages: {},
        showContacts: false, showCalendar: false,
        ...(navChanged && wasScopedSearch ? { searchQuery: '' } : {}),
      };
    });
  },


  // Messages
  messages: [],
  // Dedupe by stable identity on every raw list load: the same email can arrive as two rows
  // (same message delivered to two unified accounts, or a received copy + its Sent twin) and
  // must render once, matching isSelectedRow's identity model (#378). appendMessages/restore
  // dedupe on their own paths; this covers the initial/refresh/page loads that replace wholesale.
  setMessages: (messages: StoreMessageRow[]) =>set({ messages: dedupeByIdentity(messages) }),
  appendMessages: (newMessages: StoreMessageRow[]) =>set((state: StoreStateRead) => {
    // Merge by stable identity (Message-ID when present, else id): a same-id row is dropped so the
    // existing copy keeps any optimistic local-only fields a refresh lost (unread_count, etc.),
    // while a reindexed message (same Message-ID, new id after a purge+reinsert) replaces its stale
    // row in place instead of appearing as a duplicate. See appendMessagesByIdentity.
    const messages = appendMessagesByIdentity(state.messages, newMessages);
    return messages === state.messages ? {} : { messages };
  }),
  updateMessage: (id: string, updates: Record<string, unknown>) =>set((state: StoreStateRead) => {
    const apply = (m: StoreMessageRow) => m.id === id ? { ...m, ...updates } : m;
    const threadMessages = Object.fromEntries(
      Object.entries(state.threadMessages).map(([tid, msgs]) => [tid, msgs.map(apply)])
    );
    // An explicit unread_count is a whole-thread action. Otherwise a physical
    // copy (including the representative row itself) changes only its own state.
    const aggregateUpdate = Object.hasOwn(updates, 'unread_count');
    const messages = state.messages.map(m => {
      const updated = apply(m);
      if (!state.threadedView || !m.thread_id || aggregateUpdate || typeof updates.is_read !== 'boolean') return updated;
      const subs = threadMessages[m.thread_id || m.id];
      if (!subs?.some(copy => copy.id === id)) return updated;
      const unread_count = subs.filter(copy => !copy.is_read).length;
      return { ...updated, unread_count, is_read: unread_count === 0 };
    });
    return { messages, searchResults: state.searchResults.map(apply), threadMessages };
  }),
  removeMessage: (id: string) =>set((state: StoreStateRead) => ({
    messages: state.messages.filter(m => m.id !== id),
    searchResults: state.searchResults.filter(m => m.id !== id),
    selectedMessageId: state.selectedMessageId === id ? null : state.selectedMessageId,
  })),
  // Remove many messages in a single state update. Bulk triage (e.g. archiving ~40 rows)
  // otherwise calls removeMessage once per id, firing one store update — and, in a
  // non-virtualized list, one re-render — each, which stalls the UI. This collapses them
  // into one filter pass and one update.
  removeMessages: (ids: string[]) =>set((state: StoreStateRead) => {
    const idSet = ids instanceof Set ? ids : new Set(ids);
    if (idSet.size === 0) return {};
    return {
      messages: state.messages.filter(m => !idSet.has(m.id)),
      searchResults: state.searchResults.filter(m => !idSet.has(m.id)),
      selectedMessageId: state.selectedMessageId !== null && idSet.has(state.selectedMessageId) ? null : state.selectedMessageId,
    };
  }),
  restoreMessages: (msgs: StoreMessageRow[]) =>set((state: StoreStateRead) => {
    const list = Array.isArray(msgs) ? msgs : [msgs];
    const sort = (arr: StoreMessageRow[]) => [...arr].sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime());
    // Deduplicate against both the main list and searchResults by stable identity (Message-ID when
    // present, else id): if the message is already present — including re-added by a network
    // refresh under a regenerated id (matched via Message-ID) — skip it. The local copy carries the
    // freshest optimistic state, so we prefer it over the server view. See missingByIdentity.
    const missing = missingByIdentity(state.messages, list);
    if (missing.length === 0 && !state.searchQuery.trim()) return {};
    const missingFromSearch = missingByIdentity(state.searchResults, list);
    return {
      messages: missing.length ? sort([...state.messages, ...missing]) : state.messages,
      searchResults: state.searchQuery.trim() && missingFromSearch.length
        ? sort([...state.searchResults, ...missingFromSearch])
        : state.searchResults,
    };
  }),
  messagesOffset: 0,
  setMessagesOffset: (offset: number) =>set({ messagesOffset: offset }),
  messagesTotal: 0,
  setMessagesTotal: (total: number) =>set({ messagesTotal: total }),
  hasMoreMessages: true,
  setHasMoreMessages: (v: boolean) =>set({ hasMoreMessages: v }),

  // Selected message
  selectedMessageId: null,
  lastViewedMessageId: null,
  setSelectedMessage: (id: string) =>set(id ? { selectedMessageId: id, lastViewedMessageId: id } : { selectedMessageId: null }),

  // Unread counts
  unreadCounts: { total: 0, byAccount: {} },
  setUnreadCounts: (counts: { total: number; byAccount: Record<string, number> }) =>set({ unreadCounts: counts }),
  decrementUnread: (accountId: string, count = 1) =>set((state: StoreStateRead) => {
    const byAccount = { ...state.unreadCounts.byAccount };
    byAccount[accountId] = Math.max(0, (byAccount[accountId] || 0) - count);
    const total = accountAffectsUnifiedInbox(state.accounts, accountId)
      ? Math.max(0, state.unreadCounts.total - count)
      : state.unreadCounts.total;
    return { unreadCounts: { total, byAccount } };
  }),
  incrementUnread: (accountId: string, count = 1) =>set((state: StoreStateRead) => {
    const byAccount = { ...state.unreadCounts.byAccount };
    byAccount[accountId] = (byAccount[accountId] || 0) + count;
    const total = accountAffectsUnifiedInbox(state.accounts, accountId)
      ? state.unreadCounts.total + count
      : state.unreadCounts.total;
    return { unreadCounts: { total, byAccount } };
  }),

  // Folders
  folders: {}, // accountId -> folders[]
  setFolders: (accountId: string, folders: Array<{ path: string; unread_count?: number }>) =>set((state: StoreStateRead) => ({
    folders: { ...state.folders, [accountId]: folders }
  })),
  // Increment/decrement the unread_count of a single folder in one account's
  // list. Used for optimistic UI updates when marking messages as read/spam/ham
  // so the sidebar badge updates without waiting for a full folder sync.
  // We clamp at 0 to avoid negative counters when the optimistic guess was off.
  adjustFolderUnread: (accountId: string, folderPath: string | undefined, delta: number) =>set((state: StoreStateRead) => {
    const accountFolders = state.folders[accountId];
    if (!accountFolders) return {};
    let changed = false;
    const next = accountFolders.map(f => {
      if (f.path === folderPath && typeof f.unread_count === 'number' && Number.isFinite(f.unread_count)) {
        const updated = Math.max(0, f.unread_count + delta);
        if (updated !== f.unread_count) { changed = true; return { ...f, unread_count: updated }; }
      }
      return f;
    });
    if (!changed) return {};
    return { folders: { ...state.folders, [accountId]: next } };
  }),

  // UI state
  sidebarCollapsed: localStorage.getItem('mailflow_sidebar_collapsed') === 'true',
  toggleSidebar: () => set((state: StoreStateRead) => {
    const next = !state.sidebarCollapsed;
    localStorage.setItem('mailflow_sidebar_collapsed', String(next));
    return { sidebarCollapsed: next };
  }),
  sidebarWidth: (() => {
    const n = parseInt(localStorage.getItem('mailflow_sidebar_width') ?? '');
    return (n >= 160 && n <= 400) ? n : 250;
  })(),
  setSidebarWidth: (w: number) =>{
    localStorage.setItem('mailflow_sidebar_width', String(w));
    set({ sidebarWidth: w });
    schedulePrefSave({ sidebarWidth: String(w) });
  },
  isSidebarResizing: false,
  setIsSidebarResizing: (v: boolean) =>set({ isSidebarResizing: v }),
  pageSize: parseInt(localStorage.getItem('mailflow_page_size') ?? '') || 50,
  setPageSize: (size: number) =>{
    localStorage.setItem('mailflow_page_size', String(size));
    set({ pageSize: size });
    schedulePrefSave({ pageSize: String(size) });
  },
  scrollMode: localStorage.getItem('mailflow_scroll_mode') || 'infinite',
  setScrollMode: (mode: string) =>{
    localStorage.setItem('mailflow_scroll_mode', mode);
    set({ scrollMode: mode });
    schedulePrefSave({ scrollMode: mode });
  },
  // When true, search spans all folders instead of the current one (per device).
  searchAllFolders: localStorage.getItem('mailflow_search_all_folders') === '1',
  setSearchAllFolders: (v: boolean) =>{
    if (v) localStorage.setItem('mailflow_search_all_folders', '1');
    else localStorage.removeItem('mailflow_search_all_folders');
    set({ searchAllFolders: v });
  },
  swipeActions: (() => {
    try {
      return JSON.parse(localStorage.getItem('mailflow_swipe_actions') || 'null') || { left: 'archive', right: 'markRead' };
    } catch {
      return { left: 'archive', right: 'markRead' };
    }
  })(),
  setSwipeAction: (direction: string, action: string) =>set((state: StoreStateRead) => {
    const next = { ...state.swipeActions, [direction]: action };
    localStorage.setItem('mailflow_swipe_actions', JSON.stringify(next));
    schedulePrefSave({ swipeActions: next });
    return { swipeActions: next };
  }),
  syncInterval: parseInt(localStorage.getItem('mailflow_sync_interval') ?? '') || 60,
  setSyncInterval: (seconds: number) =>{
    localStorage.setItem('mailflow_sync_interval', String(seconds));
    set({ syncInterval: seconds });
    schedulePrefSave({ syncInterval: String(seconds) });
  },
  // Folder-structure sync cadence in seconds; 0 = never. Explicit Number.isFinite
  // check because 0 is a valid stored value that `|| default` would clobber.
  folderSyncInterval: (() => {
    const v = parseInt(localStorage.getItem('mailflow_folder_sync_interval') ?? '');
    return Number.isFinite(v) ? v : 1800;
  })(),
  setFolderSyncInterval: (seconds: number) =>{
    localStorage.setItem('mailflow_folder_sync_interval', String(seconds));
    set({ folderSyncInterval: seconds });
    schedulePrefSave({ folderSyncInterval: String(seconds) });
  },
  notificationSound: localStorage.getItem('mailflow_notification_sound') || 'tritone',
  setNotificationSound: (sound: string) =>{
    localStorage.setItem('mailflow_notification_sound', sound);
    set({ notificationSound: sound });
    schedulePrefSave({ notificationSound: sound });
  },
  customSoundDataUrl: localStorage.getItem('mailflow_custom_sound') || null,
  setCustomSoundDataUrl: (dataUrl: string) =>{
    if (dataUrl) {
      localStorage.setItem('mailflow_custom_sound', dataUrl);
    } else {
      localStorage.removeItem('mailflow_custom_sound');
    }
    set({ customSoundDataUrl: dataUrl });
  },
  composing: false,
  composeData: null,
  openCompose: (data = null) => set({ composing: true, composeData: data }),
  closeCompose: () => set({ composing: false, composeData: null }),

  // Detached message windows (#219): floating, draggable/resizable in-app windows
  // that each show one message via a MessagePane instance. Desktop-only; mounted by
  // WindowLayer. `_winSeq` is a monotonic counter serving as both a unique id source
  // and the z-order stamp (higher = on top / more recently focused).
  messageWindows: [],
  _winSeq: 0,
  openMessageWindow: (messageId: string) =>set((state: StoreStateRead) => {
    const seq = state._winSeq + 1;
    // Re-opening a message that already has a window focuses + un-minimizes it
    // rather than spawning a duplicate.
    if (state.messageWindows.some(w => w.messageId === messageId)) {
      return {
        _winSeq: seq,
        messageWindows: state.messageWindows.map(w =>
          w.messageId === messageId ? { ...w, minimized: false, z: seq } : w),
      };
    }
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
    const w = Math.min(660, Math.max(360, vw - 80));
    const h = Math.min(740, Math.max(280, vh - 80));
    // Cascade each new window down-right so they don't stack exactly on top.
    const cascade = (state.messageWindows.length % 6) * 28;
    const x = Math.max(12, Math.min(vw - w - 12, Math.round((vw - w) / 2) - 80 + cascade));
    const y = Math.max(12, Math.min(vh - h - 12, 72 + cascade));
    return {
      _winSeq: seq,
      messageWindows: [...state.messageWindows, { winId: `mw-${seq}`, messageId, x, y, w, h, z: seq, minimized: false }],
    };
  }),
  closeMessageWindow: (winId: string) =>set((state: StoreStateRead) => ({
    messageWindows: state.messageWindows.filter(w => w.winId !== winId),
  })),
  focusMessageWindow: (winId: string) =>set((state: StoreStateRead) => {
    const seq = state._winSeq + 1;
    return {
      _winSeq: seq,
      messageWindows: state.messageWindows.map(w => w.winId === winId ? { ...w, z: seq } : w),
    };
  }),
  setMessageWindowMinimized: (winId: string, minimized: boolean) =>set((state: StoreStateRead) => {
    const seq = state._winSeq + 1;
    return {
      _winSeq: seq,
      // Restoring (minimized=false) also brings the window to the front.
      messageWindows: state.messageWindows.map(w =>
        w.winId === winId ? { ...w, minimized, z: minimized ? w.z : seq } : w),
    };
  }),
  updateMessageWindowRect: (winId: string, rect: { x?: number; y?: number; width?: number; height?: number }) =>set((state: StoreStateRead) => ({
    messageWindows: state.messageWindows.map(w => w.winId === winId ? { ...w, ...rect } : w),
  })),
  closeAllMessageWindows: () => set({ messageWindows: [] }),
  searchQuery: '',
  setSearchQuery: (q: string) =>set({ searchQuery: q }),
  isSearching: false,
  setIsSearching: (v: boolean) =>set({ isSearching: v }),
  searchResults: [],
  setSearchResults: (r: StoreMessageRow[]) =>set({ searchResults: r }),

  // Loading
  loadingMessages: false,
  setLoadingMessages: (v: boolean) =>set({ loadingMessages: v }),

  // Notifications
  notifications: [],
  addNotification: (n: { id?: string; [key: string]: unknown }) =>set((state: StoreStateRead) => ({
    notifications: [{ ...n, id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}` }, ...state.notifications].slice(0, 5)
  })),
  removeNotification: (id: string) =>set((state: StoreStateRead) => ({
    notifications: state.notifications.filter(n => n.id !== id)
  })),

  // Admin panel
  showAdmin: false,
  adminTab: 'accounts', // 'accounts' | 'appearance' | 'integrations' | 'users'
  setShowAdmin: (v: boolean) =>set({ showAdmin: v }),
  setAdminTab: (t: string) =>set({ adminTab: t }),

  // Contacts view
  showContacts: false,
  setShowContacts: (showContacts: boolean) =>set({ showContacts, ...(showContacts ? { showCalendar: false } : {}) }),
  showCalendar: false,
  setShowCalendar: (showCalendar: boolean) =>set({ showCalendar, ...(showCalendar ? { showContacts: false } : {}) }),
  // Calendar presentation preferences are persisted per user. A missing visibility list means
  // all known calendars are visible, so upgrades never hide an existing source unexpectedly.
  calendarWeekStartsOn: 1,
  setCalendarWeekStartsOn: (calendarWeekStartsOn: number) =>{
    const value = calendarWeekStartsOn === 0 ? 0 : 1;
    set({ calendarWeekStartsOn: value });
    schedulePrefSave({ calendarWeekStartsOn: value });
  },
  visibleCalendarIds: null,
  setVisibleCalendarIds: (visibleCalendarIds: string[]) =>{
    const value = Array.isArray(visibleCalendarIds) ? [...new Set(visibleCalendarIds.filter(id => typeof id === 'string'))] : null;
    set({ visibleCalendarIds: value });
    schedulePrefSave({ visibleCalendarIds: value || [] });
  },
  mobileNavigationPosition: 'top',
  setMobileNavigationPosition: (mobileNavigationPosition: string) =>{
    const value = mobileNavigationPosition === 'bottom' ? 'bottom' : 'top';
    set({ mobileNavigationPosition: value });
    schedulePrefSave({ mobileNavigationPosition: value });
  },
  // The SMTP account the new-event dialog preselects for calendar invitations.
  // Empty means "no default": the dialog leaves the sender picker unselected.
  calendarInviteAccountId: '',
  setCalendarInviteAccountId: (calendarInviteAccountId: string | null) =>{
    const value = typeof calendarInviteAccountId === 'string' ? calendarInviteAccountId : '';
    set({ calendarInviteAccountId: value });
    schedulePrefSave({ calendarInviteAccountId: value });
  },
  calendarWorkDays: [...DEFAULT_CALENDAR_PREFERENCES.calendarWorkDays],
  setCalendarWorkDays: (calendarWorkDays: number[]) =>{
    const value = normalizeCalendarWorkDays(calendarWorkDays);
    set({ calendarWorkDays: value });
    schedulePrefSave({ calendarWorkDays: value });
  },
  calendarWorkHoursStart: DEFAULT_CALENDAR_PREFERENCES.calendarWorkHoursStart,
  calendarWorkHoursPersisted: {
    start: DEFAULT_CALENDAR_PREFERENCES.calendarWorkHoursStart,
    end: DEFAULT_CALENDAR_PREFERENCES.calendarWorkHoursEnd,
  },
  calendarWorkHoursError: '',
  setCalendarWorkHoursStart: (value: string) =>{
    const start = normalizeCalendarWorkTime(value, DEFAULT_CALENDAR_PREFERENCES.calendarWorkHoursStart);
    const current = get();
    const legacyRange = !isValidCalendarWorkRange(current.calendarWorkHoursStart, current.calendarWorkHoursEnd);
    const next = { start, end: legacyRange ? DEFAULT_CALENDAR_PREFERENCES.calendarWorkHoursEnd : current.calendarWorkHoursEnd };
    if (!isValidCalendarWorkRange(next.start, next.end)) {
      set({ calendarWorkHoursError: 'Working hours must end after they start.' });
      return;
    }
    set({ calendarWorkHoursStart: next.start, calendarWorkHoursEnd: next.end, calendarWorkHoursError: '' });
    scheduleCalendarWorkHoursSave(legacyRange ? { calendarWorkHoursStart: next.start } : { calendarWorkHoursStart: next.start, calendarWorkHoursEnd: next.end }, next);
  },
  calendarWorkHoursEnd: DEFAULT_CALENDAR_PREFERENCES.calendarWorkHoursEnd,
  setCalendarWorkHoursEnd: (value: string) =>{
    const end = normalizeCalendarWorkTime(value, DEFAULT_CALENDAR_PREFERENCES.calendarWorkHoursEnd);
    const current = get();
    const legacyRange = !isValidCalendarWorkRange(current.calendarWorkHoursStart, current.calendarWorkHoursEnd);
    const next = { start: legacyRange ? DEFAULT_CALENDAR_PREFERENCES.calendarWorkHoursStart : current.calendarWorkHoursStart, end };
    if (!isValidCalendarWorkRange(next.start, next.end)) {
      set({ calendarWorkHoursError: 'Working hours must end after they start.' });
      return;
    }
    set({ calendarWorkHoursStart: next.start, calendarWorkHoursEnd: next.end, calendarWorkHoursError: '' });
    scheduleCalendarWorkHoursSave(legacyRange ? { calendarWorkHoursEnd: next.end } : { calendarWorkHoursStart: next.start, calendarWorkHoursEnd: next.end }, next);
  },
  rulesPreFill: null, // { fromEmail, fromName, subject } — transient, set by context menu
  setRulesPreFill: (v: { fromEmail?: string | null; fromName?: string | null; subject?: string | null; [key: string]: unknown } | null) =>set({ rulesPreFill: v }),

  backfillProgress: {}, // { [accountId]: { synced: N, total: N } | null } — transient
  setBackfillProgress: (accountId: string, progress: Record<string, unknown>) =>set((state: StoreStateRead) => ({
    backfillProgress: { ...state.backfillProgress, [accountId]: progress },
  })),

  // Mobile navigation
  mobileSidebarOpen: false,
  setMobileSidebarOpen: (v: boolean) =>set({ mobileSidebarOpen: v }),

  // Language
  language: localStorage.getItem('mailflow_language') || 'en',
  setLanguage: (lng: string) =>{
    localStorage.setItem('mailflow_language', lng);
    set({ language: lng });
    i18n.changeLanguage(lng);
    schedulePrefSave({ language: lng });
  },

  // Conversation Engine v2: list grouping is controlled exclusively by the native
  // threadedView preference. The old CE-specific list flag is read only as a
  // compatibility fallback for users who saved it before the canonical mapping.
  conversationReaderViewEnabled: false,
  setConversationReaderViewEnabled: (val: boolean) =>{
    set({ conversationReaderViewEnabled: val });
    schedulePrefSave({ conversation_reader_view_enabled: val });
  },

  // Threaded view
  threadedView: localStorage.getItem('mailflow_threaded_view') === 'true',
  setThreadedView: (val: boolean) =>{
    localStorage.setItem('mailflow_threaded_view', String(val));
    set({ threadedView: val, expandedThreadId: null, threadMessages: {} });
    schedulePrefSave({ threadedView: val });
  },

  // Compose format
  plaintextEmail: localStorage.getItem('mailflow_plaintext_email') === 'true',
  setPlaintextEmail: (val: boolean) =>{
    localStorage.setItem('mailflow_plaintext_email', String(val));
    set({ plaintextEmail: val });
    schedulePrefSave({ plaintextEmail: val });
  },

  // Message list quick actions
  hoverQuickActions: localStorage.getItem('mailflow_hover_quick_actions') !== 'false',
  setHoverQuickActions: (val: boolean) =>{
    localStorage.setItem('mailflow_hover_quick_actions', String(val));
    set({ hoverQuickActions: val });
    schedulePrefSave({ hoverQuickActions: val });
  },

  // Show sender avatars in the mobile message list (off by default — they cost row width
  // on a narrow screen; opt-in for users who prefer the scannability). Desktop always shows them.
  showMobileAvatars: localStorage.getItem('mailflow_show_mobile_avatars') === 'true',
  setShowMobileAvatars: (val: boolean) =>{
    localStorage.setItem('mailflow_show_mobile_avatars', String(val));
    set({ showMobileAvatars: val });
    schedulePrefSave({ showMobileAvatars: val });
  },

  // Fetch sender avatars from Gravatar (off by default — opt-in third-party lookup, proxied
  // through the backend so the user's IP is never exposed). Falls back to initials on a miss.
  gravatarAvatars: localStorage.getItem('mailflow_gravatar_avatars') === 'true',
  setGravatarAvatars: (val: boolean) =>{
    localStorage.setItem('mailflow_gravatar_avatars', String(val));
    set({ gravatarAvatars: val });
    schedulePrefSave({ gravatarAvatars: val });
  },

  // Show message preview snippets in the message list (on by default).
  showMessagePreviews: localStorage.getItem('mailflow_show_message_previews') !== 'false',
  setShowMessagePreviews: (val: boolean) =>{
    localStorage.setItem('mailflow_show_message_previews', String(val));
    set({ showMessagePreviews: val });
    schedulePrefSave({ showMessagePreviews: val });
  },

  replyDefault: localStorage.getItem('mailflow_reply_default') || 'reply',
  setReplyDefault: (val: string) =>{
    localStorage.setItem('mailflow_reply_default', val);
    set({ replyDefault: val });
    schedulePrefSave({ replyDefault: val });
  },

  markReadBehavior: localStorage.getItem('mailflow_mark_read_behavior') || 'immediate',
  setMarkReadBehavior: (val: string) =>{
    localStorage.setItem('mailflow_mark_read_behavior', val);
    set({ markReadBehavior: val });
    schedulePrefSave({ markReadBehavior: val });
  },
  markReadDelay: parseInt(localStorage.getItem('mailflow_mark_read_delay') || '1') || 1,
  setMarkReadDelay: (val: string | number) =>{
    const n = Math.max(1, Math.min(10, Number(val) || 1));
    localStorage.setItem('mailflow_mark_read_delay', String(n));
    set({ markReadDelay: n });
    schedulePrefSave({ markReadDelay: n });
  },

  // Thread expansion cache (not persisted — reset on navigation)
  expandedThreadId: null,
  setExpandedThreadId: (id: string | null) =>set({ expandedThreadId: id }),
  threadMessages: {},
  setThreadMessages: (threadId: string, msgs: StoreMessageRow[]) =>set((state: StoreStateRead) => ({
    threadMessages: { ...state.threadMessages, [threadId]: msgs },
  })),
  clearThreadMessages: (threadId: string) =>set((state: StoreStateRead) => ({
    threadMessages: removeThreadCacheEntry(state.threadMessages, threadId),
  })),
  loadingThread: null,
  setLoadingThread: (id: string | null) =>set({ loadingThread: id }),

  // Theme — a default for the light appearance and one for the dark appearance,
  // plus the mode that picks between them. `theme` stays the *effective* theme so
  // existing consumers (fonts, diagnostics, command palette) keep working.
  themeMode: _initialThemePrefs.mode,
  lightTheme: _initialThemePrefs.light,
  darkTheme: _initialThemePrefs.dark,
  theme: resolveTheme(_initialThemePrefs),

  // Shared by every theme action: store the three preferences, derive the active
  // theme and re-apply the CSS variables plus the theme-paired font.
  applyThemeSelection: (partial: { light?: string; dark?: string; [key: string]: unknown }) =>{
    const current = { mode: get().themeMode, light: get().lightTheme, dark: get().darkTheme };
    const next = {
      mode: partial.mode !== undefined ? normalizeThemeMode(partial.mode) : current.mode,
      light: isThemeName(partial.light) ? partial.light : current.light,
      dark: isThemeName(partial.dark) ? partial.dark : current.dark,
    };
    const theme = resolveTheme(next);
    localStorage.setItem('mailflow_theme_mode', next.mode);
    localStorage.setItem('mailflow_theme_light', next.light);
    localStorage.setItem('mailflow_theme_dark', next.dark);
    localStorage.setItem('mailflow_theme', theme); // legacy/effective mirror
    set({ themeMode: next.mode, lightTheme: next.light, darkTheme: next.dark, theme });
    applyTheme(theme); // keep CSS vars + favicon in sync
    // If a retro font was left as the saved choice, a non-retro theme must not keep it —
    // normalise the stored choice so it can't "stick" (and the font picker stays honest).
    if (!isThemeFont(theme) && isRetroFont(get().fontSet)) {
      localStorage.setItem('mailflow_font', 'default');
      set({ fontSet: 'default' });
      schedulePrefSave({ font: 'default' });
    }
    // Retro themes bring their own font; other themes fall back to the saved choice.
    applyFontSet(effectiveFontSet(theme, get().fontSet));
    schedulePrefSave({ themeMode: next.mode, themeLight: next.light, themeDark: next.dark, theme });
  },

  setThemeMode: (mode: string) =>get().applyThemeSelection({ mode }),
  setLightTheme: (theme: string) =>get().applyThemeSelection({ light: theme }),
  setDarkTheme: (theme: string) =>get().applyThemeSelection({ dark: theme }),

  // An explicit theme choice targets the slot for its own tone and forces that
  // appearance — the behaviour of the old single-theme picker and the command palette.
  setTheme: (theme: string) =>{
    if (!isThemeName(theme)) return;
    get().applyThemeSelection(themeTone(theme) === 'light'
      ? { mode: 'light', light: theme }
      : { mode: 'dark', dark: theme });
  },

  // Re-derive the active theme after the OS colour scheme changes. Only relevant
  // while following the system, and applied locally — the OS is not a preference,
  // so nothing is written back to the server.
  syncSystemTheme: () => {
    if (get().themeMode !== 'system') return;
    const theme = resolveTheme({ mode: 'system', light: get().lightTheme, dark: get().darkTheme });
    if (theme === get().theme) return;
    set({ theme });
    applyTheme(theme);
    applyFontSet(effectiveFontSet(theme, get().fontSet));
  },

  // Font
  fontSet: localStorage.getItem('mailflow_font') || 'default',
  setFontSet: (fontSet: string) =>{
    localStorage.setItem('mailflow_font', fontSet);
    set({ fontSet });
    // A retro theme's paired font still wins over an explicit pick while it's active.
    applyFontSet(effectiveFontSet(get().theme, fontSet));
    schedulePrefSave({ font: fontSet });
  },

  fontSize: parseInt(localStorage.getItem('mailflow_font_size') ?? '') || 100,
  setFontSize: (pct: number) =>{
    localStorage.setItem('mailflow_font_size', String(pct));
    set({ fontSize: pct });
    applyFontSize(pct);
    schedulePrefSave({ fontSize: String(pct) });
  },

  showAppBadge: localStorage.getItem('mailflow_app_badge') !== 'false',
  setShowAppBadge: (val: boolean) =>{
    localStorage.setItem('mailflow_app_badge', String(val));
    set({ showAppBadge: val });
    schedulePrefSave({ showAppBadge: val });
  },


  categorizationEnabled: false,
  setCategorizationEnabled: (val: boolean) =>{
    set({ categorizationEnabled: val });
    schedulePrefSave({ categorizationEnabled: val });
  },

  // Unread counts per category for the tab bar badges { primary: N, newsletter: N, ... }
  categoryCounts: {},
  setCategoryCounts: (counts: Record<string, number>) =>set({ categoryCounts: counts }),
  adjustCategoryCount: (category: string | null | undefined, delta: number) =>set((state: StoreStateRead) => {
    const key = category || 'primary';
    const current = state.categoryCounts[key] || 0;
    return { categoryCounts: { ...state.categoryCounts, [key]: Math.max(0, current + delta) } };
  }),

  // ── Right-sidebar layout ────────────────────────────────────────────────────
  // Independent column width (own var + handle, not --list-width).
  rightSidebarWidth: clampRightSidebarWidth(localStorage.getItem('mailflow_right_sidebar_width')),
  setRightSidebarWidth: (w: number) =>{
    const clamped = clampRightSidebarWidth(w);
    localStorage.setItem('mailflow_right_sidebar_width', String(clamped));
    set({ rightSidebarWidth: clamped });
    schedulePrefSave({ rightSidebarWidth: clamped });
  },
  isRightSidebarResizing: false,
  setIsRightSidebarResizing: (v: boolean) =>set({ isRightSidebarResizing: v }),

  rightSidebarHidden: localStorage.getItem('mailflow_right_sidebar_hidden') === 'true',
  toggleRightSidebarHidden: () => set((state: StoreStateRead) => {
    const next = !state.rightSidebarHidden;
    localStorage.setItem('mailflow_right_sidebar_hidden', String(next));
    schedulePrefSave({ rightSidebarHidden: next });
    return { rightSidebarHidden: next };
  }),

  // ── GTD content + tabs ──────────────────────────────────────────────────────
  // Per-section collapse state (section key -> bool). Someday collapsed by default.
  gtdCollapsedSections: readGtdCollapsedSections(),
  toggleGtdSection: (section: string) =>set((state: StoreStateRead) => {
    const next = { ...state.gtdCollapsedSections, [section]: !state.gtdCollapsedSections[section] };
    localStorage.setItem('mailflow_gtd_collapsed_sections', JSON.stringify(next));
    schedulePrefSave({ gtdCollapsedSections: next });
    return { gtdCollapsedSections: next };
  }),

  // Active GTD browse tab in the message-list pill strip (null = normal list).
  activeGtdTab: null,
  setActiveGtdTab: (tab: string | null) =>set({ activeGtdTab: tab }),

  // Sections data feeding both the rail and the tab list. null before first load.
  gtdSections: null,
  fetchGtdSections: async () => {
    const seq = ++_gtdSectionsSeq;
    const accountId = get().selectedAccountId || undefined;
    try {
      const data = await api.getGtdSections({ accountId, limit: 50 });
      if (seq !== _gtdSectionsSeq) return; // superseded by a newer fetch
      set({ gtdSections: applyGtdRemovalGuard(data.sections || {}) });
    } catch {
      // Best-effort; scheduleGtdSectionsFetch/the next context change will retry.
    }
  },
  // Debounced refetch — used by the WS gtd_sections_updated handler and after a
  // classify so the rail converges without waiting on (or racing) the socket.
  scheduleGtdSectionsFetch: () => {
    if (_gtdFetchTimer) clearTimeout(_gtdFetchTimer);
    _gtdFetchTimer = setTimeout(() => { get().fetchGtdSections(); }, 400);
  },
  // Optimistically drop a thread's head from the given GTD state sections after a
  // "done" action so the rail row disappears instantly; the gtd_sections_updated
  // refetch reconciles the authoritative counts. identity is message_id||id; states
  // are the backend section keys whose labels were removed (todo/watch/delegated/…).
  // Delegates to a pure helper (unit-tested in gtd.test.js) that also keeps the deduped
  // Waiting rollup in step so the Waiting badge is correct instantly.
  removeGtdThread: (identity: string, states: string[]) =>{
    let snapshot = null;
    set((state: StoreStateRead) => {
      snapshot = snapshotGtdThreadRemoval(state.gtdSections, identity, states);
      const next = removeGtdThreadFromSections(state.gtdSections, identity, states);
      return next === state.gtdSections ? {} : { gtdSections: next };
    });
    return snapshot;
  },
  restoreGtdThread: (snapshot: GtdRemovalSnapshot) =>set((state: StoreStateRead) => {
    const next = restoreGtdThreadRemoval(state.gtdSections, snapshot);
    return next === state.gtdSections ? {} : { gtdSections: next };
  }),
  // Optimistically flip a section thread's read flag so a rail row's bold/normal styling
  // updates instantly on a mark-read/unread from the rail; the WS/gtd refetch reconciles.
  // identity is message_id||id and matches across every state a thread is labelled with
  // (a merged Waiting row lives in both watch and delegated), keeping them in sync — and
  // the deduped Waiting rollup's unread with them (pure helper, unit-tested in gtd.test.js).
  markGtdThreadRead: (identity: string, isRead: boolean) =>set((state: StoreStateRead) => {
    const next = setGtdThreadReadInSections(state.gtdSections, identity, isRead);
    return next === state.gtdSections ? {} : { gtdSections: next };
  }),
  // Optimistically flip a section thread's star so a rail row's star fills/empties instantly
  // on a toggle; the WS/gtd refetch reconciles. identity is message_id||id and matches across
  // every state a thread is labelled with (a merged Waiting row lives in both watch and
  // delegated), keeping them in sync. Star does not affect the unread rollup.
  markGtdThreadStarred: (identity: string, isStarred: boolean) =>set((state: StoreStateRead) => {
    const cur = state.gtdSections;
    if (!cur || identity == null) return {};
    const next = { ...cur };
    let changed = false;
    for (const [key, sec] of Object.entries(cur)) {
      if (!sec || !Array.isArray(sec.threads)) continue;
      let touched = false;
      const threads = sec.threads.map(th => {
        if ((th.message_id || th.id) !== identity || !!th.is_starred === isStarred) return th;
        touched = true;
        return { ...th, is_starred: isStarred };
      });
      if (!touched) continue;
      changed = true;
      next[key] = { ...sec, threads };
    }
    return changed ? { gtdSections: next } : {};
  }),

  // Which cached imported pet renders at inbox-zero (null = the built-in SVG dog).
  // A flat user preference; the asset bytes live server-side, keyed by this slug.
  gtdPetSlug: null,
  setGtdPetSlug: (slug: string) =>{
    const value = slug || null;
    set({ gtdPetSlug: value });
    // '' is the explicit "clear" sentinel the prefs allow-list understands.
    api.savePreferences({ gtdPetSlug: value || '' }).catch(() => {});
  },

  // Layout
  layout: (() => {
    const raw = localStorage.getItem('mailflow_layout');
    const clean = normalizeLayout(raw);
    // Self-heal a stale/removed preset so it can never reach a consumer (#207).
    if (raw && raw !== clean) localStorage.setItem('mailflow_layout', clean);
    return clean;
  })(),
  setLayout: (layout: string) =>{
    const clean = normalizeLayout(layout);
    localStorage.setItem('mailflow_layout', clean);
    localStorage.removeItem(PANEL_WIDTH_STORAGE_KEY);
    set({ layout: clean });
    applyLayout(clean);
    schedulePrefSave({ layout: clean });
  },

  // Image privacy
  blockRemoteImages: true,
  imageWhitelist: { addresses: [], domains: [] },
  senderFaviconsLoaded: false,
  senderFavicons: false,
  senderFaviconsSaving: false,
  // Monotonic counter bumped on every toggle. loadPreferences captures it before
  // its GET so a stale hydration response can't clobber a toggle the user made
  // while the fetch was in flight. Never reset — the user-id guard covers account
  // switches, and monotonicity avoids ABA.
  senderFaviconsEpoch: 0,
  setSenderFavicons: async (enabled: boolean) =>{
    if (get().senderFaviconsSaving) return;
    const userId = get().user?.id;
    set((state: StoreStateRead) => ({ senderFaviconsSaving: true, senderFaviconsEpoch: state.senderFaviconsEpoch + 1 }));
    if (!enabled) {
      set({ senderFavicons: false });
      try { await api.savePreferences({ senderFavicons: false }); }
      finally {
        if (get().user?.id === userId) set({ senderFaviconsSaving: false });
      }
      return;
    }
    try {
      await api.savePreferences({ senderFavicons: true });
      if (get().user?.id === userId) {
        set({ senderFaviconsLoaded: true, senderFavicons: true });
      }
    } finally {
      if (get().user?.id === userId) set({ senderFaviconsSaving: false });
    }
  },
  setBlockRemoteImages: (val: boolean) =>{
    set({ blockRemoteImages: val });
    return api.savePreferences({ blockRemoteImages: val });
  },
  setImageWhitelist: (whitelist: { addresses: string[]; domains: string[] }) =>{
    const prev = get().imageWhitelist;
    set({ imageWhitelist: whitelist });
    return api.savePreferences({ imageWhitelist: whitelist }).catch(err => {
      set({ imageWhitelist: prev });
      throw err;
    });
  },
  addToImageWhitelist: ({ type, value }: { type: string; value: string }) => {
    const prev = get().imageWhitelist;
    const key = type === 'address' ? 'addresses' : 'domains';
    const normalized = value.toLowerCase();
    set({
      imageWhitelist: {
        ...prev,
        [key]: [...new Set([...(prev[key] || []), normalized])],
      },
    });
    return api.addToImageWhitelist({ type, value: normalized }).catch(err => {
      set({ imageWhitelist: prev });
      throw err;
    });
  },

  // Keyboard shortcuts — stores only user overrides (action → key).
  // Merged with defaults at use-time via getEffectiveShortcuts().
  shortcuts: {},
  setShortcuts: (overrides: Record<string, string | null | undefined>) =>{
    set({ shortcuts: overrides });
    return api.savePreferences({ shortcuts: overrides }).catch(() => {});
  },

  // User-defined AI actions (#202), synced across devices. Each: { id, label, prompt }.
  // null = not yet loaded; loadPreferences seeds defaults on first run.
  aiActions: null,
  setAiActions: (actions: Array<{ id: string; label: string; prompt?: string; [key: string]: unknown }>) =>{
    set({ aiActions: actions });
    return api.savePreferences({ aiActions: actions }).catch(() => {});
  },

  // Hidden folders — { [accountId]: [path, ...] }
  hiddenFolders: [],
  setHiddenFolders: (hf: string[]) =>{
    set({ hiddenFolders: hf });
    return api.savePreferences({ hiddenFolders: hf }).catch(() => {});
  },

  // Custom per-account folder display order — { [accountId]: [path, ...] }
  folderOrder: readFolderOrder(),
  setFolderOrder: (accountId: string, paths: string[]) =>{
    const next = mergeFolderOrder(get().folderOrder, accountId, paths);
    set({ folderOrder: next });
    schedulePrefSave({ folderOrder: next });
  },

  // Sidebar tree state — persisted so the tree looks the same after reload/re-login
  expandedAccounts: (() => {
    try { return JSON.parse(localStorage.getItem('mailflow_expanded_accounts') || '{}'); }
    catch { return {}; }
  })(),
  setExpandedAccounts: (updater: (prev: Record<string, boolean>) => Record<string, boolean>) => {
    const next = typeof updater === 'function' ? updater(get().expandedAccounts) : updater;
    localStorage.setItem('mailflow_expanded_accounts', JSON.stringify(next));
    set({ expandedAccounts: next });
    schedulePrefSave({ expandedAccounts: next });
  },

  // collapsedFolders stored as array of "accountId:path" keys (Set can't be JSON-serialised)
  collapsedFolders: (() => {
    try { return JSON.parse(localStorage.getItem('mailflow_collapsed_folders') || '[]'); }
    catch { return []; }
  })(),
  toggleCollapsedFolder: (accountId: string, path: string) =>{
    const key = `${accountId}:${path}`;
    const prev = get().collapsedFolders;
    const next = prev.includes(key) ? prev.filter((k: string) => k !== key) : [...prev, key];
    localStorage.setItem('mailflow_collapsed_folders', JSON.stringify(next));
    set({ collapsedFolders: next });
    schedulePrefSave({ collapsedFolders: next });
  },

  // Favorite folders — [{ accountId, path }, ...] ordered by insertion
  favoriteFolders: (() => {
    try { return JSON.parse(localStorage.getItem('mailflow_favorite_folders') || '[]'); }
    catch { return []; }
  })(),
  addFavoriteFolder: ({ accountId, path, name }: { accountId: string; path: string; name?: string }) => {
    const prev = get().favoriteFolders;
    if (prev.some((f: FavoriteFolderRow) => f.accountId === accountId && f.path === path)) return;
    // The caller passes a display name; the rest of the UI reads it as label (renameFavoriteFolder sets it).
    const next = [...prev, { accountId, path, ...(name ? { label: name } : {}) }];
    localStorage.setItem('mailflow_favorite_folders', JSON.stringify(next));
    set({ favoriteFolders: next });
    schedulePrefSave({ favoriteFolders: next });
  },
  removeFavoriteFolder: ({ accountId, path }: { accountId: string; path: string }) => {
    const next = get().favoriteFolders.filter((f: FavoriteFolderRow) => !(f.accountId === accountId && f.path === path));
    localStorage.setItem('mailflow_favorite_folders', JSON.stringify(next));
    set({ favoriteFolders: next });
    schedulePrefSave({ favoriteFolders: next });
  },
  renameFavoriteFolder: ({ accountId, path, label }: { accountId: string; path: string; label: string }) =>{
    const next = get().favoriteFolders.map((f: FavoriteFolderRow) => {
      if (f.accountId !== accountId || f.path !== path) return f;
       
      const { label: _old, ...base } = f;
      return label ? { ...base, label } : base;
    });
    localStorage.setItem('mailflow_favorite_folders', JSON.stringify(next));
    set({ favoriteFolders: next });
    schedulePrefSave({ favoriteFolders: next });
  },
  reorderFavoriteFolders: (next: FavoriteFolderRow[]) =>{
    localStorage.setItem('mailflow_favorite_folders', JSON.stringify(next));
    set({ favoriteFolders: next });
    schedulePrefSave({ favoriteFolders: next });
  },

  // Recent move-to folders — [{ accountId, path }, ...] most-recent first, capped at 5
  recentFolders: (() => {
    try { return JSON.parse(localStorage.getItem('mailflow_recent_folders') || '[]'); }
    catch { return []; }
  })(),
  recordRecentFolder: ({ accountId, path }: { accountId: string; path: string }) => {
    const prev = get().recentFolders;
    const deduped = prev.filter((f: FavoriteFolderRow) => !(f.accountId === accountId && f.path === path));
    const next = [{ accountId, path }, ...deduped].slice(0, 5);
    localStorage.setItem('mailflow_recent_folders', JSON.stringify(next));
    set({ recentFolders: next });
    schedulePrefSave({ recentFolders: next });
  },

  // Fetch server preferences and apply them — call after any successful login.
  // Sets localStorage so subsequent page loads apply the right values instantly.
  loadPreferences: async () => {
    const userId = get().user?.id;
    const faviconEpoch = get().senderFaviconsEpoch;
    try {
      const prefs = await api.getPreferences();
      if (get().user?.id !== userId) return;
      // Per-user plugin activation. Absent = nothing activated (new users start with GTD off);
      // existing GTD users were grandfathered into ['gtd'] by migration 0042.
      set({ enabledPlugins: Array.isArray(prefs.enabledPlugins) ? prefs.enabledPlugins : [] });
      // Theme: the server is authoritative. New-style preferences carry the separate
      // light/dark defaults plus the mode; a legacy single `theme` becomes an explicit
      // mode for its own tone, so an upgrade never silently changes someone's look.
      const hydrateTheme = (next: { mode: string; light: string; dark: string }) => {
        const theme = resolveTheme(next);
        localStorage.setItem('mailflow_theme_mode', next.mode);
        localStorage.setItem('mailflow_theme_light', next.light);
        localStorage.setItem('mailflow_theme_dark', next.dark);
        localStorage.setItem('mailflow_theme', theme); // legacy/effective mirror
        set({ themeMode: next.mode, lightTheme: next.light, darkTheme: next.dark, theme });
        applyTheme(theme);
      };
      const serverMode = THEME_MODES.includes(prefs.themeMode) ? prefs.themeMode : null;
      if (serverMode || prefs.themeLight || prefs.themeDark) {
        hydrateTheme({
          mode: serverMode || 'system',
          light: isThemeName(prefs.themeLight) ? prefs.themeLight : get().lightTheme,
          dark: isThemeName(prefs.themeDark) ? prefs.themeDark : get().darkTheme,
        });
      } else if (isThemeName(prefs.theme)) {
        hydrateTheme(themeTone(prefs.theme) === 'light'
          ? { mode: 'light', light: prefs.theme, dark: get().darkTheme }
          : { mode: 'dark', light: get().lightTheme, dark: prefs.theme });
      }
      if (prefs.font) {
        localStorage.setItem('mailflow_font', prefs.font);
        set({ fontSet: prefs.font });
      }
      // Apply the effective font once theme + font are both known, so a retro theme's
      // paired font overrides the saved font on load.
      applyFontSet(effectiveFontSet(get().theme, get().fontSet));
      if (prefs.fontSize) {
        const n = parseInt(prefs.fontSize) || 100;
        localStorage.setItem('mailflow_font_size', String(n));
        set({ fontSize: n });
        applyFontSize(n);
      }
      if (prefs.layout) {
        const clean = normalizeLayout(prefs.layout);
        const prevLayout = get().layout;
        localStorage.setItem('mailflow_layout', clean);
        set({ layout: clean });
        if (clean !== prevLayout) localStorage.removeItem(PANEL_WIDTH_STORAGE_KEY);
        const savedListWidth = clean !== prevLayout
          ? undefined
          : savedPanelWidth();
        applyLayout(clean, savedListWidth);
      }
      if (prefs.notificationSound) {
        localStorage.setItem('mailflow_notification_sound', prefs.notificationSound);
        set({ notificationSound: prefs.notificationSound });
      }
      if (prefs.pageSize) {
        const n = parseInt(prefs.pageSize) || 50;
        localStorage.setItem('mailflow_page_size', String(n));
        set({ pageSize: n });
      }
      if (prefs.scrollMode) {
        localStorage.setItem('mailflow_scroll_mode', prefs.scrollMode);
        set({ scrollMode: prefs.scrollMode });
      }
      if (prefs.swipeActions) {
        const swipeActions = {
          left: prefs.swipeActions.left || 'archive',
          right: prefs.swipeActions.right || 'markRead',
        };
        localStorage.setItem('mailflow_swipe_actions', JSON.stringify(swipeActions));
        set({ swipeActions });
      }
      if (prefs.syncInterval) {
        const n = parseInt(prefs.syncInterval) || 60;
        localStorage.setItem('mailflow_sync_interval', String(n));
        set({ syncInterval: n });
      }
      if (prefs.folderSyncInterval != null) {
        const n = parseInt(prefs.folderSyncInterval);
        if ([0, 900, 1800, 3600].includes(n)) {
          localStorage.setItem('mailflow_folder_sync_interval', String(n));
          set({ folderSyncInterval: n });
        }
      }
      // blockRemoteImages: explicit false disables blocking; anything else keeps the default (true)
      if (prefs.blockRemoteImages === false) set({ blockRemoteImages: false });
      else if (prefs.blockRemoteImages === true) set({ blockRemoteImages: true });
      if (prefs.autoLockMinutes != null) {
        const n = Number(prefs.autoLockMinutes);
        set({ autoLockMinutes: [0, 1, 5, 15, 30].includes(n) ? n : 0 });
      }
      if (prefs.imageWhitelist) set({ imageWhitelist: prefs.imageWhitelist });
      // Hydration is done, but if the user toggled while this GET was in flight
      // (epoch bumped), the toggle owns senderFavicons — only mark it loaded.
      if (get().senderFaviconsEpoch === faviconEpoch) {
        set({ senderFaviconsLoaded: true, senderFavicons: prefs.senderFavicons === true });
      } else {
        set({ senderFaviconsLoaded: true });
      }
      if (prefs.shortcuts) set({ shortcuts: prefs.shortcuts });
      if (Array.isArray(prefs.aiActions)) {
        set({ aiActions: prefs.aiActions });
      } else {
        // First run — seed editable example actions and persist them once so the
        // seed doesn't reappear after the user deletes them.
        set({ aiActions: DEFAULT_AI_ACTIONS });
        api.savePreferences({ aiActions: DEFAULT_AI_ACTIONS }).catch(() => {});
      }
      if (prefs.hiddenFolders) set({ hiddenFolders: prefs.hiddenFolders });
      set({ folderOrder: cacheFolderOrderFromPreferences(prefs) });
      if (prefs.expandedAccounts && typeof prefs.expandedAccounts === 'object' && !Array.isArray(prefs.expandedAccounts)) {
        localStorage.setItem('mailflow_expanded_accounts', JSON.stringify(prefs.expandedAccounts));
        set({ expandedAccounts: prefs.expandedAccounts });
      }
      if (Array.isArray(prefs.collapsedFolders)) {
        localStorage.setItem('mailflow_collapsed_folders', JSON.stringify(prefs.collapsedFolders));
        set({ collapsedFolders: prefs.collapsedFolders });
      }
      if (Array.isArray(prefs.favoriteFolders)) {
        localStorage.setItem('mailflow_favorite_folders', JSON.stringify(prefs.favoriteFolders));
        set({ favoriteFolders: prefs.favoriteFolders });
      }
      if (Array.isArray(prefs.recentFolders)) {
        localStorage.setItem('mailflow_recent_folders', JSON.stringify(prefs.recentFolders));
        set({ recentFolders: prefs.recentFolders });
      }
      if (prefs.language) {
        localStorage.setItem('mailflow_language', prefs.language);
        set({ language: prefs.language });
        i18n.changeLanguage(prefs.language);
      }
      if (prefs.calendarWeekStartsOn === 0 || prefs.calendarWeekStartsOn === 1) {
        set({ calendarWeekStartsOn: prefs.calendarWeekStartsOn });
      }
      if (Array.isArray(prefs.visibleCalendarIds)) {
        set({ visibleCalendarIds: prefs.visibleCalendarIds.filter((id: unknown) => typeof id === 'string') });
      }
      if (prefs.mobileNavigationPosition === 'top' || prefs.mobileNavigationPosition === 'bottom') {
        set({ mobileNavigationPosition: prefs.mobileNavigationPosition });
      }
      if (typeof prefs.calendarInviteAccountId === 'string') {
        set({ calendarInviteAccountId: prefs.calendarInviteAccountId });
      }
      if (Array.isArray(prefs.calendarWorkDays)) set({ calendarWorkDays: normalizeCalendarWorkDays(prefs.calendarWorkDays) });
      if (prefs.calendarWorkHoursStart || prefs.calendarWorkHoursEnd) {
        const calendarWorkHoursStart = prefs.calendarWorkHoursStart
          ? normalizeCalendarWorkTime(prefs.calendarWorkHoursStart)
          : get().calendarWorkHoursStart;
        const calendarWorkHoursEnd = prefs.calendarWorkHoursEnd
          ? normalizeCalendarWorkTime(prefs.calendarWorkHoursEnd, DEFAULT_CALENDAR_PREFERENCES.calendarWorkHoursEnd)
          : get().calendarWorkHoursEnd;
        set({
          calendarWorkHoursStart,
          calendarWorkHoursEnd,
          calendarWorkHoursPersisted: { start: calendarWorkHoursStart, end: calendarWorkHoursEnd },
          calendarWorkHoursError: '',
        });
      }
      if (typeof prefs.threadedView === 'boolean') {
        localStorage.setItem('mailflow_threaded_view', String(prefs.threadedView));
        set({ threadedView: prefs.threadedView });
      } else if (typeof prefs.conversation_list_view_enabled === 'boolean') {
        // Compatibility with the short-lived CE-only preference. Native threadedView
        // remains the canonical source of truth whenever it exists.
        localStorage.setItem('mailflow_threaded_view', String(prefs.conversation_list_view_enabled));
        set({ threadedView: prefs.conversation_list_view_enabled });
      }
      if (typeof prefs.plaintextEmail === 'boolean') {
        localStorage.setItem('mailflow_plaintext_email', String(prefs.plaintextEmail));
        set({ plaintextEmail: prefs.plaintextEmail });
      }
      if (typeof prefs.hoverQuickActions === 'boolean') {
        localStorage.setItem('mailflow_hover_quick_actions', String(prefs.hoverQuickActions));
        set({ hoverQuickActions: prefs.hoverQuickActions });
      }
      if (typeof prefs.showMobileAvatars === 'boolean') {
        localStorage.setItem('mailflow_show_mobile_avatars', String(prefs.showMobileAvatars));
        set({ showMobileAvatars: prefs.showMobileAvatars });
      }
      if (typeof prefs.gravatarAvatars === 'boolean') {
        localStorage.setItem('mailflow_gravatar_avatars', String(prefs.gravatarAvatars));
        set({ gravatarAvatars: prefs.gravatarAvatars });
      }
      if (typeof prefs.showMessagePreviews === 'boolean') {
        localStorage.setItem('mailflow_show_message_previews', String(prefs.showMessagePreviews));
        set({ showMessagePreviews: prefs.showMessagePreviews });
      }
      if (prefs.replyDefault === 'reply' || prefs.replyDefault === 'replyAll') {
        localStorage.setItem('mailflow_reply_default', prefs.replyDefault);
        set({ replyDefault: prefs.replyDefault });
      }
      if (prefs.markReadBehavior === 'immediate' || prefs.markReadBehavior === 'delay' || prefs.markReadBehavior === 'manual') {
        localStorage.setItem('mailflow_mark_read_behavior', prefs.markReadBehavior);
        set({ markReadBehavior: prefs.markReadBehavior });
      }
      if (prefs.markReadDelay) {
        const n = Math.max(1, Math.min(10, parseInt(prefs.markReadDelay) || 1));
        localStorage.setItem('mailflow_mark_read_delay', String(n));
        set({ markReadDelay: n });
      }
      if (prefs.sidebarWidth) {
        const n = parseInt(prefs.sidebarWidth);
        if (n >= 160 && n <= 400) {
          localStorage.setItem('mailflow_sidebar_width', String(n));
          set({ sidebarWidth: n });
        }
      }
      if (typeof prefs.showAppBadge === 'boolean') {
        localStorage.setItem('mailflow_app_badge', String(prefs.showAppBadge));
        set({ showAppBadge: prefs.showAppBadge });
      }
      if (typeof prefs.categorizationEnabled === 'boolean') {
        set({ categorizationEnabled: prefs.categorizationEnabled });
      }
      if (prefs.rightSidebarWidth != null) {
        const n = clampRightSidebarWidth(prefs.rightSidebarWidth);
        localStorage.setItem('mailflow_right_sidebar_width', String(n));
        set({ rightSidebarWidth: n });
      }
      if (prefs.gtdCollapsedSections && typeof prefs.gtdCollapsedSections === 'object' && !Array.isArray(prefs.gtdCollapsedSections)) {
        localStorage.setItem('mailflow_gtd_collapsed_sections', JSON.stringify(prefs.gtdCollapsedSections));
        set({ gtdCollapsedSections: prefs.gtdCollapsedSections });
      }
      if (typeof prefs.gtdPetSlug === 'string') {
        set({ gtdPetSlug: prefs.gtdPetSlug || null });
      }
      if (typeof prefs.rightSidebarHidden === 'boolean') {
        localStorage.setItem('mailflow_right_sidebar_hidden', String(prefs.rightSidebarHidden));
        set({ rightSidebarHidden: prefs.rightSidebarHidden });
      }
      if (typeof prefs.conversation_reader_view_enabled === 'boolean') set({ conversationReaderViewEnabled: prefs.conversation_reader_view_enabled });
      if (prefs.customCss) {
        applyCustomCss(prefs.customCss);
      }
    } catch { /* intentional */ }
  },
}));

// The RFC message_id of the currently selected message, resolved from the same pools the
// reading pane uses: the active folder/search list, then any stashed thread — including the
// __dl_ deep-link stash written by GTD sidebar selection. Returns null when nothing is selected
// or the selected row has no message_id. Lets the GTD sidebar and message list highlight every
// copy of the open message by identity (not just the exact DB row that was clicked). A plain selector, not
// a state field, so it stays in sync with the list automatically; returns a primitive so a
// useStore(selectSelectedMessageMid) subscription only re-renders when the value changes.
export function selectSelectedMessageMid(s: {
  selectedMessageId?: string | null;
  searchQuery?: string;
  searchResults?: StoreMessageRow[];
  messages?: StoreMessageRow[];
  threadMessages?: Record<string, StoreMessageRow[]>;
}) {
  const id = s.selectedMessageId;
  if (id == null) return null;
  const pool = s.searchQuery?.trim() ? s.searchResults : s.messages;
  const msg = pool?.find(m => m.id === id)
    ?? Object.values(s.threadMessages ?? {}).flat().find(m => m.id === id);
  return msg?.message_id ?? null;
}
