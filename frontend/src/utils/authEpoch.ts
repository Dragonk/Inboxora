/**
 * Process-wide authentication generation for work that must outlive a component.
 * This module deliberately has no store/API imports, so the API client can use it
 * without creating an api → store import cycle.
 */
let authEpoch = 0;
const listeners = new Set<(epoch: number) => void>();

export function getAuthEpoch(): number {
  return authEpoch;
}

export function isCurrentAuthEpoch(epoch: number): boolean {
  return authEpoch === epoch;
}

export function setAuthEpoch(nextEpoch: number): void {
  if (nextEpoch === authEpoch) return;
  authEpoch = nextEpoch;
  for (const listener of listeners) listener(authEpoch);
}

export function onAuthEpochChange(listener: (epoch: number) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
