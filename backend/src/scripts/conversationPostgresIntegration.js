import { query, pool } from '../services/db.js';
import { rebuildConversationCopies } from '../services/conversationRebuild.js';

const userId = '00000000-0000-0000-0000-000000000101';
const accountId = '00000000-0000-0000-0000-000000000102';
const rootId = '00000000-0000-0000-0000-000000000103';
const replyId = '00000000-0000-0000-0000-000000000104';

async function checksum() {
  const result = await query(`
    SELECT md5(string_agg(payload, '|' ORDER BY payload)) AS checksum
    FROM (
      SELECT id::text || ':' || COALESCE(conversation_id::text, '') || ':' || COALESCE(logical_message_id::text, '') || ':' || COALESCE(threading_reason, '') AS payload
      FROM messages WHERE account_id = $1
      UNION ALL
      SELECT id::text || ':' || COALESCE(conversation_id::text, '') || ':' || COALESCE(canonical_message_id, '') || ':' || COALESCE(threading_reason, '') AS payload
      FROM logical_messages WHERE user_id = $2
      UNION ALL
      SELECT id::text || ':' || logical_message_count::text || ':' || copy_count::text || ':' || unread_count::text AS payload
      FROM conversations WHERE user_id = $2
    ) valueset
  `, [accountId, userId]);
  return result.rows[0].checksum;
}

async function main() {
  await query('DELETE FROM users WHERE id = $1', [userId]);
  await query('INSERT INTO users (id, username) VALUES ($1, $2)', [userId, `conversation-ci-${Date.now()}`]);
  await query('INSERT INTO email_accounts (id, user_id, name, email_address) VALUES ($1,$2,$3,$4)', [accountId, userId, 'CI', 'me@example.test']);
  await query(`INSERT INTO messages (id, account_id, uid, folder, message_id, subject, from_email, to_addresses, date, body_text, is_read)
    VALUES ($1,$2,1,'INBOX','<root@example.test>','CI root','sender@example.test','[{"email":"me@example.test"}]',NOW()-INTERVAL '2 minutes','root',false),
           ($3,$2,2,'INBOX','<reply@example.test>','Re: CI root','me@example.test','[{"email":"sender@example.test"}]',NOW()-INTERVAL '1 minute','reply',false)`, [rootId, accountId, replyId]);
  await query(`UPDATE messages SET in_reply_to = '<root@example.test>', thread_references = '<root@example.test>' WHERE id = $1`, [replyId]);

  const dry = await rebuildConversationCopies({ userId, accountId, limit: 500, dryRun: true });
  const first = await rebuildConversationCopies({ userId, accountId, limit: 500, dryRun: false });
  const firstChecksum = await checksum();
  await query('DELETE FROM conversation_rebuild_checkpoints WHERE user_id = $1 AND scope_account_id = $2', [userId, accountId]);
  const second = await rebuildConversationCopies({ userId, accountId, limit: 500, dryRun: false });
  const secondChecksum = await checksum();

  if (dry.updated !== 0 || first.updated !== 2 || second.updated !== 0 || firstChecksum !== secondChecksum) {
    throw new Error(`unexpected rebuild result: ${JSON.stringify({ dry, first, second, firstChecksum, secondChecksum })}`);
  }
  const attached = await query('SELECT COUNT(*)::int AS count FROM messages WHERE account_id = $1 AND conversation_id IS NOT NULL', [accountId]);
  if (attached.rows[0].count !== 2) throw new Error(`unexpected attachment count: ${attached.rows[0].count}`);

  console.log(JSON.stringify({ status: 'ok', dry, first, second, firstChecksum, secondChecksum, attached: attached.rows[0] }));
  await query('DELETE FROM users WHERE id = $1', [userId]);
  await pool.end();
}

main().catch(async error => {
  console.error(error.stack || error.message || error);
  await query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
  await pool.end();
  process.exitCode = 1;
});
