// pendingDeleteMap: messageId -> timeout metadata for deletes hidden optimistically
// but not yet committed to the server because the Undo toast is still active.
type ExpiringEntry = { timer: ReturnType<typeof setTimeout> };

export const pendingDeleteMap = new Map<string | null | undefined, ExpiringEntry>();
export const completedDeleteMap = new Map<string | null | undefined, ExpiringEntry>();

function setExpiring(map: Map<string | null | undefined, ExpiringEntry>, messageId: string | null | undefined, ttlMs: number) {
  const existing = map.get(messageId);
  if (existing?.timer) clearTimeout(existing.timer);
  const timer = setTimeout(() => map.delete(messageId), ttlMs);
  map.set(messageId, { timer });
}

export function setPendingDelete(messageId: string | null | undefined) {
  clearCompletedDelete(messageId);
  setExpiring(pendingDeleteMap, messageId, 30000);
}

export function clearPendingDelete(messageId: string | null | undefined) {
  const existing = pendingDeleteMap.get(messageId);
  if (existing?.timer) clearTimeout(existing.timer);
  pendingDeleteMap.delete(messageId);
}

export function setCompletedDelete(messageId: string | null | undefined) {
  clearPendingDelete(messageId);
  setExpiring(completedDeleteMap, messageId, 10000);
}

export function clearCompletedDelete(messageId: string | null | undefined) {
  const existing = completedDeleteMap.get(messageId);
  if (existing?.timer) clearTimeout(existing.timer);
  completedDeleteMap.delete(messageId);
}

export function clearDeleteGuard(messageId: string | null | undefined) {
  clearPendingDelete(messageId);
  clearCompletedDelete(messageId);
}

export function threadDeleteGuardKey(threadId: string | null | undefined, folder: string | null | undefined, accountId: string | null = null): string | null {
  if (!threadId || !folder) return null;
  const accountScope = accountId ? `:account:${accountId}` : '';
  return `thread:${threadId}${accountScope}:folder:${folder}`;
}

export function applyDeleteGuard<T extends { id?: string; thread_id?: string; folder?: string; account_id?: string }>(messages: T[]): T[] {
  if (pendingDeleteMap.size === 0 && completedDeleteMap.size === 0) return messages;
  return messages.filter((m) => {
    const guarded = (key: string | null | undefined) => key && (pendingDeleteMap.has(key) || completedDeleteMap.has(key));
    const threadKey = m.thread_id ? `thread:${m.thread_id}` : null;
    const folderThreadKey = threadDeleteGuardKey(m.thread_id, m.folder);
    const accountThreadKey = threadDeleteGuardKey(m.thread_id, m.folder, m.account_id);
    return !pendingDeleteMap.has(m.id)
      && !completedDeleteMap.has(m.id)
      && !guarded(threadKey)
      && !guarded(folderThreadKey)
      && !guarded(accountThreadKey);
  });
}
