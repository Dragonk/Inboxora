// GTD plugin — frontend registrations (v3.0 plugin platform).
//
// Registers GTD's UI into core's plugin slots so core components carry no GTD-specific code. This is
// the frontend twin of backend/src/plugins/gtd. Imported for its side effects by plugins/index.js.
// (The GTD UI components/utils still live under components/ & utils/ for now; later slices relocate
// them wholesale into this directory.)
import { registerSlot, registerPluginMeta, registerRuntime, registerCollector } from '../registry.ts';
import { registerWsHandler, registerReconnectHandler } from '../events.ts';
import GtdSidebarContent from '../../components/GtdSidebarContent.tsx';
import GtdRuntime from './GtdRuntime.tsx';
import GtdSettings from './GtdSettings.tsx';
import GtdRowDone from './GtdRowDone.tsx';
import { buildGtdContextItems } from './GtdContextMenu.tsx';
import { gtdActiveForContext } from '../../utils/gtd.ts';
import { accountAffectsUnifiedInbox } from '../../utils/unifiedInbox.ts';
import { useStore } from '../../store/index.ts';
import type { MouseEvent, ReactNode } from 'react';
import type { GtdAccountLike } from '../../utils/gtd.ts';
import type { StoreMessageRow } from '../../store/index.ts';

type SlotRecord = Record<string, unknown>;
type GtdContextMessage = { id: string; folders?: string[]; [key: string]: unknown };
type DoneAction = (event: MouseEvent) => void;
type ContextMenuTranslation = (key: string, options?: Record<string, string>) => string;
type OpenSubmenu = (render: (onBack: () => void) => ReactNode) => void;

function isRecord(value: unknown): value is SlotRecord {
  return typeof value === 'object' && value !== null;
}

function isGtdAccount(value: unknown): value is GtdAccountLike {
  return isRecord(value);
}

function isGtdAccountList(value: unknown): value is GtdAccountLike[] {
  return Array.isArray(value) && value.every(isGtdAccount);
}

function isGtdContextMessage(value: unknown): value is GtdContextMessage {
  if (!isRecord(value) || typeof value.id !== 'string') return false;
  return value.folders === undefined || (Array.isArray(value.folders) && value.folders.every(folder => typeof folder === 'string'));
}

function isSelectedAccountId(value: unknown): value is string | null | undefined {
  return typeof value === 'string' || value === null || value === undefined;
}

function isStoreMessageRow(value: unknown): value is StoreMessageRow {
  return isRecord(value) && typeof value.id === 'string' && typeof value.account_id === 'string';
}

function isDoneAction(value: unknown): value is DoneAction {
  return typeof value === 'function';
}

function isVoidCallback(value: unknown): value is () => void {
  return typeof value === 'function';
}

function isActionCallback(value: unknown): value is (action: string) => void {
  return typeof value === 'function';
}

function isContextMenuTranslation(value: unknown): value is ContextMenuTranslation {
  return typeof value === 'function';
}

function isOpenSubmenu(value: unknown): value is OpenSubmenu {
  return typeof value === 'function';
}

// Right-sidebar panel: GTD's triage rail. Live when GTD is on for the current account scope
// (per-user activation is already checked by the slot registry, so pass `true` here).
// ctx: { accounts, selectedAccountId, onCollapse, toggleHint }.
// Where GTD's own settings live, so the Plugins tab can point the user there once GTD is activated.
// Replaces core's former hardcoded PLUGIN_SETTINGS_LOCATION map (a nav fact core shouldn't own).
registerPluginMeta('gtd', {
  settingsLocation: { tab: 'categories', subtab: 'gtd', labelKey: 'admin.tabs.categories' },
});

// Headless runtime: owns the GTD sections fetch (mounted only while GTD is activated).
registerRuntime({ pluginId: 'gtd', component: GtdRuntime });

