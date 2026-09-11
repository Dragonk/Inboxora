import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { randomUUID } from 'crypto';
import { query, pool } from './db.js';
import { upsertConversationCopy } from './conversationPersistence.js';
import { listMessages } from './messageService.js';

describe.skipIf(process.env.REQUIRE_MAIL_POSTGRES !== '1')('Gmail native grouping on PostgreSQL', () => {
  const userId = randomUUID();
  const accountId = randomUUID();
  beforeAll(async () => {
    await query('INSERT INTO users(id, username, password_hash) VALUES($1,$2,$3)', [userId, `gmail-test-${userId}`, 'unused']);
    await query("INSERT INTO email_accounts(id,user_id,name,email_address,protocol,imap_host) VALUES($1,$2,'Gmail test','me@example.test','imap','imap.gmail.com')", [accountId, userId]);
  });
  afterAll(async () => { await query('DELETE FROM users WHERE id=$1', [userId]); await pool.end(); });
  it('uses X-GM-THRID in native list and expansion, preserves 64-bit IDs, and does not group by subject alone', async () => {
    const ids = ['90071992547409931', '90071992547409931', '90071992547409932'];
    for (let n = 0; n < ids.length; n++) {
      const messageId = `<otp-${n}@example.test>`;
      const row = (await query(`INSERT INTO messages(account_id, uid, folder, message_id, thread_id, subject, from_email, to_addresses, date, snippet, is_read)
        VALUES($1,$2,'INBOX',$3::text,$3::text,'Authentication code','noreply@example.test','[{"address":"me@example.test"}]',$4,'Synthetic message',false) RETURNING *`, [accountId, n + 1, messageId, new Date(`2026-09-0${n + 1}T09:00:00Z`)])).rows[0];
      await upsertConversationCopy({ ...row, user_id: userId }, {
        userId, identities: ['me@example.test'], provider: { provider: 'gmail', isStrong: true, source: 'provider-thread-id', providerThreadId: ids[n], namespace: `gmail:${accountId}:imap.gmail.com` },
      });
    }
    const listed = await listMessages({ userId, accountId, threaded: true });
    expect(listed.messages).toHaveLength(2);
    const grouped = listed.messages.find(row => row.thread_key === 'gmail:90071992547409931');
    expect(Number(grouped.message_count)).toBe(2);
    expect(Number(grouped.unread_count)).toBe(2);
    const children = await query('SELECT id FROM messages WHERE account_id=$1 AND thread_key=$2', [accountId, grouped.thread_key]);
    expect(children.rows).toHaveLength(2);
  });
});
