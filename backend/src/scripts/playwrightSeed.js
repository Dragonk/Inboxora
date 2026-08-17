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
    const result = await client.query('INSERT INTO users (username, password_hash, is_admin) VALUES ($1, $2, true) RETURNING id', [username, passwordHash]);
    userId = result.rows[0].id;
  } else {
    await client.query('UPDATE users SET password_hash = $1, is_admin = true WHERE id = $2', [passwordHash, userId]);
  }
  await client.query('DELETE FROM messages WHERE conversation_user_id = $1', [userId]);
  await client.query('DELETE FROM conversations WHERE user_id = $1', [userId]);
  await client.query('DELETE FROM email_accounts WHERE user_id = $1', [userId]);
  const accounts = [];
  for (const [name, email, host] of [['Gmail fixture', 'me@gmail.test', 'imap.gmail.com'], ['Outlook fixture', 'me@outlook.test', 'outlook.office365.com'], ['Fastmail fixture', 'me@fastmail.test', 'imap.fastmail.com']]) {
    const result = await client.query('INSERT INTO email_accounts (user_id, name, email_address, auth_user, imap_host, enabled, protocol) VALUES ($1, $2, $3, $3, $4, false, \'imap\') RETURNING id', [userId, name, email, host]);
    accounts.push(result.rows[0].id);
  }
  for (const [index, subject] of ['Gmail reply chain', 'Outlook conversation', 'Fastmail generic IMAP'].entries()) {
    const count = index === 0 ? 3 : 2;
    const conversation = await client.query(`INSERT INTO conversations (user_id, canonical_subject, subject_snapshot, first_message_at, last_message_at, logical_message_count, copy_count, unread_count, threading_confidence) VALUES ($1, $2, $2, NOW() - interval '3 days', NOW(), $3, $3, 0, 1) RETURNING id`, [userId, subject, count]);
    const conversationId = conversation.rows[0].id;
    for (let n = 0; n < count; n++) {
      const canonicalId = `<fixture-${index}-${n}@example.test>`;
      const logical = await client.query(`INSERT INTO logical_messages (user_id, conversation_id, canonical_message_id, raw_message_id, subject, canonical_subject, direction, message_date, threading_reason, threading_confidence) VALUES ($1, $2, $3, $3, $4, $5, $6, NOW() - ($7 || ' days')::interval, 'playwright-fixture', 1) RETURNING id`, [userId, conversationId, canonicalId, subject, subject, index === 0 && n === count - 1 ? 'outgoing' : 'incoming', count - n]);
      await client.query(`INSERT INTO messages (account_id, uid, folder, message_id, subject, from_name, from_email, to_addresses, date, snippet, body_text, body_html, is_read, logical_message_id, conversation_id, conversation_user_id, canonical_message_id, threading_reason, threading_confidence) VALUES ($1, $2, 'INBOX', $3, $4, 'Fixture Sender', 'sender@example.test', '[]'::jsonb, NOW() - ($5 || ' days')::interval, $4, $6, $7, true, $8, $9, $10, $3, 'playwright-fixture', 1)`, [accounts[(index + n) % accounts.length], 1000 + index * 10 + n, canonicalId, subject, count - n, `Fixture body ${n + 1}`, `<p>Fixture body ${n + 1}</p><blockquote>Quoted previous message</blockquote>`, logical.rows[0].id, conversationId, userId]);
    }
  }
  const check = await client.query('SELECT COUNT(*)::int AS conversations FROM conversations WHERE user_id = $1', [userId]);
  if (check.rows[0].conversations !== 3) throw new Error('Playwright seed validation failed');
  await client.query('COMMIT');
  console.log(JSON.stringify({ username, userId, accounts }));
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  client.release();
  await pool.end();
}
