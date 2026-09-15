import { removeGtdThreadFromSections, type GtdSections } from './gtd.ts';

/** One pending/completed GTD removal, keyed by identity + states. */
export type GtdRemovalEntry = { identity: string; states: string[]; timer: ReturnType<typeof setTimeout> };

export const pendingGtdRemovalMap = new Map<string, GtdRemovalEntry>();
export const completedGtdRemovalMap = new Map<string, GtdRemovalEntry>();

function normalizeStates(states: unknown): string[] {
  const list = Array.isArray(states) ? states : [];
  return [...new Set(list.filter((state): state is string => typeof state === 'string' && state !== ''))].sort();
}

function removalKey(identity: string, states: unknown): string {
  return JSON.stringify([identity, normalizeStates(states)]);
}

function setExpiring(map: Map<string, GtdRemovalEntry>, identity: string, states: unknown, ttlMs: number): void {
  const normalizedStates = normalizeStates(states);
  const key = removalKey(identity, normalizedStates);
  const existing = map.get(key);
  if (existing?.timer) clearTimeout(existing.timer);
  const timer = setTimeout(() => map.delete(key), ttlMs);
  map.set(key, { identity, states: normalizedStates, timer });
}

function clearRemoval(map: Map<string, GtdRemovalEntry>, identity: string, states: unknown): void {
  const key = removalKey(identity, states);
  const existing = map.get(key);
  if (existing?.timer) clearTimeout(existing.timer);
  map.delete(key);
}

export function setPendingGtdRemoval(identity: string, states: string[]): void {
  clearRemoval(completedGtdRemovalMap, identity, states);
  setExpiring(pendingGtdRemovalMap, identity, states, 30000);
}

export function setCompletedGtdRemoval(identity: string, states: string[]): void {
  clearRemoval(pendingGtdRemovalMap, identity, states);
  setExpiring(completedGtdRemovalMap, identity, states, 10000);
}

export function clearGtdRemovalGuard(identity: string, states: string[]): void {
  clearRemoval(pendingGtdRemovalMap, identity, states);
  clearRemoval(completedGtdRemovalMap, identity, states);
}

export function applyGtdRemovalGuard<S extends GtdSections>(sections: S): S {
  if (pendingGtdRemovalMap.size === 0 && completedGtdRemovalMap.size === 0) return sections;
  let guarded = sections;
  for (const removal of [...pendingGtdRemovalMap.values(), ...completedGtdRemovalMap.values()]) {
    guarded = removeGtdThreadFromSections(guarded, removal.identity, removal.states);
  }
  return guarded;
}
