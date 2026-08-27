// Real PostgreSQL copy-scope verification for CE actions.
// Exercises the production conversationActions service, then verifies rows and
// aggregates directly in PostgreSQL.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { applyConversationAction } from './conversationActions.js';

const cfg = { host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 5432), database: process.env.DB_NAME || 'mailflow_test', user: process.env.DB_USER || 'test', password: process.env.DB_PASSWORD || 'test' };
let pool;
let userId;
let accountA;
let accountB;
const username = `ce-scope-${process.pid}-${Date.now()}`;

async function q(sql, params = []) { return pool.query(sql, params); }
async function setup() {
  userId = (await q(`INSERT INTO users (username,password_hash,is_admin) VALUES ($1,'x',false) RETURNING id`, [username])).rows[0].id;
  accountA = (await q(`INSERT INTO email_accounts (user_id,name,email_address,protocol,enabled) VALUES ($1,'Scope A','${username}.a@example.test','imap',true) RETURNING id`, [userId])).rows[0].id;
  accountB = (await q(`INSERT INTO email_accounts (user_id,name,email_address,protocol,enabled) VALUES ($1,'Scope B','${username}.b@example.test','imap',true) RETURNING id`, [userId])).rows[0].id;
  for (const accountId of [accountA, accountB]) {
    await q(`INSERT INTO folders (account_id,path,name,special_use,no_select) VALUES
      ($1,'INBOX','INBOX','\\\\Inbox',false),
      ($1,'Archive','Archive','\\\\Archive',false),
      ($1,'All Mail','All Mail','\\\\All',false),
      ($1,'Sent','Sent','\\\\Sent',false)`, [accountId]);
  }
}
async function fixture() {
  const conversationId = randomUUID();
  const accountBConversationId = randomUUID();
  await q(`INSERT INTO conversations (id,user_id,account_id,canonical_subject,subject_snapshot,kind,manually_locked) VALUES ($1,$2,$3,'scope fixture','scope fixture','human_reply_chain',false)`, [conversationId,userId,accountA]);
  await q(`INSERT INTO conversations (id,user_id,account_id,canonical_subject,subject_snapshot,kind,manually_locked) VALUES ($1,$2,$3,'scope fixture','scope fixture','human_reply_chain',false)`, [accountBConversationId,userId,accountB]);
  const lm1 = randomUUID(); const lm2 = randomUUID(); const lm3 = randomUUID(); const accountBLm1 = randomUUID();
  await q(`INSERT INTO logical_messages (id,user_id,account_id,conversation_id,canonical_message_id,subject,canonical_subject,direction,message_date) VALUES
    ($1,$2,$3,$4,'<scope-lm1@test>','scope fixture','scope fixture','incoming',NOW()-INTERVAL '3 minutes'),
    ($5,$2,$3,$4,'<scope-lm2@test>','scope fixture','scope fixture','outgoing',NOW()-INTERVAL '2 minutes'),
    ($6,$2,$3,$4,'<scope-lm3@test>','scope fixture','scope fixture','incoming',NOW()-INTERVAL '1 minute'),
    ($7,$2,$8,$9,'<scope-lm1@test>','scope fixture','scope fixture','incoming',NOW()-INTERVAL '3 minutes')`, [lm1,userId,accountA,conversationId,lm2,lm3,accountBLm1,accountB,accountBConversationId]);
  const copies = [];
  const specs = [
    [accountA, 10001, 'INBOX', '<scope-lm1@test>', lm1, conversationId],
    [accountA, 10002, 'All Mail', '<scope-lm1@test>', lm1, conversationId],
    [accountB, 10003, 'Archive', '<scope-lm1@test>', accountBLm1, accountBConversationId],
    [accountA, 10004, 'Sent', '<scope-lm2@test>', lm2, conversationId],
    [accountA, 10005, 'INBOX', '<scope-lm3@test>', lm3, conversationId],
    [accountA, 10006, 'All Mail', '<scope-lm3@test>', lm3, conversationId],
  ];
  for (const [account, uid, folder, messageId, logicalId, copyConversationId] of specs) {
    const id = randomUUID(); copies.push({ id, account, uid, folder, logicalId });
    await q(`INSERT INTO messages (id,account_id,uid,folder,message_id,subject,from_name,from_email,to_addresses,cc_addresses,date,snippet,is_read,is_starred,has_attachments,flags,body_html,body_text,attachments,thread_id,is_bulk,logical_message_id,conversation_id,conversation_user_id,canonical_message_id,threading_reason,threading_confidence,threading_algorithm_version)
      VALUES ($1::uuid,$2::uuid,$3::int,$4::text,$5::text,'scope fixture','Alice','alice@example.test','[]'::jsonb,'[]'::jsonb,NOW(),'scope',false,false,false,'[]'::jsonb,'<p>scope</p>','scope','[]'::jsonb,$5::text,false,$6::uuid,$7::uuid,$8::uuid,$5::text,'rfc-references',1.0::numeric,'v2')`, [id,account,uid,folder,messageId,logicalId,copyConversationId,userId]);
  }
  await q(`UPDATE conversations SET logical_message_count=3,copy_count=5,unread_count=5,last_message_at=NOW() WHERE id=$1`, [conversationId]);
  return { conversationId, accountBConversationId, lm1, lm2, lm3, copies };
}
async function counts(conversationId) {
  return (await q(`SELECT COUNT(*)::int AS copies, COUNT(DISTINCT logical_message_id)::int AS logicals FROM messages WHERE conversation_id=$1 AND NOT is_deleted`, [conversationId])).rows[0];
}

