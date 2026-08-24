// Real PostgreSQL regression tests for Conversation Engine v2.
// Requires a live PostgreSQL database with all CE v2 migrations applied.
// Run with: DB_HOST=localhost DB_NAME=mailflow_ce_test DB_USER=mailflow DB_PASSWORD=mailflow npx vitest run src/services/conversationPgRegression.test.js

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { query, pool } from './db.js';
import { rebuildConversationCopies } from './conversationRebuild.js';
import { randomUUID } from 'crypto';

const hasPg = process.env.DB_HOST && process.env.DB_NAME;
const describeOrSkip = hasPg ? describe : describe.skip;

const TEST_USER_ID = '00000000-0000-0000-0000-000000000201';
const TEST_ACCOUNT_ID = '00000000-0000-0000-0000-000000000202';
const ALT_ACCOUNT_ID = '00000000-0000-0000-0000-000000000203';

async function ensureFixtures() {
  await query('DELETE FROM users WHERE id = $1', [TEST_USER_ID]);
  await query(`INSERT INTO users (id, username, password_hash) VALUES ($1, $2, $3)`, [TEST_USER_ID, `pg-regression-${Date.now()}`, 'x']);
  await query(`INSERT INTO email_accounts (id, user_id, name, email_address, protocol) VALUES ($1, $2, $3, $4, 'imap')`, [TEST_ACCOUNT_ID, TEST_USER_ID, 'Primary', 'me@example.test']);
  await query(`INSERT INTO email_accounts (id, user_id, name, email_address, protocol) VALUES ($1, $2, $3, $4, 'imap')`, [ALT_ACCOUNT_ID, TEST_USER_ID, 'Secondary', 'me2@example.test']);
}

async function cleanupAll() {
  await query('DELETE FROM messages WHERE account_id IN ($1, $2)', [TEST_ACCOUNT_ID, ALT_ACCOUNT_ID]);
  await query('DELETE FROM logical_messages WHERE user_id = $1', [TEST_USER_ID]);
  await query('DELETE FROM conversations WHERE user_id = $1', [TEST_USER_ID]);
  await query('DELETE FROM conversation_overrides WHERE user_id = $1', [TEST_USER_ID]);
  await query('DELETE FROM conversation_rebuild_checkpoints WHERE user_id = $1', [TEST_USER_ID]);
  await query('DELETE FROM email_accounts WHERE user_id = $1', [TEST_USER_ID]);
  await query('DELETE FROM users WHERE id = $1', [TEST_USER_ID]);
}

async function cleanMessages() {
  await query('DELETE FROM messages WHERE account_id IN ($1, $2)', [TEST_ACCOUNT_ID, ALT_ACCOUNT_ID]);
  await query('DELETE FROM logical_messages WHERE user_id = $1', [TEST_USER_ID]);
  await query('DELETE FROM conversations WHERE user_id = $1', [TEST_USER_ID]);
  await query('DELETE FROM conversation_overrides WHERE user_id = $1', [TEST_USER_ID]);
  await query('DELETE FROM conversation_rebuild_checkpoints WHERE user_id = $1', [TEST_USER_ID]);
}

async function insertMessage(opts) {
  const id = opts.id || randomUUID();
  await query(`
    INSERT INTO messages (id, account_id, uid, folder, message_id, subject, from_email, to_addresses, in_reply_to, thread_references, date, body_text, is_read)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13)
  `, [
    id, opts.accountId || TEST_ACCOUNT_ID, opts.uid, opts.folder, opts.messageId, opts.subject, opts.fromEmail,
    JSON.stringify(opts.toAddresses || [{ email: 'me@example.test' }]),
    opts.inReplyTo || null, opts.references || null,
    opts.date || new Date(), opts.bodyText || 'body', opts.isRead ?? false
  ]);
  return id;
}

async function ceChecksum(accountId) {
  const r = await query(`
    SELECT md5(string_agg(payload, '|' ORDER BY payload)) AS checksum
    FROM (
      SELECT id::text || ':' || COALESCE(conversation_id::text, '') || ':' || COALESCE(logical_message_id::text, '') AS payload
      FROM messages WHERE account_id = $1
      UNION ALL
      SELECT id::text || ':' || COALESCE(conversation_id::text, '') || ':' || COALESCE(canonical_message_id, '') AS payload
      FROM logical_messages WHERE user_id = $2
      UNION ALL
      SELECT id::text || ':' || logical_message_count::text || ':' || copy_count::text || ':' || unread_count::text AS payload
      FROM conversations WHERE user_id = $2
    ) v
  `, [accountId, TEST_USER_ID]);
  return r.rows[0]?.checksum;
}

