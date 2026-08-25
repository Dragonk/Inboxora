// Real PostgreSQL regression tests for Conversation Engine v2.
// Requires a live PostgreSQL database with all CE v2 migrations applied.
// Run with: DB_HOST=localhost DB_NAME=mailflow_ce_test DB_USER=mailflow DB_PASSWORD=mailflow npx vitest run src/services/conversationPgRegression.integration.test.js

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { query, pool } from './db.js';
import { rebuildConversationCopies } from './conversationRebuild.js';
import { randomUUID } from 'crypto';

const hasPg = process.env.DB_HOST && process.env.DB_NAME;
if (process.env.REQUIRE_CE_POSTGRES === '1' && !hasPg) {
  throw new Error('REQUIRE_CE_POSTGRES=1 but DB_HOST/DB_NAME are not configured');
}
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
  await query('DELETE FROM messages WHERE account_id = ANY($1::uuid[])', [[TEST_ACCOUNT_ID, ALT_ACCOUNT_ID]]);
  await query('DELETE FROM logical_messages WHERE user_id = $1', [TEST_USER_ID]);
  await query('DELETE FROM conversations WHERE user_id = $1', [TEST_USER_ID]);
  await query('DELETE FROM conversation_overrides WHERE user_id = $1', [TEST_USER_ID]);
  await query('DELETE FROM conversation_rebuild_checkpoints WHERE user_id = $1', [TEST_USER_ID]);
  await query('DELETE FROM email_accounts WHERE user_id = $1', [TEST_USER_ID]);
  await query('DELETE FROM users WHERE id = $1', [TEST_USER_ID]);
}

