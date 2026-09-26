/**
 * Process-local, user-scoped invalidation for committed mail changes.
 *
 * Call only AFTER the transaction promise has resolved. This is deliberately
 * separate from new-mail alerts: backfills and read/move updates must refresh
 * the UI without replaying notifications or inbox rules. A separate CLI process
 * has no connected clients; the browser's bounded read fallback covers it.
 */
export interface MailStateChanged {
  type: 'mail_state_changed';
  accountId: string;
  /** null means all folders/label memberships of this account may have changed. */
  folders: string[] | null;
}

type Listener = (event: MailStateChanged) => void;
const listeners = new Map<string, Set<Listener>>();
type Batch = { folders: Set<string> | null; timer: ReturnType<typeof setTimeout> };
const pending = new Map<string, Map<string, Batch>>();
const COALESCE_MS = 250;
const MAX_FOLDER_HINTS = 32;

/** Register only after WebSocket authentication. The disposer cancels unused work. */
export function subscribeMailStateChanges(userId: string, listener: Listener): () => void {
  if (!userId) throw new Error('A mail-state subscription requires an authenticated owner');
  const owned = listeners.get(userId) ?? new Set<Listener>();
  listeners.set(userId, owned);
  owned.add(listener);
  return () => {
    owned.delete(listener);
    if (owned.size || listeners.get(userId) !== owned) return;
    listeners.delete(userId);
    for (const work of pending.get(userId)?.values() ?? []) clearTimeout(work.timer);
    pending.delete(userId);
  };
}

/** Coalesce invalidations, never delaying a continuous stream beyond the first timer. */
export function publishMailStateChanged(input: {
  userId: string;
  accountId: string;
  folders?: readonly string[];
}): void {
  if (!input.userId || !input.accountId || !listeners.get(input.userId)?.size) return;
  const batches = pending.get(input.userId) ?? new Map<string, Batch>();
  pending.set(input.userId, batches);
  const existing = batches.get(input.accountId);
  if (existing) {
    if (!input.folders?.length) existing.folders = null;
    else if (existing.folders) {
      for (const path of input.folders) existing.folders.add(path);
      if (existing.folders.size > MAX_FOLDER_HINTS) existing.folders = null;
    }
    return;
  }
  const folders = input.folders?.length && input.folders.length <= MAX_FOLDER_HINTS
    ? new Set(input.folders) : null;
  const timer = setTimeout(() => {
    const batch = batches.get(input.accountId);
    if (!batch) return;
    batches.delete(input.accountId);
    if (!batches.size) pending.delete(input.userId);
    const event: MailStateChanged = {
      type: 'mail_state_changed', accountId: input.accountId,
      folders: batch.folders ? [...batch.folders] : null,
    };
    for (const listener of listeners.get(input.userId) ?? []) {
      try { listener(event); }
      catch { console.warn('Mail-state delivery failed; client reconciliation remains available'); }
    }
  }, COALESCE_MS);
  timer.unref?.();
  batches.set(input.accountId, { folders, timer });
}
