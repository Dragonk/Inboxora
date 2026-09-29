import { populatedMessageSql, visiblePhysicalMessageSql } from './messageVisibility.js';
import { query } from './db.js';

/** Count visible physical unread mail, not verified aliases, events or cached folder totals. */
export async function readUnreadInboxCounts(userId: string): Promise<{
  total: number; byAccount: Record<string, number>;
}> {
  const result = await query<{ account_id: string; include_in_unified_inbox: boolean | null; count: string }>(`
    SELECT m.account_id, a.include_in_unified_inbox, COUNT(*) AS count
    FROM messages m
    JOIN email_accounts a ON a.id = m.account_id
    WHERE a.user_id = $1 AND a.enabled = true
      AND m.is_read = false AND m.is_deleted = false AND m.is_archived = false
      AND ${visiblePhysicalMessageSql}
      AND (m.folder = 'INBOX' OR EXISTS (
        SELECT 1 FROM message_labels ml
        WHERE ml.message_id = m.id AND ml.account_id = m.account_id AND ml.folder_path = 'INBOX'
      ))
      AND ${populatedMessageSql}
    GROUP BY m.account_id, a.include_in_unified_inbox
  `, [userId]);
  const byAccount: Record<string, number> = {};
  let total = 0;
  for (const row of result.rows) {
    const count = Number(row.count);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid unread-count result');
    byAccount[row.account_id] = count;
    if (row.include_in_unified_inbox !== false) total += count;
  }
  return { total, byAccount };
}
