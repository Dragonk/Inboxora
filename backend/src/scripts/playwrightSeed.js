import bcrypt from 'bcryptjs';
import { pool } from '../services/db.js';

const username = process.env.PLAYWRIGHT_USERNAME || 'playwright@example.test';
const password = process.env.PLAYWRIGHT_PASSWORD || 'PlaywrightPassword123!';
const passwordHash = await bcrypt.hash(password, 4);
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const existing = await client.query('SELECT id FROM users WHERE username = $1 FOR UPDATE', [username]);
  let userId = existing.rows[0]?.id;
  if (!userId) {
    const result = await client.query(`INSERT INTO users (username, password_hash, is_admin, preferences)
      VALUES ($1, $2, true, '{"conversation_list_view_enabled": true, "conversation_reader_view_enabled": true}'::jsonb)
      RETURNING id`, [username, passwordHash]);
    userId = result.rows[0].id;
  } else {
    await client.query(`UPDATE users
      SET password_hash = $1, is_admin = true,
          preferences = COALESCE(preferences, '{}'::jsonb)
            || '{"conversation_list_view_enabled": true, "conversation_reader_view_enabled": true}'::jsonb
      WHERE id = $2`, [passwordHash, userId]);
  }
  await client.query('DELETE FROM messages WHERE account_id IN (SELECT id FROM email_accounts WHERE user_id = $1)', [userId]);
  await client.query('DELETE FROM conversations WHERE user_id = $1', [userId]);
  await client.query('DELETE FROM email_accounts WHERE user_id = $1', [userId]);

  // ── Accounts ──────────────────────────────────────────────────────────────
  // Gmail (with All-Mail), Outlook, Fastmail. All disabled (no IMAP connect).
  const accounts = [];
  for (const [name, email, host] of [
    ['Gmail fixture', 'me@gmail.test', 'imap.gmail.com'],
    ['Outlook fixture', 'me@outlook.test', 'outlook.office365.com'],
    ['Fastmail fixture', 'me@fastmail.test', 'imap.fastmail.com'],
  ]) {
    const result = await client.query(
      'INSERT INTO email_accounts (user_id, name, email_address, auth_user, imap_host, enabled, protocol) VALUES ($1, $2, $3, $3, $4, false, \'imap\') RETURNING id',
      [userId, name, email, host]
    );
    accounts.push(result.rows[0].id);
  }
  const [gmailId, outlookId] = accounts;

  // ── Helpers ────────────────────────────────────────────────────────────────
  const aliceEmail = 'alice@example.test';
  const myEmail = 'me@gmail.test';

  async function createConversation(accountId, subject, logicalCount, copyCount) {
    const conv = await client.query(
      `INSERT INTO conversations (user_id, account_id, canonical_subject, subject_snapshot, first_message_at, last_message_at, logical_message_count, copy_count, unread_count, threading_confidence)
       VALUES ($1, $2, $3, $3, NOW() - interval '5 days', NOW(), $4, $5, 0, 1) RETURNING id`,
      [userId, accountId, subject, logicalCount, copyCount]
    );
    return conv.rows[0].id;
  }

  async function createLogical(accountId, conversationId, index, direction, subject) {
    const canonicalId = `<fixture-${conversationId.slice(0, 8)}-${index}@example.test>`;
    const logical = await client.query(
      `INSERT INTO logical_messages (user_id, account_id, conversation_id, canonical_message_id, raw_message_id, subject, canonical_subject, direction, message_date, threading_reason, threading_confidence)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text, $4::text, $5::text, $6::text, $7::text, NOW() - ($8::text || ' days')::interval, 'playwright-fixture', 1) RETURNING id`,
      [userId, accountId, conversationId, canonicalId, subject, subject, direction, 5 - index]
    );
    return { id: logical.rows[0].id, canonicalId };
  }

  async function createCopy(accountId, uid, folder, logicalId, conversationId, canonicalId, subject, bodyText, bodyHtml, direction, dayOffset) {
    const fromName = direction === 'outgoing' ? 'Ja' : 'Alice';
    const fromEmail = direction === 'outgoing' ? myEmail : aliceEmail;
    const toAddr = direction === 'outgoing' ? aliceEmail : myEmail;
    await client.query(
      `INSERT INTO messages (account_id, uid, folder, message_id, subject, from_name, from_email, to_addresses, date, snippet, body_text, body_html, is_read, logical_message_id, conversation_id, conversation_user_id, canonical_message_id, threading_reason, threading_confidence)
       VALUES ($1::uuid, $2::int, $3::text, $4::text, $5::text, $6, $7, $8::jsonb, NOW() - ($9 || ' days')::interval, $5, $10, $11, true, $12, $13, $14, $4, 'playwright-fixture', 1)`,
      [accountId, uid, folder, canonicalId, subject, fromName, fromEmail, JSON.stringify([{ address: toAddr, name: direction === 'outgoing' ? 'Alice' : 'Ja' }]), String(dayOffset), bodyText, bodyHtml, logicalId, conversationId, userId]
    );
  }

  // ── Golden dataset: 5 logical messages, multiple copies ──────────────────
  // Gmail-only fixture: LM1 Inbox incoming, LM2 Sent outgoing, LM3 Archive incoming, LM4 Sent outgoing, LM5 Inbox incoming + All-Mail duplicate
  const goldenSubject = 'Golden conversation thread';
  const goldenId = await createConversation(gmailId, goldenSubject, 5, 6); // 5 logical, 6 physical copies

  const directions = ['incoming', 'outgoing', 'incoming', 'outgoing', 'incoming'];
  const bodies = Array.from({ length: 5 }, (_, i) => `Fixture body ${i + 1}`);
  const htmlBodies = bodies.map(b => `<p>${b}</p><blockquote>Quoted previous message</blockquote>`);

  for (let i = 0; i < 5; i++) {
    const { id: logicalId, canonicalId } = await createLogical(gmailId, goldenId, i, directions[i], goldenSubject);
    const dayOffset = 5 - i;

    if (i === 0) {
      // LM1: Inbox (Gmail)
      await createCopy(gmailId, 1001, 'INBOX', logicalId, goldenId, canonicalId, goldenSubject, bodies[i], htmlBodies[i], directions[i], dayOffset);
    } else if (i === 1) {
      // LM2: Sent (Gmail)
      await createCopy(gmailId, 1002, 'Sent', logicalId, goldenId, canonicalId, goldenSubject, bodies[i], htmlBodies[i], directions[i], dayOffset);
    } else if (i === 2) {
      // LM3: Archive (Gmail)
      await createCopy(gmailId, 1003, 'Archive', logicalId, goldenId, canonicalId, goldenSubject, bodies[i], htmlBodies[i], directions[i], dayOffset);
    } else if (i === 3) {
      // LM4: Sent (Gmail)
      await createCopy(gmailId, 1004, 'Sent', logicalId, goldenId, canonicalId, goldenSubject, bodies[i], htmlBodies[i], directions[i], dayOffset);
    } else if (i === 4) {
      // LM5: Inbox (Gmail) + All-Mail duplicate (Gmail)
      await createCopy(gmailId, 1005, 'INBOX', logicalId, goldenId, canonicalId, goldenSubject, bodies[i], htmlBodies[i], directions[i], dayOffset);
      await createCopy(gmailId, 1006, 'All-Mail', logicalId, goldenId, canonicalId, goldenSubject, bodies[i], htmlBodies[i], directions[i], dayOffset);
    }
  }

  // ── Other conversations (for variety) ─────────────────────────────────────
  for (const [index, subject] of ['Gmail reply chain', 'Outlook conversation', 'Fastmail generic IMAP'].entries()) {
    const count = index === 0 ? 3 : 2;
    const accountId = accounts[index % accounts.length];
    const conversationId = await createConversation(accountId, subject, count, count);
    for (let n = 0; n < count; n++) {
      const { id: logicalId, canonicalId } = await createLogical(accountId, conversationId, n, index === 0 && n === count - 1 ? 'outgoing' : 'incoming', subject);
      await createCopy(accountId, 1000 + index * 10 + n, 'INBOX', logicalId, conversationId, canonicalId, subject, `Fixture body ${n + 1}`, `<p>Fixture body ${n + 1}</p><blockquote>Quoted previous message</blockquote>`, index === 0 && n === count - 1 ? 'outgoing' : 'incoming', count - n);
    }
  }

  // ── Validation ────────────────────────────────────────────────────────────
  const check = await client.query('SELECT COUNT(*)::int AS conversations FROM conversations WHERE user_id = $1', [userId]);
  if (check.rows[0].conversations !== 4) throw new Error(`Playwright seed validation failed: expected 4 conversations, got ${check.rows[0].conversations}`);

  const goldenCheck = await client.query(
    `SELECT c.logical_message_count, c.copy_count,
            (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id) as physical_count,
            (SELECT count(DISTINCT m.folder) FROM messages m WHERE m.conversation_id = c.id) as folder_count
     FROM conversations c WHERE c.id = $1`,
    [goldenId]
  );
  const g = goldenCheck.rows[0];
  // count(*) returns bigint in pg → string in node; coerce to Number for comparison.
  const phys = Number(g.physical_count);
  const folders = Number(g.folder_count);
  if (Number(g.logical_message_count) !== 5 || phys !== 6 || folders < 4) {
    throw new Error(`Golden dataset validation failed: logical=${g.logical_message_count}, physical=${g.physical_count}, folders=${g.folder_count}`);
  }

  await client.query('COMMIT');
  console.log(JSON.stringify({ username, userId, accounts, goldenConversationId: goldenId }));
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  client.release();
  await pool.end();
}