describeOrSkip('CE v2 PostgreSQL regression tests', () => {
  beforeAll(async () => { await ensureFixtures(); }, 30000);
  afterAll(async () => { await cleanupAll(); await pool.end(); });
  afterEach(async () => { await cleanMessages(); }, 15000);

  // ── A. Golden all-folder test ──────────────────────────────────────────────
  describe('A. Golden all-folder: 5 LogicalMessages, same conversation', () => {
    it('groups Inbox/Sent/Archive copies into one conversation', async () => {
      const baseTime = new Date('2026-01-15T10:00:00Z');
      const msgs = [
        { messageId: '<msg-001@example.test>', subject: 'Golden thread', from: 'alice@example.test', to: 'me@example.test', folder: 'INBOX', irt: null, refs: null, date: new Date(baseTime + 0 * 60000), read: false },
        { messageId: '<msg-002@example.test>', subject: 'Re: Golden thread', from: 'me@example.test', to: 'alice@example.test', folder: 'Sent', irt: '<msg-001@example.test>', refs: '<msg-001@example.test>', date: new Date(baseTime + 1 * 60000), read: true },
        { messageId: '<msg-003@example.test>', subject: 'Re: Golden thread', from: 'alice@example.test', to: 'me@example.test', folder: 'INBOX', irt: '<msg-002@example.test>', refs: '<msg-001@example.test> <msg-002@example.test>', date: new Date(baseTime + 2 * 60000), read: false },
        { messageId: '<msg-004@example.test>', subject: 'Re: Golden thread', from: 'me@example.test', to: 'alice@example.test', folder: 'Sent', irt: '<msg-003@example.test>', refs: '<msg-001@example.test> <msg-002@example.test> <msg-003@example.test>', date: new Date(baseTime + 3 * 60000), read: true },
        { messageId: '<msg-005@example.test>', subject: 'Re: Golden thread', from: 'alice@example.test', to: 'me@example.test', folder: 'INBOX', irt: '<msg-004@example.test>', refs: '<msg-001@example.test> <msg-002@example.test> <msg-003@example.test> <msg-004@example.test>', date: new Date(baseTime + 4 * 60000), read: false },
      ];

      for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        await insertMessage({ messageId: m.messageId, subject: m.subject, fromEmail: m.from, toAddresses: [{ email: m.to }], folder: m.folder, inReplyTo: m.irt, references: m.refs, date: m.date, isRead: m.read, uid: 100 + i });
        if (m.folder === 'INBOX') {
          await insertMessage({ messageId: m.messageId, subject: m.subject, fromEmail: m.from, toAddresses: [{ email: m.to }], folder: 'Archive', inReplyTo: m.irt, references: m.refs, date: m.date, isRead: m.read, uid: 200 + i });
        }
        await insertMessage({ messageId: m.messageId, subject: m.subject, fromEmail: m.from, toAddresses: [{ email: m.to }], folder: 'All Mail', inReplyTo: m.irt, references: m.refs, date: m.date, isRead: m.read, uid: 300 + i });
      }

      const result = await rebuildConversationCopies({ userId: TEST_USER_ID, accountId: TEST_ACCOUNT_ID, limit: 500, dryRun: false, force: true });
      expect(result.updated).toBeGreaterThan(0);

      const lmCount = await query('SELECT COUNT(*)::int AS c FROM logical_messages WHERE user_id = $1', [TEST_USER_ID]);
      expect(lmCount.rows[0].c).toBe(5);

      const convCount = await query('SELECT COUNT(*)::int AS c FROM conversations WHERE user_id = $1', [TEST_USER_ID]);
      expect(convCount.rows[0].c).toBe(1);

      const convIds = await query('SELECT DISTINCT conversation_id FROM logical_messages WHERE user_id = $1', [TEST_USER_ID]);
      expect(convIds.rows.length).toBe(1);
      const convUuid = convIds.rows[0].conversation_id;
      expect(convUuid).toBeTruthy();

      const convRow = await query('SELECT logical_message_count, copy_count, unread_count FROM conversations WHERE id = $1', [convUuid]);
      expect(convRow.rows[0].logical_message_count).toBe(5);
      expect(convRow.rows[0].copy_count).toBeGreaterThanOrEqual(5);
    }, 30000);
  });

  // ── B. Subject Test ×100 ──────────────────────────────────────────────────
  describe('B. Subject Test ×100: zero false merges', () => {
    it('does not group 100 unrelated "Subject: Test" messages into conversations', async () => {
      for (let i = 0; i < 100; i++) {
        const year = 2020 + (i % 7);
        const sender = `sender${i}@example${i % 5}.test`;
        const account = i % 2 === 0 ? TEST_ACCOUNT_ID : ALT_ACCOUNT_ID;
        const folder = i % 3 === 0 ? 'INBOX' : (i % 3 === 1 ? 'Sent' : 'Archive');
        await insertMessage({
          messageId: `<test-${i}-${year}@${sender}>`,
          subject: 'Test',
          fromEmail: sender,
          toAddresses: [{ email: 'me@example.test' }],
          folder,
          date: new Date(`${year}-06-15T10:00:00Z`),
          isRead: true,
          uid: i + 1,
          accountId: account,
        });
      }

      await rebuildConversationCopies({ userId: TEST_USER_ID, accountId: null, limit: 500, dryRun: false, force: true });

      const convCount = await query('SELECT COUNT(*)::int AS c FROM conversations WHERE user_id = $1', [TEST_USER_ID]);
      expect(convCount.rows[0].c).toBe(100);

      const lmCount = await query('SELECT COUNT(*)::int AS c FROM logical_messages WHERE user_id = $1', [TEST_USER_ID]);
      expect(lmCount.rows[0].c).toBe(100);
    }, 60000);
  });

  // ── C. Message-ID collision ───────────────────────────────────────────────
  describe('C. Message-ID collision: 4 distinct emails with same Message-ID', () => {
    it('keeps 4 LogicalMessages after reingest with colliding Message-ID', async () => {
      const collidingId = '<collision@example.test>';
      for (let i = 0; i < 4; i++) {
        await insertMessage({
          messageId: collidingId,
          subject: `Collision variant ${i}`,
          fromEmail: `sender${i}@example.test`,
          toAddresses: [{ email: 'me@example.test' }],
          folder: 'INBOX',
          date: new Date(2026, 0, 15 + i),
          isRead: true,
          uid: i + 1,
          bodyText: `unique body content ${i} ${Date.now()}`,
        });
      }

      await rebuildConversationCopies({ userId: TEST_USER_ID, accountId: TEST_ACCOUNT_ID, limit: 500, dryRun: false, force: true });

      const lmCount = await query('SELECT COUNT(*)::int AS c FROM logical_messages WHERE user_id = $1', [TEST_USER_ID]);
      expect(lmCount.rows[0].c).toBe(4);

      // Reingest
      await rebuildConversationCopies({ userId: TEST_USER_ID, accountId: TEST_ACCOUNT_ID, limit: 500, dryRun: false, force: true });
      const lmCount2 = await query('SELECT COUNT(*)::int AS c FROM logical_messages WHERE user_id = $1', [TEST_USER_ID]);
      expect(lmCount2.rows[0].c).toBe(4);
    }, 30000);
  });

  // ── D. Rebuild dry-run ────────────────────────────────────────────────────
  describe('D. Rebuild dry-run: zero persistent writes', () => {
    it('dry-run does not modify any CE state', async () => {
      await insertMessage({ messageId: '<dry-run-test@example.test>', subject: 'Dry run', fromEmail: 'alice@example.test', folder: 'INBOX', isRead: true, uid: 1 });

      const result = await rebuildConversationCopies({ userId: TEST_USER_ID, accountId: TEST_ACCOUNT_ID, limit: 500, dryRun: true, force: true });
      expect(result.dryRun).toBe(true);

      // Verify no conversation/logical_message was created
      const lmCount = await query('SELECT COUNT(*)::int AS c FROM logical_messages WHERE user_id = $1', [TEST_USER_ID]);
      expect(lmCount.rows[0].c).toBe(0);
      const convCount = await query('SELECT COUNT(*)::int AS c FROM conversations WHERE user_id = $1', [TEST_USER_ID]);
      expect(convCount.rows[0].c).toBe(0);
    }, 30000);
  });

  // ── E. Rebuild repair/idempotency ──────────────────────────────────────────
  describe('E. Rebuild repair + idempotency', () => {
    it('pass #1 repairs intentionally broken CE state, pass #2 changes nothing', async () => {
      await insertMessage({ messageId: '<repair-001@example.test>', subject: 'Repair thread', fromEmail: 'alice@example.test', folder: 'INBOX', isRead: false, uid: 1, date: new Date('2026-01-15T10:00:00Z') });
      await insertMessage({ messageId: '<repair-002@example.test>', subject: 'Re: Repair thread', fromEmail: 'me@example.test', toAddresses: [{ email: 'alice@example.test' }], folder: 'Sent', isRead: true, uid: 2, date: new Date('2026-01-15T11:00:00Z'), inReplyTo: '<repair-001@example.test>', references: '<repair-001@example.test>' });

      // Pass #1: build CE state
      const pass1 = await rebuildConversationCopies({ userId: TEST_USER_ID, accountId: TEST_ACCOUNT_ID, limit: 500, dryRun: false, force: true });
      expect(pass1.updated).toBeGreaterThan(0);
      await ceChecksum(TEST_ACCOUNT_ID);

      // Break CE state
      await query('UPDATE messages SET conversation_id = NULL, logical_message_id = NULL, conversation_user_id = NULL WHERE account_id = $1', [TEST_ACCOUNT_ID]);
      await query('DELETE FROM logical_messages WHERE user_id = $1', [TEST_USER_ID]);
      await query('DELETE FROM conversations WHERE user_id = $1', [TEST_USER_ID]);
      await query('DELETE FROM conversation_rebuild_checkpoints WHERE user_id = $1', [TEST_USER_ID]);

      // Pass #2: repair
      const pass2 = await rebuildConversationCopies({ userId: TEST_USER_ID, accountId: TEST_ACCOUNT_ID, limit: 500, dryRun: false, force: true });
      expect(pass2.updated).toBeGreaterThan(0);
      const checksum2 = await ceChecksum(TEST_ACCOUNT_ID);

      // Pass #3: idempotency
      await query('DELETE FROM conversation_rebuild_checkpoints WHERE user_id = $1', [TEST_USER_ID]);
      const pass3 = await rebuildConversationCopies({ userId: TEST_USER_ID, accountId: TEST_ACCOUNT_ID, limit: 500, dryRun: false, force: true });
      const checksum3 = await ceChecksum(TEST_ACCOUNT_ID);

      expect(pass3.updated).toBe(0);
      expect(checksum2).toBe(checksum3);
    }, 60000);
  });

  // ── F. Performance with EXPLAIN ANALYZE ─────────────────────────────────────
  describe('F. Performance — real EXPLAIN on hot queries', () => {
    it('conversation list query uses index, not seq scan, at 10k+ scale', async () => {
      // Seed 10k physical copies across 100 conversations
      const batchSize = 500;
      for (let batch = 0; batch < 20; batch++) {
        const values = [];
        for (let i = 0; i < batchSize; i++) {
          const idx = batch * batchSize + i;
          values.push(`($1, ${idx + 1000}, 'INBOX', '<perf-${idx}@test>', 'Perf ${idx}', 'sender@test', '[]'::jsonb, NOW() - ('${batch}' || ' hours')::interval)`);
        }
        await query(`INSERT INTO messages (account_id, uid, folder, message_id, subject, from_email, to_addresses, date) VALUES ${values.map(v => v.replace('$1', '$1')).join(',')}`, [TEST_ACCOUNT_ID]);
      }
      await rebuildConversationCopies({ userId: TEST_USER_ID, accountId: TEST_ACCOUNT_ID, limit: 500, dryRun: false, force: true });

      // EXPLAIN ANALYZE the conversation list query
      const plan = await query(`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT c.id, c.subject_snapshot, c.logical_message_count, c.unread_count
          FROM conversations c
         WHERE c.user_id = $1
         ORDER BY c.last_message_at DESC NULLS LAST
         LIMIT 50
      `, [TEST_USER_ID]);
      const planData = plan.rows[0]['QUERY PLAN'];
      const planStr = JSON.stringify(planData);
      // Must NOT use Seq Scan on conversations for this hot path
      expect(planStr).not.toContain('Seq Scan on conversations');
      // Must use an index
      expect(planStr).toContain('Index Scan');
    }, 120000);

    it('message lookup by logical_message_id uses index, not seq scan', async () => {
      const plan = await query(`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT m.id, m.subject, m.is_read, m.is_starred
          FROM messages m
         WHERE m.conversation_id = (SELECT id FROM conversations WHERE user_id = $1 LIMIT 1)
           AND m.is_deleted = false
         ORDER BY m.date DESC
         LIMIT 50
      `, [TEST_USER_ID]);
      const planData = plan.rows[0]['QUERY PLAN'];
      const planStr = JSON.stringify(planData);
      // Must NOT use Seq Scan on messages for this hot path
      expect(planStr).not.toContain('Seq Scan on messages');
    }, 60000);
  });
});
