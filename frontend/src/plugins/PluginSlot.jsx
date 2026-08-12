import { Fragment } from 'react';
import { useStore } from '../store/index.js';
import { getSlotContributions, getRuntimes } from './registry.js';

// The contributions registered for slot `name` that are live for this `ctx`: their plugin is
// activated (store.enabledPlugins) AND their own isActive(ctx) passes. Exposed as a hook so a caller
// can branch on whether ANY content exists before laying out around it — e.g. the right sidebar only
// "applies" (reserves width, binds its collapse shortcut) when a provider actually supplies content.
export function usePluginSlot(name, ctx) {
  const enabledPlugins = useStore(s => s.enabledPlugins);
  return getSlotContributions(name).filter(
    c => enabledPlugins.includes(c.pluginId) && c.isActive(ctx)
  );
}

// Render every live contribution for slot `name`, in registration order. Core drops this at a seam
// and stays plugin-agnostic. Returns null when nothing is live.
export function PluginSlot({ name, ctx }) {
  const live = usePluginSlot(name, ctx);
  if (!live.length) return null;
  return <>{live.map((c, i) => <Fragment key={`${c.pluginId}:${i}`}>{c.render(ctx)}</Fragment>)}</>;
}

// Mounts every activated plugin's headless runtime component (each renders null but runs its own
// effects/subscriptions). Placed once near the app root. Deactivating a plugin unmounts its runtime,
// tearing down its effects.
export function PluginRuntime() {
  const enabledPlugins = useStore(s => s.enabledPlugins);
  const runtimes = getRuntimes().filter(r => enabledPlugins.includes(r.pluginId));
  return <>{runtimes.map((r, i) => {
    const Runtime = r.component;
    return <Runtime key={`${r.pluginId}:${i}`} />;
  })}</>;
}