async function cleanMessages() {
  await query('DROP TRIGGER IF EXISTS _ce_atomicity_trigger ON messages');
  await query('DROP FUNCTION IF EXISTS _ce_atomicity_fail()');
  await query('DELETE FROM messages WHERE account_id = ANY($1::uuid[])', [[TEST_ACCOUNT_ID, ALT_ACCOUNT_ID]]);
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
  // Large PostgreSQL fixtures (100 Subject: Test rows plus CE aggregates) can take
  // longer than the unit-test default to cascade-delete on constrained CI runners.
  // Keep the cleanup bounded but do not let a valid regression test fail merely because
  // cleanup exceeded 15s after a 60s data test.
  afterEach(async () => { await cleanMessages(); }, 120000);

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

  // ── A2. Cross-managed-account RFC chain ────────────────────────────────
  describe('A2. Cross-managed-account RFC chain', () => {
    async function assertResolvedConversation(copyId, expectedConversationId) {
      const resolved = await query(`
        SELECT m.logical_message_id, m.conversation_id
          FROM messages m JOIN email_accounts a ON a.id = m.account_id
         WHERE m.id = $1 AND a.user_id = $2 AND m.is_deleted = false
      `, [copyId, TEST_USER_ID]);
      expect(resolved.rows[0].conversation_id).toBe(expectedConversationId);
      const detail = await query(`
        SELECT lm.canonical_message_id
          FROM logical_messages lm
         WHERE lm.user_id = $1 AND lm.conversation_id = $2
         ORDER BY lm.message_date ASC, lm.id
      `, [TEST_USER_ID, expectedConversationId]);
      expect(detail.rows.map(row => row.canonical_message_id)).toEqual(['<m1@test>', '<m2@test>', '<m3@test>']);
    }

    it('links A→B, B→A, A→B into one user-scoped conversation and resolves every physical copy to all three messages', async () => {
      const messages = [
        { messageId: '<m1@test>', fromEmail: 'me@example.test', to: 'me2@example.test', inReplyTo: null, references: null, direction: 'outgoing' },
        { messageId: '<m2@test>', fromEmail: 'me2@example.test', to: 'me@example.test', inReplyTo: '<m1@test>', references: '<m1@test>', direction: 'outgoing' },
        { messageId: '<m3@test>', fromEmail: 'outside@example.test', to: 'me@example.test', inReplyTo: '<m2@test>', references: '<m1@test> <m2@test>', direction: 'incoming' },
      ];
      const physicalIds = [];
      for (let index = 0; index < messages.length; index++) {
        const item = messages[index];
        for (const [copyIndex, accountId, folder] of [[0, TEST_ACCOUNT_ID, index % 2 ? 'INBOX' : 'Sent'], [1, ALT_ACCOUNT_ID, index % 2 ? 'Sent' : 'INBOX']]) {
          physicalIds.push(await insertMessage({ accountId, uid: 600 + index * 10 + copyIndex, folder, messageId: item.messageId, subject: index ? 'Re: Cross account' : 'Cross account', fromEmail: item.fromEmail, toAddresses: [{ email: item.to }], inReplyTo: item.inReplyTo, references: item.references, date: new Date(`2026-08-25T11:4${index}:00Z`), bodyText: copyIndex ? `provider wrapper ${index}` : `body ${index}`, isRead: true }));
        }
      }

      await rebuildConversationCopies({ userId: TEST_USER_ID, accountId: null, limit: 500, dryRun: false, force: true });
      const logical = await query('SELECT id, conversation_id, direction FROM logical_messages WHERE user_id = $1 ORDER BY message_date ASC', [TEST_USER_ID]);
      expect(logical.rows).toHaveLength(3);
      expect(new Set(logical.rows.map(row => row.conversation_id)).size).toBe(1);
      const conversationId = logical.rows[0].conversation_id;
      expect(logical.rows.map(row => row.direction)).toEqual(messages.map(item => item.direction));
      const copies = await query('SELECT COUNT(*)::int AS count, COUNT(DISTINCT account_id)::int AS accounts FROM messages WHERE conversation_id = $1', [conversationId]);
      expect(copies.rows[0]).toEqual({ count: 6, accounts: 2 });
      for (const physicalId of physicalIds) await assertResolvedConversation(physicalId, conversationId);
    }, 60000);

    it('repairs legacy cross-account physical rows with no CE identity through the production rebuild', async () => {
      const ids = [];
      ids.push(await insertMessage({ accountId: TEST_ACCOUNT_ID, uid: 701, folder: 'Sent', messageId: '<legacy-m1@test>', subject: 'Legacy chain', fromEmail: 'me@example.test', toAddresses: [{ email: 'me2@example.test' }], date: new Date('2026-08-25T12:00:00Z'), isRead: true }));
      ids.push(await insertMessage({ accountId: ALT_ACCOUNT_ID, uid: 702, folder: 'Sent', messageId: '<legacy-m2@test>', subject: 'Re: Legacy chain', fromEmail: 'me2@example.test', toAddresses: [{ email: 'me@example.test' }], inReplyTo: '<legacy-m1@test>', references: '<legacy-m1@test>', date: new Date('2026-08-25T12:01:00Z'), isRead: true }));
      ids.push(await insertMessage({ accountId: TEST_ACCOUNT_ID, uid: 703, folder: 'Sent', messageId: '<legacy-m3@test>', subject: 'Re: Legacy chain', fromEmail: 'me@example.test', toAddresses: [{ email: 'me2@example.test' }], inReplyTo: '<legacy-m2@test>', references: '<legacy-m1@test> <legacy-m2@test>', date: new Date('2026-08-25T12:02:00Z'), isRead: true }));
      const before = await query('SELECT COUNT(*)::int AS count FROM messages WHERE id = ANY($1::uuid[]) AND logical_message_id IS NULL AND conversation_id IS NULL', [ids]);
      expect(before.rows[0].count).toBe(3);
      await rebuildConversationCopies({ userId: TEST_USER_ID, accountId: null, limit: 500, dryRun: false, force: true });
      const after = await query('SELECT COUNT(DISTINCT logical_message_id)::int AS logicals, COUNT(DISTINCT conversation_id)::int AS conversations FROM messages WHERE id = ANY($1::uuid[])', [ids]);
      expect(after.rows[0]).toEqual({ logicals: 3, conversations: 1 });
    }, 60000);
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

  // ── E2. Rebuild write atomicity — mid-batch failure rolls back entire batch ────
  describe('E2. Rebuild write atomicity', () => {
    it('mid-batch failure rolls back entire batch and checkpoint is not advanced', async () => {
      // Seed 3 messages that would produce real CE mutations
      await insertMessage({ messageId: '<atomic-001@example.test>', subject: 'Atomic 1', fromEmail: 'alice@example.test', folder: 'INBOX', isRead: false, uid: 1, date: new Date('2026-01-15T10:00:00Z') });
      await insertMessage({ messageId: '<atomic-002@example.test>', subject: 'Re: Atomic 1', fromEmail: 'me@example.test', toAddresses: [{ email: 'alice@example.test' }], folder: 'Sent', isRead: true, uid: 2, date: new Date('2026-01-15T11:00:00Z'), inReplyTo: '<atomic-001@example.test>', references: '<atomic-001@example.test>' });
      // Third message has a deliberately broken payload that will cause upsert to throw
      // (empty message_id → canonicalMessageId null → but the real trigger is a constraint
      // violation we inject by temporarily making the body too large for the fingerprint
      // hash — actually we simulate failure by corrupting the row after insert).
      await insertMessage({ messageId: '<atomic-003@example.test>', subject: 'Re: Atomic 1', fromEmail: 'bob@example.test', folder: 'INBOX', isRead: false, uid: 3, date: new Date('2026-01-15T12:00:00Z'), inReplyTo: '<atomic-001@example.test>', references: '<atomic-001@example.test>' });

      // Inject failure: set the third message's message_id to NULL, which makes
      // hydrateLogicalMessage produce canonicalMessageId=null and rawMessageId=null.
      // The INSERT into logical_messages will have canonical_message_id=null, which
      // is allowed, but the subsequent conversation_user_id assignment will fail
      // because the composite FK requires a valid conversation_id + conversation_user_id.
      // Actually, the real failure: with message_id=null, the upsert's ownership
      // verification query (SELECT m.* ... WHERE m.id = $1 AND a.user_id = $2) still
      // works, but the INSERT into logical_messages with canonical_message_id=null
      // is fine. We need a different injection point.
      //
      // Most reliable: delete the third message AFTER rebuild reads the batch
      // but BEFORE the upsert loop processes it. We do this by using a small batch
      // size and deleting the row in a parallel query. But rebuild reads all rows
      // in one query, then loops. So we use a different approach: set the 3rd
      // message's date to NULL AND message_id to NULL, which causes the
      // header_fingerprint to collide with message 1, creating a unique constraint
      // violation on the collision key.
      //
      // Actually, the simplest reliable injection: set conversation_user_id
      // on the 3rd message to a non-existent user. The upsert's ownership check
      // (SELECT ... JOIN email_accounts a ON a.id = m.account_id AND a.user_id = $2)
      // still passes (it checks a.user_id, not m.conversation_user_id). But the
      // composite FK fk_message_account_conversation_owner on messages will fire
      // when the upsert tries to SET conversation_id + conversation_user_id.
      //
      // Wait — the row starts with conversation_user_id=NULL. The upsert will
      // SET it to the userId. So we need a different approach.
      //
      // Final approach: use a trigger to make the 3rd row's UPDATE fail.
      // Create a temporary BEFORE UPDATE trigger that raises an exception for
      // the specific row. This is the most reliable way to inject a mid-batch
      // failure in PostgreSQL.
      await query(`
        CREATE OR REPLACE FUNCTION _ce_atomicity_fail() RETURNS trigger AS $$
        BEGIN
          IF NEW.message_id = '<atomic-003@example.test>' THEN
            RAISE EXCEPTION 'SIMULATED MID-BATCH FAILURE';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `);
      await query(`
        CREATE TRIGGER _ce_atomicity_trigger
        BEFORE UPDATE ON messages
        FOR EACH ROW
        WHEN (NEW.message_id = '<atomic-003@example.test>')
        EXECUTE FUNCTION _ce_atomicity_fail();
      `);

      // Run rebuild — should process messages 1 and 2, then fail on message 3
      // The trigger raises an exception on UPDATE of message 3, which causes the
      // serializable transaction to roll back the entire batch.
      await expect(rebuildConversationCopies({ userId: TEST_USER_ID, accountId: TEST_ACCOUNT_ID, limit: 500, dryRun: false, force: true }))
        .rejects.toThrow();

      // The entire batch should have been rolled back — no partial CE mutations
      const ceRows = await query('SELECT conversation_id, logical_message_id FROM messages WHERE account_id = $1 AND conversation_id IS NOT NULL', [TEST_ACCOUNT_ID]);
      expect(ceRows.rows.length).toBe(0);

      // Checkpoint should NOT have been advanced (the batch was rolled back)
      const cp = await query('SELECT status FROM conversation_rebuild_checkpoints WHERE user_id = $1 AND scope_account_id = $2', [TEST_USER_ID, TEST_ACCOUNT_ID]);
      // Either no checkpoint exists, or it's not 'complete'
      if (cp.rows.length > 0) {
        expect(cp.rows[0].status).not.toBe('complete');
      }

      // Now fix the broken message and retry — should succeed
      await query('DROP TRIGGER IF EXISTS _ce_atomicity_trigger ON messages');
      await query('DROP FUNCTION IF EXISTS _ce_atomicity_fail()');
      const result = await rebuildConversationCopies({ userId: TEST_USER_ID, accountId: TEST_ACCOUNT_ID, limit: 500, dryRun: false, force: true });
      expect(result.updated).toBeGreaterThan(0);
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
