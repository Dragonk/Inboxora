import pg from 'pg';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';

const { Pool } = pg;
const dbName = process.argv[2] || 'mailflow_ce_perf';
const scale = Number(process.argv[3] || 50000);
if (![50000, 100000].includes(scale)) throw new Error('scale must be 50000 or 100000');
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  database: dbName,
  user: process.env.DB_USER || 'user',
  password: process.env.DB_PASSWORD || 'mailflow_dev',
  max: 10,
  connectionTimeoutMillis: 10000,
});
const q = (sql, params = []) => pool.query(sql, params);
const t = () => performance.now();
const suffix = `${scale}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let userId;
try {
  userId = (await q("INSERT INTO users(username,password_hash,is_admin) VALUES($1,'x',false) RETURNING id", [`perf-${suffix}`])).rows[0].id;
  const accountId = (await q("INSERT INTO email_accounts(user_id,name,email_address,protocol,enabled) VALUES($1,'Perf',$2,'imap',true) RETURNING id", [userId, `perf-${suffix}@example.test`])).rows[0].id;
  const conversations = scale / 5;
  const seedStart = t();
  await q(`INSERT INTO conversations(id,user_id,canonical_subject,subject_snapshot,kind,manually_locked,first_message_at,last_message_at,logical_message_count,copy_count,unread_count)
    SELECT gen_random_uuid(), $1, 'perf-' || g::text, 'perf-' || g::text, 'human_reply_chain', false,
           NOW() - interval '1 day', NOW(), 5, 5, 0
    FROM generate_series(1,$2::int) g`, [userId, conversations]);
  await q(`INSERT INTO logical_messages(id,conversation_id,user_id,canonical_message_id,raw_message_id,subject,canonical_subject,direction,message_date,threading_reason,threading_confidence)
    SELECT gen_random_uuid(), c.id, c.user_id,
           '<perf-' || row_number() over (ORDER BY c.id, g) || '@example.test>',
           '<perf-' || row_number() over (ORDER BY c.id, g) || '@example.test>',
           c.canonical_subject, c.canonical_subject,
           CASE WHEN g=4 THEN 'outgoing' ELSE 'incoming' END,
           NOW() - (g || ' hours')::interval, 'perf-fixture', 1.0
    FROM conversations c CROSS JOIN generate_series(0,4) g
    WHERE c.user_id=$1`, [userId]);
  await q(`INSERT INTO messages(id,account_id,uid,folder,message_id,subject,from_name,from_email,to_addresses,cc_addresses,date,snippet,is_read,is_starred,has_attachments,flags,body_html,body_text,attachments,thread_id,is_bulk,category,logical_message_id,conversation_id,conversation_user_id,canonical_message_id,threading_reason,threading_confidence,threading_algorithm_version)
    SELECT gen_random_uuid(), $2,
           row_number() over (ORDER BY lm.id)::bigint,
           CASE WHEN row_number() over (ORDER BY lm.id) % 3 = 0 THEN 'Sent' WHEN row_number() over (ORDER BY lm.id) % 3 = 1 THEN 'INBOX' ELSE 'Archive' END,
           lm.canonical_message_id, lm.subject, CASE WHEN lm.direction='outgoing' THEN 'Ja' ELSE 'Alice' END,
           CASE WHEN lm.direction='outgoing' THEN 'me@example.test' ELSE 'alice@example.test' END,
           '[]'::jsonb, '[]'::jsonb, lm.message_date, 'perf snippet', false, false, false, '[]'::jsonb,
           '<p>perf body</p>', 'perf body', '[]'::jsonb, NULL, false, NULL,
           lm.id, lm.conversation_id, lm.user_id, lm.canonical_message_id, 'perf-fixture', 1.0, 'v2'
    FROM logical_messages lm WHERE lm.user_id=$1`, [userId, accountId]);
  const seedMs = Number((t() - seedStart).toFixed(1));
  await q('ANALYZE conversations'); await q('ANALYZE logical_messages'); await q('ANALYZE messages');
  const explain = async (name, sql, params=[]) => {
    const started = t();
    const r = await q(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
    const plan = r.rows[0]['QUERY PLAN'][0];
    return { name, wall_ms: Number((t()-started).toFixed(1)), planning_ms: plan['Planning Time'], execution_ms: plan['Execution Time'], plan: plan.Plan };
  };
  const firstLm = (await q('SELECT id FROM logical_messages WHERE user_id=$1 ORDER BY id LIMIT 1', [userId])).rows[0].id;
  const results = [];
  results.push(await explain('conversation_list', `SELECT c.id,c.canonical_subject,COUNT(DISTINCT lm.id),COUNT(m.id),MAX(m.date) FROM conversations c LEFT JOIN logical_messages lm ON lm.conversation_id=c.id LEFT JOIN messages m ON m.conversation_id=c.id WHERE c.user_id=$1 GROUP BY c.id,c.canonical_subject ORDER BY MAX(m.date) DESC LIMIT 50`, [userId]));
  results.push(await explain('folder_list', `SELECT m.folder,COUNT(*) FROM messages m WHERE m.account_id=$1 AND m.is_deleted=false GROUP BY m.folder`, [accountId]));
  results.push(await explain('detail_metadata', `SELECT lm.id,lm.canonical_message_id,m.id AS copy_id,m.folder,m.from_name,m.from_email,m.date,m.snippet,m.is_read,m.has_attachments FROM logical_messages lm LEFT JOIN messages m ON m.logical_message_id=lm.id WHERE lm.user_id=$1 ORDER BY m.date DESC LIMIT 100`, [userId]));
  results.push(await explain('body_lookup', `SELECT m.body_html,m.body_text,m.attachments FROM messages m WHERE m.logical_message_id=$1 ORDER BY m.date DESC LIMIT 1`, [firstLm]));
  results.push(await explain('references_lookup', `SELECT m.id,m.conversation_id,m.logical_message_id FROM messages m WHERE m.account_id=$1 AND (m.message_id=ANY($2::text[]) OR m.in_reply_to=ANY($2::text[]))`, [accountId, ['<perf-1@example.test>']]));
  results.push(await explain('rebuild_batch', `SELECT m.id,m.date FROM messages m JOIN email_accounts a ON a.id=m.account_id AND a.user_id=$1 WHERE m.is_deleted=false AND m.account_id=$2 ORDER BY (m.date IS NULL),m.date,m.id LIMIT 500`, [userId, accountId]));
  console.log(JSON.stringify({ scale, physical_copies: scale, conversations, logical_messages: scale, seed_ms: seedMs, results }, null, 2));
} finally {
  if (userId) await q('DELETE FROM users WHERE id=$1', [userId]).catch(() => {});
  await pool.end();
}
