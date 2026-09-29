import { onAuthEpochChange } from './authEpoch.ts';
// pendingMarkReadMap: messageId → accountId for PATCHes that are still in-flight.
// Used by useWebSocket to adjust unread counts before the server has committed.
export const pendingMarkReadMap = new Map<string, string>();

// completedMarkReadMap: messageId → accountId for PATCHes that returned successfully
// but whose DB write may not yet be visible to a concurrent getMessages SELECT.
// Entries expire after 10s — long enough to cover any in-flight getMessages response
// that raced with the mark-read commit.
export const completedMarkReadMap = new Map<string, string>();

// Safety timeout handles keyed by messageId — cancels the previous timer if the
// same messageId is re-used before the old one fires, preventing a stale timer
// from deleting a newer in-flight entry for the same message.
const _pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
const _completedTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Set a pending entry with a 30-second safety timeout.
// Callers still call pendingMarkReadMap.delete() on success/error; the timeout
// is a fallback so a hung or abandoned request never leaves a permanent entry.
export function setPending(messageId: string, accountId: string): void {
  const prev = _pendingTimers.get(messageId);
  if (prev) clearTimeout(prev);
  const timer = setTimeout(() => {
    pendingMarkReadMap.delete(messageId);
    _pendingTimers.delete(messageId);
  }, 30000);
  _pendingTimers.set(messageId, timer);
  pendingMarkReadMap.set(messageId, accountId);
}

onAuthEpochChange(() => {
  for (const timer of _pendingTimers.values()) clearTimeout(timer);
  _pendingTimers.clear();
  for (const timer of _completedTimers.values()) clearTimeout(timer);
  _completedTimers.clear();
  pendingMarkReadMap.clear();
  completedMarkReadMap.clear();
});

/** A version-fenced authoritative readback releases both optimistic badge guards. */
export function clearReadGuards(messageId: string): void {
  const timer = _pendingTimers.get(messageId);
  if (timer) clearTimeout(timer);
  _pendingTimers.delete(messageId);
  const completedTimer = _completedTimers.get(messageId);
  if (completedTimer) clearTimeout(completedTimer);
  _completedTimers.delete(messageId);
  pendingMarkReadMap.delete(messageId);
  completedMarkReadMap.delete(messageId);
}

/** A newer confirmation cancels the preceding expiry callback for this copy. */
export function setCompletedRead(messageId: string, accountId: string): void {
  clearReadGuards(messageId);
  completedMarkReadMap.set(messageId, accountId);
  const timer = setTimeout(() => {
    if (_completedTimers.get(messageId) !== timer) return;
    _completedTimers.delete(messageId);
    completedMarkReadMap.delete(messageId);
  }, 10000);
  _completedTimers.set(messageId, timer);
}
