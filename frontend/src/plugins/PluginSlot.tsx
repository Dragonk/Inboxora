import { Fragment } from 'react';
import { useStore } from '../store/index.ts';
import { getSlotContributions, getRuntimes, getCollectors } from './registry.ts';
import type { StoreState } from '../store/index.ts';

// The registry leaves a slot/collector context plugin-defined (an open record), and names are its
// accessor keys; take both contracts straight from the registry's own signatures rather than
// re-declaring them here.
/** A registered slot/collector name (the registry accessor key). */
type SlotName = Parameters<typeof getSlotContributions>[0];
/** The plugin-defined context record a slot/collector contribution receives. */
type SlotContext = Parameters<ReturnType<typeof getSlotContributions>[number]['isActive']>[0];

// The contributions registered for slot `name` that are live for this `ctx`: their plugin is
// activated (store.enabledPlugins) AND their own isActive(ctx) passes. Exposed as a hook so a caller
// can branch on whether ANY content exists before laying out around it — e.g. the right sidebar only
// "applies" (reserves width, binds its collapse shortcut) when a provider actually supplies content.
export function usePluginSlot(name: SlotName, ctx: SlotContext) {
  const enabledPlugins = useStore((s: StoreState) => s.enabledPlugins);
  return getSlotContributions(name).filter(
    c => enabledPlugins.includes(c.pluginId) && c.isActive(ctx)
  );
}

// The merged descriptor array contributed by activated plugins for collector `name`. Core renders
// the descriptors with its own chrome (e.g. context-menu rows). A throwing builder contributes nothing.
export function usePluginCollected(name: SlotName, ctx: SlotContext) {
  const enabledPlugins = useStore((s: StoreState) => s.enabledPlugins);
  return getCollectors(name)
    .filter(c => enabledPlugins.includes(c.pluginId))
    .flatMap(c => { try { return c.build(ctx) || []; } catch { return []; } });
}

// Render every live contribution for slot `name`, in registration order. Core drops this at a seam
// and stays plugin-agnostic. Returns null when nothing is live.
export function PluginSlot({ name, ctx }: { name: SlotName; ctx: SlotContext }) {
  const live = usePluginSlot(name, ctx);
  if (!live.length) return null;
  return <>{live.map((c, i) => <Fragment key={`${c.pluginId}:${i}`}>{c.render(ctx)}</Fragment>)}</>;
}

// Mounts every activated plugin's headless runtime component (each renders null but runs its own
// effects/subscriptions). Placed once near the app root. Deactivating a plugin unmounts its runtime,
// tearing down its effects.
export function PluginRuntime() {
  const enabledPlugins = useStore((s: StoreState) => s.enabledPlugins);
  const runtimes = getRuntimes().filter(r => enabledPlugins.includes(r.pluginId));
  return <>{runtimes.map((r, i) => {
    const Runtime = r.component;
    return <Runtime key={`${r.pluginId}:${i}`} />;
  })}</>;
}
