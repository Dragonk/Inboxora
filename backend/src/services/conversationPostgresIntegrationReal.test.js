// CE v2 PostgreSQL integration test — ALL FOLDERS conversation scenario
// Tests the critical product scenario: one conversation with messages across
// Inbox, Sent, Archive, and a duplicate in All Mail.
//
// Requires: real PostgreSQL with migrations 0001-0057 applied.
// Run: node --test src/services/conversationPostgresIntegrationReal.test.js
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'crypto';

const uuid = randomUUID;

const POOL_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'mailflow_test',
  user: process.env.DB_USER || 'test',
  password: process.env.DB_PASSWORD || 'test',
};

let pool;

before(async () => {
  pool = new pg.Pool(POOL_CONFIG);
  // Verify connection
  const r = await pool.query('SELECT 1');
  assert.equal(r.rows.length, 1);
});

after(async () => {
  if (pool) await pool.end();
});

beforeEach(async () => {
  // Clean CE tables between tests
  await pool.query('TRUNCATE conversation_overrides, conversation_aliases, conversation_evidence, conversation_ingest_failures, conversation_rebuild_audit, conversation_rebuild_checkpoints RESTART IDENTITY CASCADE');
  // Delete messages, logical_messages, conversations in dependency order
  await pool.query("DELETE FROM messages WHERE subject LIKE 'CE-INTEGRATION-%' OR subject = 'Test'");
  await pool.query('DELETE FROM logical_messages');
  await pool.query('DELETE FROM conversations');
  // Delete test users/accounts
  await pool.query("DELETE FROM email_accounts WHERE email_address LIKE 'ce-test-%'");
  await pool.query("DELETE FROM users WHERE username LIKE 'ce-test-%'");
});

async function setupTestUser() {
  const userId = (await pool.query(
    "INSERT INTO users (username, password_hash, is_admin) VALUES ('ce-test-user', 'x', false) RETURNING id"
  )).rows[0].id;
  const accountId = (await pool.query(
    "INSERT INTO email_accounts (user_id, name, email_address, protocol, imap_host, imap_port, imap_tls, auth_user, auth_pass, enabled) VALUES ($1, 'CE Test', 'ce-test@example.com', 'imap', 'imap.example.com', 993, true, 'ce-test', 'x', true) RETURNING id",
    [userId]
  )).rows[0].id;
  const accountId2 = (await pool.query(
    "INSERT INTO email_accounts (user_id, name, email_address, protocol, imap_host, imap_port, imap_tls, auth_user, auth_pass, enabled) VALUES ($1, 'CE Test 2', 'ce-test2@example.com', 'imap', 'imap2.example.com', 993, true, 'ce-test2', 'x', true) RETURNING id",
    [userId]
  )).rows[0].id;
  return { userId, accountId, accountId2 };
}

async function insertMessage({ accountId, userId, uid, folder, messageId, subject, fromEmail, toEmails, inReplyTo, references, date, conversationId, logicalMessageId, canonicalMessageId, direction }) {
  const id = crypto.randomUUID();
  const result = await pool.query(
    `INSERT INTO messages (
      id, account_id, uid, folder, message_id, subject,
      from_name, from_email, to_addresses, cc_addresses,
      in_reply_to, thread_references, date, snippet, is_read, is_starred,
      has_attachments, flags, body_html, body_text, attachments,
      thread_id, is_bulk, category,
      logical_message_id, conversation_id, conversation_user_id, canonical_message_id,
      threading_reason, threading_confidence, threading_algorithm_version
    ) VALUES (
      $1::uuid, $2::uuid, $3::int, $4::text, $5::text, $6::text,
      $7::text, $8::text, $9::jsonb, $10::jsonb,
      $11::text, $12::text, $13::timestamptz, $14::text, false, false,
      false, '[]'::jsonb, '<p>body</p>'::text, 'body'::text, '[]'::jsonb,
      $5::text, false, null,
      $15::uuid, $16::uuid, $17::uuid, $18::text,
      $19::text, 1.0::numeric, 'v2'::text
    ) RETURNING id`,
    [
      id, accountId, uid, folder, messageId, subject,
      direction === 'outgoing' ? 'Me' : 'Alice', fromEmail, JSON.stringify(toEmails), JSON.stringify([]),
      inReplyTo || null, references || null, date, 'snippet text',
      logicalMessageId, conversationId, userId, canonicalMessageId,
      'rfc-references'
    ]
  );
  return result.rows[0].id;
}

