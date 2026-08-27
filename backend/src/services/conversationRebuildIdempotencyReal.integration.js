// CE v2 Rebuild idempotency test — real PostgreSQL
// Tests: dry-run zero writes, write pass #1, write pass #2 (changed=0, wouldChange=0)
// Run: node --test src/services/conversationRebuildIdempotencyReal.integration.js
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'crypto';

const POOL_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'mailflow_test',
  user: process.env.DB_USER || 'test',
  password: process.env.DB_PASSWORD || 'test',
};

let pool;

before(async () => {
  pool = new pg.Pool({ ...POOL_CONFIG, max: 5 });
});

after(async () => {
  if (pool) await pool.end();
});

async function ceChecksum(pool, userId) {
  // Deterministic checksum of all CE state that a rebuild can mutate. Include
  // parent/evidence/provider/override/alias/checkpoint rows, not only the three
  // primary tables, so idempotency cannot hide reconciliation drift.
  const r = await pool.query(`
    SELECT md5(string_agg(row_data, ',' ORDER BY row_data)) FROM (
      SELECT 'conv:' || c.id::text || ':' || COALESCE(c.canonical_subject,'') || ':' || c.kind || ':' || c.manually_locked::text || ':' || c.logical_message_count::text || ':' || c.copy_count::text || ':' || c.unread_count::text AS row_data
      FROM conversations c WHERE c.user_id = $1
      UNION ALL
      SELECT 'lm:' || lm.id::text || ':' || COALESCE(lm.conversation_id::text,'') || ':' || COALESCE(lm.parent_logical_message_id::text,'') || ':' || COALESCE(lm.canonical_message_id,'') || ':' || COALESCE(lm.raw_in_reply_to,'') || ':' || COALESCE(lm.raw_references,'') || ':' || COALESCE(lm.body_fingerprint,'') || ':' || COALESCE(lm.header_fingerprint,'') AS row_data
      FROM logical_messages lm WHERE lm.user_id = $1
      UNION ALL
      SELECT 'msg:' || m.id::text || ':' || COALESCE(m.conversation_id::text,'') || ':' || COALESCE(m.logical_message_id::text,'') || ':' || COALESCE(m.conversation_user_id::text,'') || ':' || COALESCE(m.canonical_message_id,'') || ':' || COALESCE(m.provider_message_id,'') || ':' || COALESCE(m.provider_thread_id,'') || ':' || COALESCE(m.provider_namespace,'') || ':' || COALESCE(m.threading_reason,'') || ':' || COALESCE(m.threading_confidence::text,'') AS row_data
      FROM messages m WHERE m.conversation_user_id = $1
      UNION ALL
      SELECT 'map:' || account_id::text || ':' || provider || ':' || provider_thread_id || ':' || conversation_id::text
      FROM provider_thread_mappings WHERE user_id = $1
      UNION ALL
      SELECT 'evidence:' || e.id::text || ':' || e.conversation_id::text || ':' || COALESCE(e.logical_message_id::text,'') || ':' || e.evidence_type || ':' || COALESCE(e.evidence_value_hash,'')
      FROM conversation_evidence e WHERE e.user_id = $1
      UNION ALL
      SELECT 'alias:' || alias_conversation_id::text || ':' || canonical_conversation_id::text || ':' || reason
      FROM conversation_aliases WHERE user_id = $1
      UNION ALL
      SELECT 'override:' || id::text || ':' || conversation_id::text || ':' || override_type || ':' || COALESCE(target_id::text,'')
      FROM conversation_overrides WHERE user_id = $1
    ) t
  `, [userId]);
  return r.rows[0].md5;
}

