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

const slots = new Map(); // slotName -> Array<contribution>

export function registerSlot(slotName, contribution) {
  const list = slots.get(slotName) || [];
  list.push({ order: 0, isActive: () => true, ...contribution });
  list.sort((a, b) => a.order - b.order);
  slots.set(slotName, list);
}

export function getSlotContributions(slotName) {
  return slots.get(slotName) || [];
}
