// One browser entry represents the current dismissible UI, regardless of depth.
// Re-arm only while a layer remains; the mailbox root keeps normal browser/OS Back.
// A UI close consumes that entry too, so repeated open/close never leaves dead steps.
type BackHistory = {
  state: Record<string, unknown> | null;
  pushState: (state: Record<string, unknown>, unused: string) => void;
  back: () => void;
};

type BackNavigationOptions = {
  history: BackHistory;
  listen: (listener: () => void) => () => void;
  commit?: (callback: () => void) => void;
  schedule?: (callback: () => void) => void;
};

type BackLayer = {
  close: () => void;
  priority: number;
  order: number;
};

export function createBackNavigation({ history, listen, commit = callback => callback(), schedule = queueMicrotask }: BackNavigationOptions) {
  const layers = new Map<unknown, BackLayer>();
  let sequence = 0;
  let enabled = false;
  let removing = false;
  let queued = false;
  const key = 'inboxoraBack';
  const armed = () => history.state?.[key] === 'layer';
  const top = () => [...layers.values()].sort((a, b) => b.priority - a.priority || b.order - a.order)[0];
  const reconcile = () => {
    if (removing) return;
    if (enabled && layers.size) {
      if (!armed()) history.pushState({ ...history.state, [key]: 'layer' }, '');
    } else if (armed()) {
      removing = true;
      history.back();
    }
  };
  const changed = () => {
    if (queued) return;
    queued = true;
    schedule(() => { queued = false; reconcile(); });
  };
  const dismiss = () => {
    const layer = top();
    if (!layer) return false;
    commit(() => layer.close());
    return true; // Busy forms still consume Back without abandoning a save.
  };
  const onPop = () => {
    if (removing) {
      removing = false;
    } else if (enabled && !armed()) {
      dismiss();
    }
    reconcile();
  };
  return {
    register(id: unknown, close: () => void, priority = 0) {
      layers.set(id, { close, priority, order: ++sequence });
      changed();
      return () => { layers.delete(id); changed(); };
    },
    setEnabled(value: boolean) { enabled = value; changed(); },
    back() { const handled = dismiss(); reconcile(); return handled; },
    start() {
      // A reload cannot restore transient editors from history. Adopt its entry
      // and consume it after the current mounted layers have registered.
      const unlisten = listen(onPop);
      changed();
      return unlisten;
    },
  };
}