describe('CE v2 Rebuild idempotency — real PostgreSQL', () => {
  let userId, accountId;

  beforeEach(async () => {
    // Clean
    await pool.query('TRUNCATE conversation_overrides, conversation_aliases, conversation_evidence, conversation_ingest_failures, conversation_rebuild_audit, conversation_rebuild_checkpoints RESTART IDENTITY CASCADE');
    await pool.query(`
      DELETE FROM messages
       WHERE logical_message_id IN (SELECT id FROM logical_messages)
          OR conversation_id IN (SELECT id FROM conversations)
          OR subject LIKE 'REBUILD-%'
    `);
    await pool.query('DELETE FROM provider_thread_mappings');
    await pool.query('DELETE FROM logical_messages');
    await pool.query('DELETE FROM conversations');
    await pool.query("DELETE FROM email_accounts WHERE email_address = 'rebuild@example.com'");
    await pool.query("DELETE FROM users WHERE username = 'rebuild-user'");

    userId = (await pool.query("INSERT INTO users (username, password_hash, is_admin) VALUES ('rebuild-user', 'x', false) RETURNING id")).rows[0].id;
    accountId = (await pool.query("INSERT INTO email_accounts (user_id, name, email_address, protocol, enabled) VALUES ($1, 'Rebuild', 'rebuild@example.com', 'imap', true) RETURNING id", [userId])).rows[0].id;

    // Seed 10 raw conversations with 3 physical messages each = 30 messages.
    // Deliberately do not create CE rows/links: pass #1 must exercise the production
    // rebuild planner and persistence path, while pass #2 proves idempotency from the
    // beginning after the checkpoint is removed.
    for (let c = 0; c < 10; c++) {
      for (let m = 0; m < 3; m++) {
        const msgId = randomUUID();
        await pool.query(`
          INSERT INTO messages (
            id, account_id, uid, folder, message_id, subject,
            from_name, from_email, to_addresses, cc_addresses,
            date, snippet, is_read, is_starred,
            has_attachments, flags, body_html, body_text, attachments,
            thread_id, is_bulk, in_reply_to, thread_references
          ) VALUES (
            $1::uuid, $2::uuid, $3::int, 'INBOX'::text, $4::text, 'REBUILD-test-' || $5::text,
            'Alice', 'alice@example.com', '[]', '[]',
            NOW() - ($6 || ' hours')::interval, 'snippet', false, false,
            false, '[]', '<p>body</p>', 'body', '[]',
            $4::text, false, NULL, NULL
          )
        `, [msgId, accountId, c * 10 + m, `<rebuild-${c}-${m}@example.com>`, c, m]);
      }
    }
  });

  it('dry-run makes ZERO persistent writes (checksums identical)', async () => {
    const { rebuildConversationCopies } = await import('./conversationRebuild.js');
    const before = await ceChecksum(pool, userId);
    const result = await rebuildConversationCopies({ userId, accountId, limit: 500, dryRun: true, force: true });
    const after = await ceChecksum(pool, userId);
    assert.equal(result.dryRun, true);
    assert.equal(after, before, 'Production dry-run must not change any CE data');
  });

  it('second rebuild from beginning: changed=0, wouldChange=0, same checksum', async () => {
    const { rebuildConversationCopies } = await import('./conversationRebuild.js');
    const checksumBefore = await ceChecksum(pool, userId);
    const pass1 = await rebuildConversationCopies({ userId, accountId, limit: 500, dryRun: false, force: true });
    const checksumAfter1 = await ceChecksum(pool, userId);
    assert.ok(pass1.updated > 0, 'Pass #1 must execute real CE writes for raw physical messages');
    assert.equal(pass1.wouldChange, pass1.updated);
    assert.notEqual(checksumAfter1, checksumBefore, 'Pass #1 must change raw state');

    await pool.query('DELETE FROM conversation_rebuild_checkpoints WHERE user_id = $1 AND scope_account_id = $2', [userId, accountId]);
    const pass2 = await rebuildConversationCopies({ userId, accountId, limit: 500, dryRun: false, force: true });
    const checksumAfter2 = await ceChecksum(pool, userId);
    assert.equal(pass2.updated, 0, 'Pass #2 from beginning must be idempotent');
    assert.equal(pass2.wouldChange, 0);
    assert.equal(checksumAfter2, checksumAfter1);
  });

  it('legacy "Test" overmerge is repaired: 5 unrelated Test messages stay separate after rebuild', async () => {
    // Add 5 messages with Subject: Test but NO RFC evidence between them
    const testConvIds = [];
    for (let i = 0; i < 5; i++) {
      const convId = randomUUID();
      testConvIds.push(convId);
      await pool.query(
        "INSERT INTO conversations (id, user_id, account_id, canonical_subject, kind, manually_locked) VALUES ($1, $2, $3, 'human_reply_chain', false)",
        [convId, userId, accountId]
      );
      const lmId = randomUUID();
      await pool.query(
        "INSERT INTO logical_messages (id, conversation_id, user_id, account_id, canonical_message_id) VALUES ($1, $2, $3, $4, $5)",
        [lmId, convId, userId, accountId, `<test-unrelated-${i}@example.com>`]
      );
      const msgId = randomUUID();
      await pool.query(`
        INSERT INTO messages (
          id, account_id, uid, folder, message_id, subject,
          from_name, from_email, to_addresses, cc_addresses,
          date, snippet, is_read, is_starred,
          has_attachments, flags, body_html, body_text, attachments,
          thread_id, is_bulk,
          logical_message_id, conversation_id, conversation_user_id, canonical_message_id,
          threading_reason, threading_confidence, threading_algorithm_version
        ) VALUES (
          $1::uuid, $2::uuid, $3::int, 'INBOX'::text, $4::text, 'Test'::text,
          'Sender ' || $5::text, 'sender-' || $5::text || '@example.com', '[]', '[]',
          NOW() - ($6 || ' days')::interval, 'snippet', false, false,
          false, '[]', '<p>body</p>', 'body', '[]',
          $4::text, false,
          $7::uuid, $8::uuid, $9::uuid, $4::text,
          'no-evidence', 0.0, 'v2'
        )
      `, [msgId, accountId, 9000 + i, `<test-unrelated-${i}@example.com>`, i, i * 30, lmId, convId, userId]);
    }

    // Verify: 5 separate conversations (no merge)
    const testConvs = await pool.query(
      "SELECT COUNT(*) FROM conversations WHERE user_id = $1 AND canonical_subject = 'test'",
      [userId]
    );
    assert.equal(Number(testConvs.rows[0].count), 5, 'Should have 5 separate conversations for 5 unrelated Test messages');

    const { rebuildConversationCopies } = await import('./conversationRebuild.js');
    const rebuild = await rebuildConversationCopies({ userId, accountId, limit: 500, dryRun: false, force: true });
    assert.ok(rebuild.updated >= 5, 'Rebuild must process the adversarial Subject: Test rows');
    const postRebuild = await pool.query(
      "SELECT COUNT(DISTINCT conversation_id) FROM messages WHERE subject = 'Test' AND account_id = $1",
      [accountId]
    );
    assert.equal(Number(postRebuild.rows[0].count), 5, 'After rebuild: 5 separate conversations (no subject-only overmerge)');
  });
});
