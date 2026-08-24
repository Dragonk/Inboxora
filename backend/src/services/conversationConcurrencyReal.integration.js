// Real PostgreSQL concurrency suite for Conversation Engine v2.
// No mocked promises: each production operation uses its own pool transaction/client.
// Run with the migrated test database:
//   DB_HOST=... DB_NAME=... DB_USER=... DB_PASSWORD=... node --test src/services/conversationConcurrencyReal.integration.js
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { applyConversationOverride } from './conversationOverrides.js';
import { upsertConversationCopy } from './conversationPersistence.js';

const cfg = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'mailflow_test',
  user: process.env.DB_USER || 'test',
  password: process.env.DB_PASSWORD || 'test',
};

let pool;
let userId;
let accountId;
const username = `ce-concurrency-${process.pid}-${Date.now()}`;

async function q(sql, params = []) { return pool.query(sql, params); }

async function createConversation(subject) {
  const id = randomUUID();
  await q(`INSERT INTO conversations (id, user_id, canonical_subject, subject_snapshot, kind, manually_locked)
           VALUES ($1, $2, $3, $3, 'human_reply_chain', false)`, [id, userId, subject]);
  return id;
}

async function createMessage({ messageId, subject, folder = 'INBOX', uid, from = 'alice@example.test', to = 'me@example.test', providerThreadId = null, provider = null }) {
  const id = randomUUID();
  await q(`INSERT INTO messages (
      id, account_id, uid, folder, message_id, subject, from_name, from_email,
      to_addresses, cc_addresses, date, snippet, is_read, is_starred,
      has_attachments, flags, body_html, body_text, attachments,
      thread_id, is_bulk, provider_message_id, provider_thread_id, provider_namespace
    ) VALUES ($1::uuid,$2::uuid,$3::int,$4::text,$5::text,$6::text,'Sender',$7::text,$8::jsonb,'[]'::jsonb,NOW(),$6::text,false,false,
              false,'[]'::jsonb,'<p>body</p>','body','[]'::jsonb,$5::text,false,$5::text,$9::text,$10::text)`,
    [id, accountId, uid, folder, messageId, subject, from,
      JSON.stringify([{ email: to }]), providerThreadId, provider]);
  return id;
}

async function assertNoCrossEdges() {
  const r = await q(`SELECT child.id FROM logical_messages child
    JOIN logical_messages parent ON parent.id = child.parent_logical_message_id
    WHERE child.user_id = $1 AND child.conversation_id IS DISTINCT FROM parent.conversation_id
    LIMIT 1`, [userId]);
  assert.equal(r.rows.length, 0, 'no cross-conversation parent edges may remain');
}

before(async () => {
  pool = new pg.Pool({ ...cfg, max: 40 });
  await pool.query('SELECT 1');
  userId = (await q(`INSERT INTO users (username, password_hash, is_admin) VALUES ($1,'x',false) RETURNING id`, [username])).rows[0].id;
  accountId = (await q(`INSERT INTO email_accounts (user_id, name, email_address, protocol, enabled)
    VALUES ($1,'Concurrency test','${username}@example.test','imap',true) RETURNING id`, [userId])).rows[0].id;
});

