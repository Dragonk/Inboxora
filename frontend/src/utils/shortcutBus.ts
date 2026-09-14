// Minimal pub/sub bus for keyboard shortcut actions.
// Keys are action names (strings); handlers are zero-argument functions.
// Components subscribe in a useEffect and unsubscribe on cleanup.

const handlers: Record<string, Set<() => void>> = {};

export const shortcutBus = {
  on(action: string, handler: () => void): void {
    if (!handlers[action]) handlers[action] = new Set();
    handlers[action].add(handler);
  },
  off(action: string, handler: () => void): void {
    handlers[action]?.delete(handler);
  },
  emit(action: string): void {
    handlers[action]?.forEach(h => { try { h(); } catch (e) { console.error('shortcut handler error', e); } });
  },
};
