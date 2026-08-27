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
    SELECT m.id AS physical_copy_id, m.account_id, m.message_id AS rfc_message_id,
           m.thread_key, m.thread_id AS native_thread_id, m.provider_namespace, m.provider_thread_id,
           m.in_reply_to, m.thread_references AS references,
           m.logical_message_id, m.conversation_id, lm.parent_logical_message_id,
           parent.canonical_message_id AS parent_rfc_message_id,
           (SELECT COUNT(*)::int FROM messages native_copy WHERE native_copy.account_id = m.account_id AND native_copy.thread_key = m.thread_key AND native_copy.is_deleted = false) AS native_thread_count,
           (SELECT COUNT(*)::int FROM logical_messages child WHERE child.user_id = a.user_id AND child.account_id = m.account_id AND child.conversation_id = m.conversation_id) AS ce_logical_count,
           (SELECT COUNT(*)::int FROM messages copy WHERE copy.account_id = m.account_id AND copy.conversation_id = m.conversation_id AND copy.is_deleted = false) AS ce_physical_copy_count,
           EXISTS (SELECT 1 FROM conversation_overrides o WHERE o.user_id = a.user_id AND o.account_id = m.account_id AND (o.conversation_id = m.conversation_id OR o.logical_message_id = m.logical_message_id)) AS manual_override_or_lock_present,
           (SELECT COALESCE(jsonb_agg(DISTINCT ref.canonical_message_id) FILTER (WHERE ref.canonical_message_id IS NOT NULL), '[]'::jsonb)
              FROM logical_messages ref
             WHERE ref.user_id = a.user_id AND ref.account_id = m.account_id
               AND ref.canonical_message_id = ANY(regexp_split_to_array(COALESCE(m.thread_references, ''), '\\s+'))) AS resolved_reference_identities
      FROM messages m
      JOIN email_accounts a ON a.id = m.account_id AND a.user_id = $1
      LEFT JOIN logical_messages lm ON lm.id = m.logical_message_id AND lm.user_id = a.user_id AND lm.account_id = m.account_id
      LEFT JOIN logical_messages parent ON parent.id = lm.parent_logical_message_id AND parent.user_id = a.user_id AND parent.account_id = m.account_id
     WHERE m.is_deleted = false AND (${physicalUuid ? 'm.id = $2::uuid' : 'm.canonical_message_id = $2'})
     ORDER BY m.date ASC NULLS LAST, m.id
  `, [userId, physicalUuid ? ref : canonical]);
  console.log(JSON.stringify({ matches: result.rows }, null, 2));
} finally {
  await pool.end();
}