// Settings: GTD's per-account + pet settings block, shown under the Categories tab (rendered only
// while GTD is activated). ctx: { initialSubTab } — 'gtd' deep-links the block open.
registerSlot('settings-categories', {
  pluginId: 'gtd',
  render: (ctx: unknown) => {
    if (!isRecord(ctx)) return null;
    const initialSubTab = ctx.initialSubTab;
    if (initialSubTab !== undefined && initialSubTab !== null && typeof initialSubTab !== 'string') return null;
    const settingsSubTab = typeof initialSubTab === 'string' ? initialSubTab : undefined;
    return <GtdSettings initialSubTab={settingsSubTab} />;
  },
});

registerSlot('right-sidebar', {
  pluginId: 'gtd',
  isActive: (ctx: unknown) => {
    if (!isRecord(ctx) || !isGtdAccountList(ctx.accounts) || !isSelectedAccountId(ctx.selectedAccountId)) return false;
    return gtdActiveForContext(ctx.accounts, ctx.selectedAccountId, true);
  },
  render: (ctx: unknown) => {
    if (!isRecord(ctx) || !isVoidCallback(ctx.onCollapse) || typeof ctx.toggleHint !== 'string') return null;
    return <GtdSidebarContent onCollapse={ctx.onCollapse} toggleHint={ctx.toggleHint} />;
  },
});

// Context-menu items (GTD submenu + sidebar "Done"), injected into the 'Actions' group at the seam
// where GTD used to sit. ctx: { message, account, variant, onAction, onClose, openSubmenu, t }.
registerCollector('context-menu-actions', {
  pluginId: 'gtd',
  build: (ctx: unknown) => {
    if (!isRecord(ctx) || !isGtdContextMessage(ctx.message)) return [];
    const { account, variant, onAction, onClose, openSubmenu, t } = ctx;
    if (
      !isGtdAccount(account) ||
      typeof variant !== 'string' ||
      !isActionCallback(onAction) ||
      !isVoidCallback(onClose) ||
      !isOpenSubmenu(openSubmenu) ||
      !isContextMenuTranslation(t)
    ) return [];
    return buildGtdContextItems({
      message: ctx.message,
      account,
      variant,
      onAction,
      onClose,
      openSubmenu,
      t,
    });
  },
});

// Row hover "done" checkmark on main-list rows of a GTD-active account (activation already gated by
// the registry). ctx: { message }.
registerSlot('row-hover-action', {
  pluginId: 'gtd',
  isActive: (ctx: unknown) => {
    if (!isRecord(ctx) || !isStoreMessageRow(ctx.message)) return false;
    return gtdActiveForContext(useStore.getState().accounts, ctx.message.account_id, true);
  },
  // ctx.done (optional) lets a surface inject its own done action (the GTD sidebar's section-scoped
  // strip); the main list omits it and GtdRowDone runs its inbox-archive default.
  render: (ctx: unknown) => {
    if (!isRecord(ctx) || !isStoreMessageRow(ctx.message)) return null;
    const done = ctx.done;
    if (done === undefined) return <GtdRowDone message={ctx.message} />;
    if (!isDoneAction(done)) return null;
    return <GtdRowDone message={ctx.message} done={done} />;
  },
});

// WS: a GTD label folder changed (tick / classify copy-remove / transition strip). Refetch the
// rail+tab sections when the event's account is in the current rail scope (debounced in the store).
registerWsHandler('gtd_sections_updated', {
  pluginId: 'gtd',
  handler: (data) => {
    if (typeof data.accountId !== 'string') return;
    const store = useStore.getState();
    if (
      (store.selectedAccountId === null && accountAffectsUnifiedInbox(store.accounts, data.accountId)) ||
      store.selectedAccountId === data.accountId
    ) {
      store.scheduleGtdSectionsFetch();
    }
  },
});

// On WS reconnect, gtd_sections_updated events fired during the outage are lost (not buffered).
// Refetch the sections if GTD is active in the current scope (activation is already gated by the
// dispatcher, so the account-scope check is what matters here).
registerReconnectHandler({
  pluginId: 'gtd',
  handler: () => {
    const { accounts, selectedAccountId, scheduleGtdSectionsFetch } = useStore.getState();
    if (gtdActiveForContext(accounts, selectedAccountId, true)) scheduleGtdSectionsFetch();
  },
});
