/** The row fields the bulk-rollback helpers read. */
interface BulkRollbackRow { id?: string | number | null; is_read?: boolean }
type BulkRollbackResult<R> = R | (R & { is_read: boolean; unread_count: number; message_count: number; copy_count: number });

export function bulkUnreadDelta(message: { unread_count?: string | number | null; is_read?: boolean }): number {
  const aggregateUnread = Number.parseInt(`${message.unread_count}`, 10);
  return Number.isFinite(aggregateUnread) ? aggregateUnread : (message.is_read ? 0 : 1);
}

export function failedBulkTargets<T extends BulkRollbackRow>(targets: Map<string, T>, failedIds: Set<string>): T[] {
  return [...targets.values()].filter(message => failedIds.has(String(message.id)));
}

export function failedBulkRow<R extends BulkRollbackRow, T extends BulkRollbackRow>(
  row: R,
  targets: Map<string, T>,
  failedIds: Set<string>,
): BulkRollbackResult<R> {
  const failed = failedBulkTargets(targets, failedIds);
  if (!failed.length) return row;
  const unreadCount = failed.filter(message => !message.is_read).length;
  return { ...row, is_read: unreadCount === 0, unread_count: unreadCount, message_count: failed.length, copy_count: failed.length };
}