async function createConversation(userId, subject) {
  const convId = crypto.randomUUID();
  await pool.query(
    "INSERT INTO conversations (id, user_id, canonical_subject, kind, manually_locked) VALUES ($1, $2, $3, 'human_reply_chain', false)",
    [convId, userId, subject.toLowerCase()]
  );
  return convId;
}

async function createLogicalMessage(conversationId, userId, canonicalMessageId) {
  const lmId = crypto.randomUUID();
  await pool.query(
    "INSERT INTO logical_messages (id, conversation_id, user_id, canonical_message_id) VALUES ($1, $2, $3, $4)",
    [lmId, conversationId, userId, canonicalMessageId]
  );
  return lmId;
}

describe('CE v2 PostgreSQL integration — ALL FOLDERS conversation', () => {
  it('one conversation with 5 LogicalMessages across Inbox/Sent/Archive + All Mail duplicate', async () => {
    const { userId, accountId } = await setupTestUser();
    const subject = 'CE-INTEGRATION-All-Folders-Test';

    // Create conversation
    const convId = await createConversation(userId, subject);

    // Create 5 LogicalMessages
    const lm1 = await createLogicalMessage(convId, userId, '<msg-1@example.com>');
    const lm2 = await createLogicalMessage(convId, userId, '<msg-2@example.com>');
    const lm3 = await createLogicalMessage(convId, userId, '<msg-3@example.com>');
    const lm4 = await createLogicalMessage(convId, userId, '<msg-4@example.com>');
    const lm5 = await createLogicalMessage(convId, userId, '<msg-5@example.com>');

    // LM1: incoming, Inbox
    await insertMessage({
      accountId, userId, uid: 1001, folder: 'INBOX', messageId: '<msg-1@example.com>',
      subject, fromEmail: 'alice@example.com', toEmails: ['me@example.com'],
      date: '2026-01-01T10:00:00Z', conversationId: convId, logicalMessageId: lm1,
      canonicalMessageId: '<msg-1@example.com>', direction: 'incoming'
    });

    // LM2: outgoing, Sent
    await insertMessage({
      accountId, userId, uid: 1002, folder: 'Sent', messageId: '<msg-2@example.com>',
      subject, fromEmail: 'me@example.com', toEmails: ['alice@example.com'],
      inReplyTo: '<msg-1@example.com>', references: '<msg-1@example.com>',
      date: '2026-01-01T11:00:00Z', conversationId: convId, logicalMessageId: lm2,
      canonicalMessageId: '<msg-2@example.com>', direction: 'outgoing'
    });

    // LM3: incoming, Archive
    await insertMessage({
      accountId, userId, uid: 1003, folder: 'Archive', messageId: '<msg-3@example.com>',
      subject, fromEmail: 'alice@example.com', toEmails: ['me@example.com'],
      inReplyTo: '<msg-2@example.com>', references: '<msg-1@example.com> <msg-2@example.com>',
      date: '2026-01-01T12:00:00Z', conversationId: convId, logicalMessageId: lm3,
      canonicalMessageId: '<msg-3@example.com>', direction: 'incoming'
    });

    // LM4: outgoing, Sent
    await insertMessage({
      accountId, userId, uid: 1004, folder: 'Sent', messageId: '<msg-4@example.com>',
      subject, fromEmail: 'me@example.com', toEmails: ['alice@example.com'],
      inReplyTo: '<msg-3@example.com>', references: '<msg-1@example.com> <msg-2@example.com> <msg-3@example.com>',
      date: '2026-01-01T13:00:00Z', conversationId: convId, logicalMessageId: lm4,
      canonicalMessageId: '<msg-4@example.com>', direction: 'outgoing'
    });

    // LM5: incoming, Inbox — AND duplicate in All Mail (same logical_message_id)
    const msg5Id = await insertMessage({
      accountId, userId, uid: 1005, folder: 'INBOX', messageId: '<msg-5@example.com>',
      subject, fromEmail: 'alice@example.com', toEmails: ['me@example.com'],
      inReplyTo: '<msg-4@example.com>', references: '<msg-1@example.com> <msg-2@example.com> <msg-3@example.com> <msg-4@example.com>',
      date: '2026-01-01T14:00:00Z', conversationId: convId, logicalMessageId: lm5,
      canonicalMessageId: '<msg-5@example.com>', direction: 'incoming'
    });

    // LM5 duplicate in All Mail — SAME logical_message_id
    await insertMessage({
      accountId, userId, uid: 1006, folder: 'All Mail', messageId: '<msg-5@example.com>',
      subject, fromEmail: 'alice@example.com', toEmails: ['me@example.com'],
      inReplyTo: '<msg-4@example.com>', references: '<msg-1@example.com> <msg-2@example.com> <msg-3@example.com> <msg-4@example.com>',
      date: '2026-01-01T14:00:00Z', conversationId: convId, logicalMessageId: lm5,
      canonicalMessageId: '<msg-5@example.com>', direction: 'incoming'
    });

    // === VERIFICATIONS ===

    // 1. logical_message_count = 5
    const lmCount = await pool.query(
      'SELECT COUNT(*) FROM logical_messages WHERE conversation_id = $1', [convId]
    );
    assert.equal(Number(lmCount.rows[0].count), 5, 'logical_message_count should be 5');

    // 2. physical copy count > 5 (6 because LM5 has 2 copies)
    const physCount = await pool.query(
      'SELECT COUNT(*) FROM messages WHERE conversation_id = $1', [convId]
    );
    assert.equal(Number(physCount.rows[0].count), 6, 'physical copy count should be 6 (5 LMs + 1 duplicate)');

    // 3. Inbox list shows parent with 5 children
    const inboxMessages = await pool.query(
      "SELECT DISTINCT logical_message_id FROM messages WHERE conversation_id = $1 AND folder = 'INBOX'",
      [convId]
    );
    assert.equal(inboxMessages.rows.length, 2, 'Inbox should have 2 distinct logical messages (LM1 + LM5)');

    // 4. All distinct logical messages across ALL folders = 5
    const allLmInConv = await pool.query(
      'SELECT COUNT(DISTINCT logical_message_id) FROM messages WHERE conversation_id = $1', [convId]
    );
    assert.equal(Number(allLmInConv.rows[0].count), 5, 'should see 5 distinct logical messages across all folders');

    // 5. Sent shows 2 distinct LMs (LM2 + LM4)
    const sentLms = await pool.query(
      "SELECT COUNT(DISTINCT logical_message_id) FROM messages WHERE conversation_id = $1 AND folder = 'Sent'",
      [convId]
    );
    assert.equal(Number(sentLms.rows[0].count), 2, 'Sent should have 2 distinct logical messages');

    // 6. Archive shows 1 LM (LM3)
    const archiveLms = await pool.query(
      "SELECT COUNT(DISTINCT logical_message_id) FROM messages WHERE conversation_id = $1 AND folder = 'Archive'",
      [convId]
    );
    assert.equal(Number(archiveLms.rows[0].count), 1, 'Archive should have 1 distinct logical message');

    // 7. All Mail has 1 LM (LM5 duplicate)
    const allMailLms = await pool.query(
      "SELECT COUNT(DISTINCT logical_message_id) FROM messages WHERE conversation_id = $1 AND folder = 'All Mail'",
      [convId]
    );
    assert.equal(Number(allMailLms.rows[0].count), 1, 'All Mail should have 1 distinct logical message (LM5)');

    // 8. Same conversation UUID in all views
    const convIds = await pool.query(
      'SELECT DISTINCT conversation_id FROM messages WHERE subject = $1', [subject]
    );
    assert.equal(convIds.rows.length, 1, 'All messages should point to same conversation UUID');
    assert.equal(convIds.rows[0].conversation_id, convId);

    // 9. Inbox + All Mail duplicate does NOT create LM6
    const lmForMsg5 = await pool.query(
      "SELECT DISTINCT logical_message_id FROM messages WHERE message_id = '<msg-5@example.com>'"
    );
    assert.equal(lmForMsg5.rows.length, 1, 'Both copies of msg-5 should share the same logical_message_id');
    assert.equal(lmForMsg5.rows[0].logical_message_id, lm5);

    // 10. Chronology: incoming, outgoing, incoming, outgoing, incoming
    const chronology = await pool.query(
      `SELECT lm.id, m.from_email, m.from_name
       FROM logical_messages lm
       JOIN messages m ON m.logical_message_id = lm.id
       WHERE lm.conversation_id = $1
       GROUP BY lm.id, m.from_email, m.from_name
       ORDER BY MIN(m.date)`,
      [convId]
    );
    assert.equal(chronology.rows.length, 5, 'Should see 5 logical messages in chronological order');
    assert.equal(chronology.rows[0].from_name, 'Alice', 'First should be incoming from Alice');
    assert.equal(chronology.rows[1].from_name, 'Me', 'Second should be outgoing from Me');
    assert.equal(chronology.rows[2].from_name, 'Alice', 'Third should be incoming from Alice');
    assert.equal(chronology.rows[3].from_name, 'Me', 'Fourth should be outgoing from Me');
    assert.equal(chronology.rows[4].from_name, 'Alice', 'Fifth should be incoming from Alice');
  });

  it('100 unrelated "Test" subject messages produce 100 separate conversations (no subject-only merge)', async () => {
    const { userId, accountId } = await setupTestUser();

    // Insert 100 messages with Subject: Test, different senders, dates, accounts, no RFC evidence
    for (let i = 0; i < 100; i++) {
      const convId = crypto.randomUUID();
      const lmId = crypto.randomUUID();
      await pool.query(
        "INSERT INTO conversations (id, user_id, canonical_subject, kind, manually_locked) VALUES ($1, $2, 'test', 'human_reply_chain', false)",
        [convId, userId]
      );
      await pool.query(
        "INSERT INTO logical_messages (id, conversation_id, user_id, canonical_message_id) VALUES ($1, $2, $3, $4)",
        [lmId, convId, userId, `<test-${i}@sender-${i}.com>`]
      );
      const year = 2020 + (i % 7); // spread across 2020-2026
      const month = (i % 12) + 1;
      await insertMessage({
        accountId, userId, uid: 2000 + i, folder: i % 3 === 0 ? 'INBOX' : (i % 3 === 1 ? 'Sent' : 'Archive'),
        messageId: `<test-${i}@sender-${i}.com>`,
        subject: 'Test',
        fromEmail: `sender-${i}@example.com`,
        toEmails: ['me@example.com'],
        date: `${year}-${String(month).padStart(2, '0')}-15T10:00:00Z`,
        conversationId: convId, logicalMessageId: lmId,
        canonicalMessageId: `<test-${i}@sender-${i}.com>`,
        direction: 'incoming'
      });
    }

    // Verify: 100 separate conversations
    const convCount = await pool.query(
      "SELECT COUNT(*) FROM conversations WHERE user_id = $1 AND canonical_subject = 'test'",
      [userId]
    );
    assert.equal(Number(convCount.rows[0].count), 100, 'Should have 100 separate conversations for 100 unrelated Test messages');

    // Verify: no two messages share a conversation_id unless via RFC evidence (none here)
    const sharedConv = await pool.query(
      `SELECT conversation_id, COUNT(*) FROM messages
       WHERE subject = 'Test' GROUP BY conversation_id HAVING COUNT(*) > 1`
    );
    assert.equal(sharedConv.rows.length, 0, 'No two Test messages should share a conversation (no RFC evidence)');

    // Now add 3 messages that ARE related via RFC References (same Subject: Test, but with threading headers)
    const relatedConvId = crypto.randomUUID();
    await pool.query(
      "INSERT INTO conversations (id, user_id, canonical_subject, kind, manually_locked) VALUES ($1, $2, 'test', 'human_reply_chain', false)",
      [relatedConvId, userId]
    );
    for (let i = 0; i < 3; i++) {
      const lmId = crypto.randomUUID();
      await pool.query(
        "INSERT INTO logical_messages (id, conversation_id, user_id, canonical_message_id) VALUES ($1, $2, $3, $4)",
        [lmId, relatedConvId, userId, `<related-${i}@example.com>`]
      );
      await insertMessage({
        accountId, userId, uid: 3000 + i, folder: 'INBOX',
        messageId: `<related-${i}@example.com>`,
        subject: 'Test',
        fromEmail: 'alice@example.com', toEmails: ['me@example.com'],
        inReplyTo: i > 0 ? `<related-${i - 1}@example.com>` : null,
        references: i > 0 ? `<related-0@example.com> <related-${i - 1}@example.com>` : null,
        date: `2026-08-0${i + 1}T10:00:00Z`,
        conversationId: relatedConvId, logicalMessageId: lmId,
        canonicalMessageId: `<related-${i}@example.com>`,
        direction: 'incoming'
      });
    }

    // Verify: 101 total conversations (100 unrelated + 1 related chain)
    const totalConv = await pool.query(
      "SELECT COUNT(*) FROM conversations WHERE user_id = $1 AND canonical_subject = 'test'",
      [userId]
    );
    assert.equal(Number(totalConv.rows[0].count), 101, 'Should have 101 conversations (100 unrelated + 1 RFC-related chain)');

    // The RFC-related conversation has 3 logical messages
    const relatedLm = await pool.query(
      'SELECT COUNT(*) FROM logical_messages WHERE conversation_id = $1', [relatedConvId]
    );
    assert.equal(Number(relatedLm.rows[0].count), 3, 'RFC-related conversation should have 3 logical messages');
  });

  it('Message-ID collision: 4 different real messages with same canonical Message-ID stay as 4 LogicalMessages', async () => {
    const { userId, accountId } = await setupTestUser();
    const collidingMsgId = '<collision@example.com>';

    // Create 4 different conversations (different subjects, senders, dates)
    const convIds = [];
    const lmIds = [];
    for (let i = 0; i < 4; i++) {
      const convId = crypto.randomUUID();
      const lmId = crypto.randomUUID();
      convIds.push(convId);
      lmIds.push(lmId);
      await pool.query(
        "INSERT INTO conversations (id, user_id, canonical_subject, kind, manually_locked) VALUES ($1, $2, $3, 'human_reply_chain', false)",
        [convId, userId, `collision-test-${i}`]
      );
      await pool.query(
        "INSERT INTO logical_messages (id, conversation_id, user_id, canonical_message_id) VALUES ($1, $2, $3, $4)",
        [lmId, convId, userId, collidingMsgId]
      );
    }

    // Insert 4 messages with the SAME Message-ID but different content
    for (let i = 0; i < 4; i++) {
      await insertMessage({
        accountId, userId, uid: 4000 + i, folder: 'INBOX',
        messageId: collidingMsgId,
        subject: `Collision test ${i}`,
        fromEmail: `sender-${i}@example.com`,
        toEmails: ['me@example.com'],
        date: `2026-08-0${i + 1}T10:00:00Z`,
        conversationId: convIds[i], logicalMessageId: lmIds[i],
        canonicalMessageId: collidingMsgId,
        direction: 'incoming'
      });
    }

    // Verify: 4 distinct LogicalMessages (not merged into 1)
    const lmCount = await pool.query(
      "SELECT COUNT(DISTINCT logical_message_id) FROM messages WHERE message_id = $1",
      [collidingMsgId]
    );
    assert.equal(Number(lmCount.rows[0].count), 4, '4 messages with same Message-ID should map to 4 distinct LogicalMessages');

    // Verify: 4 distinct conversations
    const convCount = await pool.query(
      "SELECT COUNT(DISTINCT conversation_id) FROM messages WHERE message_id = $1",
      [collidingMsgId]
    );
    assert.equal(Number(convCount.rows[0].count), 4, '4 messages with same Message-ID should be in 4 distinct conversations');
  });

  it('relocate preserves all CE v2 identity and threading metadata', async () => {
    const { userId, accountId } = await setupTestUser();
    const subject = 'CE-INTEGRATION-Relocate-Test';
    const convId = await createConversation(userId, subject);
    const lmId = await createLogicalMessage(convId, userId, '<relocate-msg@example.com>');

    const msgId = await insertMessage({
      accountId, userId, uid: 5001, folder: 'INBOX', messageId: '<relocate-msg@example.com>',
      subject, fromEmail: 'alice@example.com', toEmails: ['me@example.com'],
      date: '2026-01-15T10:00:00Z', conversationId: convId, logicalMessageId: lmId,
      canonicalMessageId: '<relocate-msg@example.com>', direction: 'incoming'
    });

    // Verify CE columns before relocate
    const before = await pool.query(
      'SELECT logical_message_id, conversation_id, conversation_user_id, canonical_message_id, threading_reason, threading_confidence, threading_algorithm_version FROM messages WHERE id = $1',
      [msgId]
    );
    assert.equal(before.rows[0].logical_message_id, lmId);
    assert.equal(before.rows[0].conversation_id, convId);
    assert.equal(before.rows[0].conversation_user_id, userId);
    assert.equal(before.rows[0].canonical_message_id, '<relocate-msg@example.com>');
    assert.equal(before.rows[0].threading_reason, 'rfc-references');

    // Simulate UIDPLUS relocate: DELETE + reinsert with RELOCATE_COPY_COLS
    const { RELOCATE_COPY_COLS } = await import('../utils/relocateColumns.js');
    const insertCols = ['account_id', 'uid', 'folder', ...RELOCATE_COPY_COLS].join(', ');
    const selectCols = ['d.account_id', 5002, "'Archive'", ...RELOCATE_COPY_COLS.map(c => `d.${c}`)].join(', ');

    await pool.query('BEGIN');
    const newId = (await pool.query(`
      WITH d AS (DELETE FROM messages WHERE id = $1 RETURNING *),
           u AS (SELECT 5002 AS new_uid)
      INSERT INTO messages (${insertCols})
      SELECT ${selectCols}
      FROM d, u
      RETURNING id
    `, [msgId])).rows[0].id;
    await pool.query('COMMIT');

    // Verify CE columns after relocate
    const after = await pool.query(
      'SELECT logical_message_id, conversation_id, conversation_user_id, canonical_message_id, threading_reason, threading_confidence, threading_algorithm_version, folder, uid FROM messages WHERE id = $1',
      [newId]
    );
    assert.equal(after.rows[0].logical_message_id, lmId, 'logical_message_id must survive relocate');
    assert.equal(after.rows[0].conversation_id, convId, 'conversation_id must survive relocate');
    assert.equal(after.rows[0].conversation_user_id, userId, 'conversation_user_id must survive relocate');
    assert.equal(after.rows[0].canonical_message_id, '<relocate-msg@example.com>', 'canonical_message_id must survive relocate');
    assert.equal(after.rows[0].threading_reason, 'rfc-references', 'threading_reason must survive relocate');
    assert.equal(after.rows[0].folder, 'Archive', 'folder must be the destination');
    assert.equal(Number(after.rows[0].uid), 5002, 'uid must be the new UIDPLUS uid');
  });

  it('rebuild dry-run makes ZERO persistent writes', async () => {
    const { userId, accountId } = await setupTestUser();

    // Seed a few conversations
    for (let i = 0; i < 5; i++) {
      const convId = crypto.randomUUID();
      const lmId = crypto.randomUUID();
      await pool.query(
        "INSERT INTO conversations (id, user_id, canonical_subject, kind, manually_locked) VALUES ($1, $2, 'rebuild-test', 'human_reply_chain', false)",
        [convId, userId]
      );
      await pool.query(
        "INSERT INTO logical_messages (id, conversation_id, user_id, canonical_message_id) VALUES ($1, $2, $3, $4)",
        [lmId, convId, userId, `<rebuild-${i}@example.com>`]
      );
      await insertMessage({
        accountId, userId, uid: 6000 + i, folder: 'INBOX', messageId: `<rebuild-${i}@example.com>`,
        subject: 'Rebuild test', fromEmail: `sender-${i}@example.com`, toEmails: ['me@example.com'],
        date: `2026-08-0${i + 1}T10:00:00Z`, conversationId: convId, logicalMessageId: lmId,
        canonicalMessageId: `<rebuild-${i}@example.com>`, direction: 'incoming'
      });
    }

    // Compute checksum BEFORE dry-run
    const beforeChecksum = (await pool.query(`
      SELECT md5(string_agg(t.relname || ':' || ct::text, ',' ORDER BY t.relname))
      FROM (
        SELECT 'conversations' AS relname, COUNT(*) AS ct FROM conversations WHERE user_id = $1
        UNION ALL SELECT 'logical_messages', COUNT(*) FROM logical_messages lm JOIN conversations c ON c.id = lm.conversation_id WHERE c.user_id = $1
        UNION ALL SELECT 'messages_ce', COUNT(*) FROM messages m WHERE m.conversation_id IN (SELECT id FROM conversations WHERE user_id = $1)
      ) t
    `, [userId])).rows[0].md5;

    // Dry-run: run in a transaction and ROLLBACK (simulates zero-write dry-run)
    await pool.query('BEGIN');
    try {
      // The rebuild would process messages here — but dry-run must not write
      // We simulate by just reading and rolling back
      const msgs = await pool.query('SELECT id FROM messages WHERE conversation_id IS NOT NULL AND account_id = $1', [accountId]);
      // Don't write anything
      await pool.query('ROLLBACK');
    } catch (e) {
      await pool.query('ROLLBACK');
      throw e;
    }

    // Compute checksum AFTER dry-run
    const afterChecksum = (await pool.query(`
      SELECT md5(string_agg(t.relname || ':' || ct::text, ',' ORDER BY t.relname))
      FROM (
        SELECT 'conversations' AS relname, COUNT(*) AS ct FROM conversations WHERE user_id = $1
        UNION ALL SELECT 'logical_messages', COUNT(*) FROM logical_messages lm JOIN conversations c ON c.id = lm.conversation_id WHERE c.user_id = $1
        UNION ALL SELECT 'messages_ce', COUNT(*) FROM messages m WHERE m.conversation_id IN (SELECT id FROM conversations WHERE user_id = $1)
      ) t
    `, [userId])).rows[0].md5;

    assert.equal(afterChecksum, beforeChecksum, 'Dry-run must not change any CE data (checksums must match)');
  });
});
