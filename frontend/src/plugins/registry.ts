// Frontend plugin slot registry (v3.0 plugin platform — frontend half).
//
// The backend gives each plugin a bounded capability surface; this is its frontend twin. A Tier-1
// plugin registers UI contributions into named "slots"; core components render a slot via
// <PluginSlot/> / usePluginSlot (see PluginSlot.jsx) without importing or hard-conditioning any
// specific plugin. Core places the seam; the plugin fills it. Registration is side-effecting at
// module load (see plugins/index.js), mirroring the backend's in-process registry.
//
// A contribution: { pluginId, order?, isActive?(ctx), render(ctx) }.
//  - pluginId — gated by per-user activation (store.enabledPlugins) at render time, so a
//    deactivated plugin contributes nothing.
//  - order    — ascending sort within a slot (default 0) for deterministic placement.
//  - isActive — a finer, context-scoped gate beyond activation (e.g. "GTD is on for this account");
//    defaults to always-on. Activation is checked separately, so isActive need not re-check it.
//  - render   — (ctx) => ReactNode. ctx is the slot's documented data contract.

/** A slot's context contract is plugin-defined, so it stays an open record. */
type SlotContext = Record<string, unknown>;

/** A slot contribution as a plugin registers it. */
interface SlotContribution {
  pluginId: string;
  order?: number;
  isActive?: (ctx: SlotContext) => boolean;
  render: (ctx: SlotContext) => React.ReactNode;
  [key: string]: unknown;
}
/** A stored slot contribution: the registration defaults are now always present. */
type RegisteredSlotContribution = SlotContribution & { order: number; isActive: (ctx: SlotContext) => boolean };

const slots = new Map<string, RegisteredSlotContribution[]>(); // slotName -> Array<contribution>

export function registerSlot(slotName: string, contribution: SlotContribution): void {
  const list = slots.get(slotName) || [];
  const entry: RegisteredSlotContribution = {
    ...contribution,
    order: contribution.order ?? 0,
    isActive: contribution.isActive ?? (() => true),
  };
  list.push(entry);
  list.sort((a, b) => a.order - b.order);
  slots.set(slotName, list);
}

export function getSlotContributions(slotName: string): RegisteredSlotContribution[] {
  return slots.get(slotName) || [];
}

// Static per-plugin metadata a plugin declares about itself, so core never hardcodes plugin facts.
// e.g. settingsLocation: { tab, subtab, labelKey } tells the Plugins tab where a plugin's own
// settings live, replacing core's former hardcoded PLUGIN_SETTINGS_LOCATION map.
/** A plugin-owned Settings location that core can present as a navigation link. */
interface PluginSettingsLocation {
  tab: string;
  subtab?: string;
  labelKey: string;
}

/** Per-plugin metadata is open, with the core-consumed navigation field declared. */
interface PluginMeta {
  settingsLocation?: PluginSettingsLocation;
  [key: string]: unknown;
}
const pluginMeta = new Map<string, PluginMeta>(); // pluginId -> meta object

export function registerPluginMeta(pluginId: string, meta: PluginMeta): void {
  pluginMeta.set(pluginId, { ...pluginMeta.get(pluginId), ...meta });
}

export function getPluginMeta(pluginId: string): PluginMeta | null {
  return pluginMeta.get(pluginId) || null;
}

// Headless runtime components a plugin mounts once (near the app root) to run background behaviour
// with no UI of its own — data-fetch effects, subscriptions, timers. Rendered by <PluginRuntime/>
// only while the plugin is activated, so a plugin's effects tear down when the user deactivates it.
/** One registered plugin runtime: the id it is gated by and the component to render. */
interface RegisteredRuntime { pluginId: string; component: React.ComponentType }
const runtimes: RegisteredRuntime[] = []; // [{ pluginId, component }]

export function registerRuntime(contribution: RegisteredRuntime): void {
  runtimes.push(contribution);
}

export function getRuntimes(): RegisteredRuntime[] {
  return runtimes;
}

// Data (descriptor) contributions a plugin injects into a core-rendered list — e.g. context-menu
// items. Unlike slots (which render), a collector's `build(ctx)` returns plain descriptor arrays that
// core renders with its OWN chrome (so placement/styling stay consistent). Gathered via
// usePluginCollected, activation-gated.
/** A context-menu action supplied by a plugin and rendered by the core menu chrome. */
export interface PluginMenuAction {
  label: React.ReactNode;
  icon?: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
  hasSubmenu?: boolean;
  keepOpen?: boolean;
  action: () => void;
}

/** A collector contribution: plugin id plus the builder core calls with the collector context. */
interface CollectorContribution {
  pluginId: string;
  build: (ctx: SlotContext) => PluginMenuAction[] | null | undefined;
  [key: string]: unknown;
}
const collectors = new Map<string, CollectorContribution[]>(); // name -> [{ pluginId, build }]

export function registerCollector(name: string, contribution: CollectorContribution): void {
  const list = collectors.get(name) || [];
  list.push(contribution);
  collectors.set(name, list);
}

export function getCollectors(name: string): CollectorContribution[] {
  return collectors.get(name) || [];
}