before(async () => { pool = new pg.Pool({ ...cfg, max: 20 }); await q('SELECT 1'); await setup(); });
after(async () => { await q('DELETE FROM users WHERE id=$1', [userId]).catch(() => {}); await pool.end(); });

beforeEach(async () => {
  await q('DELETE FROM conversation_overrides WHERE user_id=$1', [userId]);
  await q('DELETE FROM conversation_aliases WHERE user_id=$1', [userId]);
  await q('DELETE FROM messages WHERE account_id = ANY($1::uuid[])', [[accountA, accountB]]);
  await q('DELETE FROM logical_messages WHERE user_id=$1', [userId]);
  await q('DELETE FROM conversations WHERE user_id=$1', [userId]);
});

describe('CE v2 real copy scopes', () => {
  it('THIS_COPY affects exactly one physical row', async () => {
    const f = await fixture();
    const target = f.copies.find(c => c.folder === 'INBOX' && c.logicalId === f.lm1);
    const result = await applyConversationAction({ userId, conversationId: f.conversationId, scope: 'THIS_COPY', copyId: target.id, action: 'archive' });
    assert.equal(result.affectedCount, 1);
    const rows = await q('SELECT folder FROM messages WHERE id=$1', [target.id]);
    assert.equal(rows.rows[0].folder, 'Archive');
    const untouched = await q('SELECT COUNT(*)::int AS count FROM messages WHERE conversation_id=$1 AND id<>$2 AND folder IN (\'All Mail\',\'Sent\')', [f.conversationId,target.id]);
    assert.equal(untouched.rows[0].count, 3);
  });

  it('ALL_COPIES_OF_LOGICAL_MESSAGE affects only LM1 copies', async () => {
    const f = await fixture();
    const target = f.copies.find(c => c.logicalId === f.lm1);
    const result = await applyConversationAction({ userId, conversationId: f.conversationId, scope: 'ALL_COPIES_OF_LOGICAL_MESSAGE', copyId: target.id, action: 'delete' });
    // Logical-message identity is account-local, so the action affects only
    // the two Account A copies; Account B has a distinct LM with the same
    // canonical Message-ID.
    assert.equal(result.affectedCount, 2);
    const other = await q('SELECT COUNT(*)::int AS count FROM messages WHERE conversation_id=$1 AND logical_message_id<>$2 AND NOT is_deleted', [f.conversationId,f.lm1]);
    assert.equal(other.rows[0].count, 3);
  });

  it('COPIES_ON_THIS_ACCOUNT excludes account B copies', async () => {
    const f = await fixture();
    const target = f.copies.find(c => c.logicalId === f.lm1 && c.account === accountA);
    const result = await applyConversationAction({ userId, conversationId: f.conversationId, scope: 'COPIES_ON_THIS_ACCOUNT', copyId: target.id, action: 'delete' });
    assert.equal(result.affectedCount, 2);
    const accountBRows = await q('SELECT COUNT(*)::int AS count FROM messages WHERE conversation_id=$1 AND account_id=$2 AND NOT is_deleted', [f.conversationId,accountB]);
    assert.equal(accountBRows.rows[0].count, 0);
    const accountBRowsInOwnConversation = await q('SELECT COUNT(*)::int AS count FROM messages WHERE conversation_id=$1 AND account_id=$2 AND NOT is_deleted', [f.accountBConversationId,accountB]);
    assert.equal(accountBRowsInOwnConversation.rows[0].count, 1);
  });

  it('WHOLE_CONVERSATION affects every active copy and leaves stable conversation identity', async () => {
    const f = await fixture();
    const before = await counts(f.conversationId);
    assert.deepEqual(before, { copies: 5, logicals: 3 });
    const result = await applyConversationAction({ userId, conversationId: f.conversationId, scope: 'WHOLE_CONVERSATION', copyId: f.copies[0].id, action: 'delete' });
    assert.equal(result.affectedCount, 5);
    const after = await counts(f.conversationId);
    assert.deepEqual(after, { copies: 0, logicals: 0 });
    const conv = await q('SELECT id FROM conversations WHERE id=$1 AND user_id=$2', [f.conversationId,userId]);
    assert.equal(conv.rows.length, 1);
  });
});