after(async () => {
  await q('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
  await pool.end();
});

beforeEach(async () => {
  await q('DELETE FROM conversation_overrides WHERE user_id = $1', [userId]);
  await q('DELETE FROM conversation_aliases WHERE user_id = $1', [userId]);
  await q('DELETE FROM provider_thread_mappings WHERE user_id = $1', [userId]);
  await q('DELETE FROM messages WHERE account_id = $1', [accountId]);
  await q('DELETE FROM logical_messages WHERE user_id = $1', [userId]);
  await q('DELETE FROM conversations WHERE user_id = $1', [userId]);
});

describe('Conversation Engine v2 — real PostgreSQL concurrency', () => {
  it('25 concurrent merge A→B / B→A runs deterministically without cycles or cross-edges', async () => {
    const a = await createConversation('merge-a');
    const b = await createConversation('merge-b');
    const aMessage = await createMessage({ messageId: `<merge-a-${randomUUID()}@test>`, subject: 'merge-a', uid: 100 });
    const bMessage = await createMessage({ messageId: `<merge-b-${randomUUID()}@test>`, subject: 'merge-b', uid: 101 });
    const aLm = randomUUID();
    const bLm = randomUUID();
    await q('INSERT INTO logical_messages (id,user_id,conversation_id,canonical_message_id) VALUES ($1,$2,$3,$4),($5,$2,$6,$7)', [aLm,userId,a,'<merge-a-lm@test>',bLm,b,'<merge-b-lm@test>']);
    await q('UPDATE messages SET logical_message_id=$1,conversation_id=$2,conversation_user_id=$3 WHERE id=$4', [aLm,a,userId,aMessage]);
    await q('UPDATE messages SET logical_message_id=$1,conversation_id=$2,conversation_user_id=$3 WHERE id=$4', [bLm,b,userId,bMessage]);

    const outcomes = await Promise.all(Array.from({ length: 25 }, (_, i) =>
      applyConversationOverride({
        userId,
        conversationId: i % 2 ? a : b,
        overrideType: 'manual-merge',
        targetId: i % 2 ? b : a,
        reason: `race-${i}`,
      }).then(value => ({ ok: true, value })).catch(error => ({ ok: false, error })),
    ));
    const successes = outcomes.filter(x => x.ok);
    const failures = outcomes.filter(x => !x.ok);
    assert.ok(successes.length >= 1, 'one merge must win');
    assert.ok(failures.length >= 1, 'opposite-direction races must reject or serialize');
    assert.ok(failures.every(x => /cycle|alias|serialization|deadlock|different target/i.test(x.error.message)), `unexpected race errors: ${failures.map(x => x.error.message).join('; ')}`);
    const aliases = await q('SELECT alias_conversation_id, canonical_conversation_id FROM conversation_aliases WHERE user_id=$1', [userId]);
    assert.ok(aliases.rows.length >= 1);
    assert.ok(aliases.rows.every(row => row.alias_conversation_id !== row.canonical_conversation_id));
    await assertNoCrossEdges();
    const bad = await q(`SELECT 1 FROM messages WHERE conversation_user_id=$1 AND conversation_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id=messages.conversation_id AND c.user_id=$1)`, [userId]);
    assert.equal(bad.rows.length, 0);
  });

  it('25 concurrent upserts of the same physical message produce one LogicalMessage', async () => {
    const messageId = await createMessage({ messageId: `<collision-${randomUUID()}@test>`, subject: 'same-message', uid: 200 });
    const results = await Promise.all(Array.from({ length: 25 }, () =>
      upsertConversationCopy({ id: messageId }, { userId }).catch(error => ({ error: error.message })),
    ));
    const sameRowErrors = results.filter(result => result?.error);
    assert.ok(sameRowErrors.every(result => /serialize|deadlock/i.test(result.error)), `unexpected same-row errors: ${JSON.stringify(sameRowErrors)}`);
    const logicals = await q('SELECT id, conversation_id FROM logical_messages WHERE user_id=$1', [userId]);
    assert.equal(logicals.rows.length, 1, 'same collision key must converge to one LogicalMessage');
    const attached = await q('SELECT logical_message_id, conversation_id FROM messages WHERE id=$1', [messageId]);
    assert.equal(attached.rows[0].logical_message_id, logicals.rows[0].id);
    assert.equal(attached.rows[0].conversation_id, logicals.rows[0].conversation_id);
  });

  it('25 concurrent strong provider-thread ingests converge to one Conversation', async () => {
    const providerThreadId = `gmail-thread-${randomUUID()}`;
    const ids = [];
    for (let i = 0; i < 25; i++) ids.push(await createMessage({
      messageId: `<provider-${i}-${randomUUID()}@test>`,
      subject: `provider-${i}`,
      uid: 300 + i,
      providerThreadId,
      provider: 'gmail',
    }));
    const results = await Promise.all(ids.map(id => upsertConversationCopy({ id }, {
      userId,
      provider: { provider: 'gmail', isStrong: true, source: 'x-gm-thread', providerThreadId, providerMessageId: null, namespace: `account:${accountId}` },
    }).catch(error => ({ error: error.message }))));
    const providerErrors = results.filter(result => result?.error);
    assert.ok(providerErrors.every(result => /serialize|deadlock/i.test(result.error)), `unexpected provider errors: ${JSON.stringify(providerErrors)}`);
    const convs = await q(`SELECT COUNT(DISTINCT conversation_id)::int AS count FROM messages WHERE id=ANY($1::uuid[])`, [ids]);
    assert.equal(convs.rows[0].count, 1, 'one strong provider thread must map to one Conversation');
    const mapping = await q(`SELECT COUNT(*)::int AS count FROM provider_thread_mappings WHERE user_id=$1 AND provider_thread_id=$2`, [userId, providerThreadId]);
    assert.equal(mapping.rows[0].count, 1, 'provider mapping must be unique');
    await assertNoCrossEdges();
  });
});
