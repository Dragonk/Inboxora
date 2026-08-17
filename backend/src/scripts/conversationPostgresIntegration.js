import { pool, query } from '../services/db.js';
import { rebuildConversationCopies } from '../services/conversationRebuild.js';

const userId = '00000000-0000-0000-0000-000000000101';
const accountId = '00000000-0000-0000-0000-000000000102';
const rootId = '00000000-0000-0000-0000-000000000103';
const replyId = '00000000-0000-0000-0000-000000000104';

async function main() {
  await query('DELETE FROM users WHERE id = $1', [userId]);
  await query(`INSERT INTO users (id, username) VALUES ($1, $2)`, [userId, `conversation-ci-${Date.now()}`]);
  await query(`INSERT INTO email_accounts (id, user_id, name, email_address) VALUES ($1,$2,$3,$4)`, [accountId, userId, 'CI', 'me@example.test']);
  await query(`INSERT INTO messages (id, account_id, uid, folder, message_id, subject, from_email, to_addresses, date, body_text, is_read)
    VALUES ($1,$2,1,'INBOX','<root@example.test>','CI root','sender@example.test','[{"email":"me@example.test"}]',NOW()-INTERVAL '2 minutes','root',false),
           ($3,$2,2,'INBOX','<reply@example.test>','Re: CI root','me@example.test','[{"email":"sender@example.test"}]',NOW()-INTERVAL '1 minute','reply',false)`, [rootId, accountId, replyId]);
  await query(`UPDATE messages SET in_reply_to = '<root@example.test>', thread_references = '<root@example.test>' WHERE id = $1`, [replyId]);

  const dry = await rebuildConversationCopies({ userId, accountId, limit: 1, dryRun: true });
  if (dry.updated !== 0 || dry.scanned !== 1) throw new Error(`unexpected dry-run result: ${JSON.stringify(dry)}`);
  const write = await rebuildConversationCopies({ userId, accountId, limit: 1, dryRun: false });
  const second = await rebuildConversationCopies({ userId, accountId, limit: 10, dryRun: false });
  const attached = await query(`SELECT COUNT(*)::int AS count FROM messages WHERE account_id = $1 AND conversation_id IS NOT NULL`, [accountId]);
  if (write.updated !== 1 || second.updated !== 2 || attached.rows[0].count !== 2) throw new Error(`unexpected rebuild result: ${JSON.stringify({ write, second, attached: attached.rows[0] })}`);

  console.log(JSON.stringify({ status: 'ok', dry, write, second, attached: attached.rows[0] }));
  await query('DELETE FROM users WHERE id = $1', [userId]);
  await pool.end();
}

main().catch(async error => {
  console.error(error.stack || error.message || error);
  await query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
  await pool.end();
  process.exitCode = 1;
});
