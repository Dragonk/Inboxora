export function bulkUnreadDelta(message) {
  const aggregateUnread = Number.parseInt(message.unread_count, 10);
  return Number.isFinite(aggregateUnread) ? aggregateUnread : (message.is_read ? 0 : 1);
}

export function failedBulkTargets(targets, failedIds) {
  return [...targets.values()].filter(message => failedIds.has(String(message.id)));
}

export function failedBulkRow(row, targets, failedIds) {
  const failed = failedBulkTargets(targets, failedIds);
  if (!failed.length) return row;
  const unreadCount = failed.filter(message => !message.is_read).length;
  return { ...row, is_read: unreadCount === 0, unread_count: unreadCount, message_count: failed.length, copy_count: failed.length };
}
