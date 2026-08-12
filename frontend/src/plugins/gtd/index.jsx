// GTD plugin — frontend registrations (v3.0 plugin platform).
//
// Registers GTD's UI into core's plugin slots so core components carry no GTD-specific code. This is
// the frontend twin of backend/src/plugins/gtd. Imported for its side effects by plugins/index.js.
// (The GTD UI components/utils still live under components/ & utils/ for now; later slices relocate
// them wholesale into this directory.)
import { registerSlot, registerPluginMeta, registerRuntime } from '../registry.js';
import { registerWsHandler, registerReconnectHandler } from '../events.js';
import GtdSidebarContent from '../../components/GtdSidebarContent.jsx';
import GtdRuntime from './GtdRuntime.jsx';
import GtdSettings from './GtdSettings.jsx';
import { gtdActiveForContext } from '../../utils/gtd.js';
import { accountAffectsUnifiedInbox } from '../../utils/unifiedInbox.js';
import { useStore } from '../../store/index.js';

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
  render: (ctx) => <GtdSettings initialSubTab={ctx.initialSubTab} />,
});

registerSlot('right-sidebar', {
  pluginId: 'gtd',
  isActive: (ctx) => gtdActiveForContext(ctx.accounts, ctx.selectedAccountId, true),
  render: (ctx) => <GtdSidebarContent onCollapse={ctx.onCollapse} toggleHint={ctx.toggleHint} />,
});

// WS: a GTD label folder changed (tick / classify copy-remove / transition strip). Refetch the
// rail+tab sections when the event's account is in the current rail scope (debounced in the store).
registerWsHandler('gtd_sections_updated', {
  pluginId: 'gtd',
  handler: (data) => {
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
