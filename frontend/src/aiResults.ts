// Per-device persistence for AI action results (#204). Results are cached in
// localStorage keyed by message id and action key, so a summary (or any custom
// action output) reappears when you navigate back to a message. Bounded by an
// LRU cap on the number of messages so the store can't grow without limit.
//
// Shape: { order: [messageId, ...oldest→newest], data: { [messageId]: { [actionKey]: { text, at, label } } } }

const KEY = 'mailflow_ai_results';
const MSG_CAP = 200;

export interface AiActionResult {
  text: string;
  at: number;
  label?: string;
}

export interface AiResultsStore {
  order: string[];
  data: Record<string, Record<string, AiActionResult>>;
}

function read(): AiResultsStore {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (parsed && typeof parsed === 'object' && parsed.data) {
      return { order: Array.isArray(parsed.order) ? parsed.order : [], data: parsed.data };
    }
  } catch { /* corrupt / unavailable */ }
  return { order: [], data: {} };
}

function write(store: AiResultsStore) {
  try { localStorage.setItem(KEY, JSON.stringify(store)); }
  catch { /* quota exceeded or storage disabled — cache is best-effort */ }
}

// Returns { [actionKey]: { text, at, label } } for a message (empty if none).
export function getResults(messageId?: string | null): Record<string, AiActionResult> {
  if (!messageId) return {};
  return read().data[messageId] || {};
}

// Persist a completed action result, marking the message as most-recently-used.
export function saveResult(messageId: string | null | undefined, actionKey: string | null | undefined, text: string, label: string | null | undefined = undefined) {
  if (!messageId || !actionKey) return;
  const store = read();
  if (!store.data[messageId]) store.data[messageId] = {};
  const result: AiActionResult = { text, at: Date.now() };
  if (label !== null && label !== undefined) result.label = label;
  store.data[messageId][actionKey] = result;
  store.order = store.order.filter(id => id !== messageId);
  store.order.push(messageId);
  while (store.order.length > MSG_CAP) {
    const evicted = store.order.shift();
    if (evicted !== undefined) delete store.data[evicted];
  }
  write(store);
}

// Remove a single action's cached result (used by the dismiss button).
export function removeResult(messageId: string | null | undefined, actionKey: string | null | undefined) {
  if (!messageId || !actionKey) return;
  const store = read();
  const forMsg = store.data[messageId];
  if (!forMsg || !(actionKey in forMsg)) return;
  delete forMsg[actionKey];
  if (Object.keys(forMsg).length === 0) {
    delete store.data[messageId];
    store.order = store.order.filter(id => id !== messageId);
  }
  write(store);
}
