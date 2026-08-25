// Safe read-only CE diagnostic. Usage:
// npm run diagnose:conversation -- <user-uuid> <physical-message-uuid-or-Message-ID>
// Prints identifiers/counts only: never body, credentials, or raw headers.
import { pool, query } from '../services/db.js';
import { normalizeMessageId } from '../services/threading/normalizeMessageId.js';

const [userId, ref] = process.argv.slice(2);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
if (!uuidPattern.test(userId || '')) throw new Error('Provide the owning user UUID first');
if (!ref) throw new Error('Provide a physical message UUID or RFC Message-ID');
const physicalUuid = uuidPattern.test(ref);
const canonical = physicalUuid ? null : normalizeMessageId(ref);
if (!physicalUuid && !canonical) throw new Error('Invalid physical message UUID or RFC Message-ID');
try {
  const result = await query(`
    SELECT m.id AS physical_id, m.account_id, m.message_id, m.in_reply_to, m.thread_references AS references,
           m.logical_message_id, m.conversation_id, lm.parent_logical_message_id,
           (SELECT COUNT(*)::int FROM logical_messages child WHERE child.user_id = a.user_id AND child.conversation_id = m.conversation_id) AS conversation_logical_count,
           (SELECT COUNT(*)::int FROM messages copy JOIN email_accounts copy_account ON copy_account.id = copy.account_id WHERE copy_account.user_id = a.user_id AND copy.logical_message_id = m.logical_message_id AND copy.is_deleted = false) AS physical_copy_count,
           (SELECT COUNT(DISTINCT copy.account_id)::int FROM messages copy JOIN email_accounts copy_account ON copy_account.id = copy.account_id WHERE copy_account.user_id = a.user_id AND copy.conversation_id = m.conversation_id AND copy.is_deleted = false) AS accounts_represented
      FROM messages m
      JOIN email_accounts a ON a.id = m.account_id AND a.user_id = $1
      LEFT JOIN logical_messages lm ON lm.id = m.logical_message_id AND lm.user_id = a.user_id
     WHERE m.is_deleted = false AND (${physicalUuid ? 'm.id = $2::uuid' : 'm.canonical_message_id = $2'})
     ORDER BY m.date ASC NULLS LAST, m.id
  `, [userId, physicalUuid ? ref : canonical]);
  console.log(JSON.stringify({ matches: result.rows }, null, 2));
} finally {
  await pool.end();
}
