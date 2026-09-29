import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

vi.mock('../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn() }));

import { pool, query } from './db.js';
import { ImapManager, upsertIngestedMessageRow } from './imapManager.js';
import { drainMailFlagReadbacks } from './mailFlagState.js';
import type { EmailAccountRow } from './imapManager.js';
import { mockImapClient, mockImapManager } from '../test/imapClient.js';

const enabled = Boolean(process.env.DB_HOST && process.env.DB_NAME);
if (enabled && (!['127.0.0.1', 'localhost'].includes(process.env.DB_HOST ?? '') || !process.env.DB_NAME?.endsWith('_test'))) {
  throw new Error('IMAP flag regressions require an explicitly configured localhost test database');
}

const userId = randomUUID();
const accountId = randomUUID();
const messageId = randomUUID();
let account: EmailAccountRow;
const manager = mockImapManager({
  _applyFlagUpdates: ImapManager.prototype._applyFlagUpdates,
  broadcast: vi.fn(),
  pluginFacade: {},
});

async function message() {
  return (await query<{ is_read: boolean; is_starred: boolean }>('SELECT is_read, is_starred FROM messages WHERE id = $1', [messageId])).rows[0];
}

beforeAll(async () => {
  if (!enabled) return;
  await query('INSERT INTO users(id, username, password_hash) VALUES($1, $2, $3)', [userId, `imap-flags-${userId}`, 'unused']);
  await query(`INSERT INTO email_accounts(id, user_id, name, email_address, protocol, imap_host, mail_transport)
    VALUES($1,$2,'Synthetic flags','flags@example.test','imap','127.0.0.1','imap_smtp')`, [accountId, userId]);
  account = (await query<EmailAccountRow>('SELECT * FROM email_accounts WHERE id = $1', [accountId])).rows[0];
  await query(`INSERT INTO folders(account_id,path,name,uid_validity,highest_modseq,total_count,unread_count)
    VALUES($1,'INBOX','Inbox',7,1,6000,0)`, [accountId]);
  await query(`INSERT INTO messages(id,account_id,uid,folder,message_id,subject,is_read,is_starred)
    VALUES($1,$2,1,'INBOX','<old@example.test>','Old message',true,true)`, [messageId, accountId]);
  // UID 1 begins outside the recent-200 sequence window. Later arrivals push it
  // outside the recent-5000 UID window before the persisted readback drains.
  await query(`INSERT INTO messages(account_id,uid,folder,message_id,subject,is_read)
    VALUES($1,300,'INBOX','<latest@example.test>','Latest message',true)`, [accountId]);
});

beforeEach(async () => {
  if (!enabled) return;
  vi.clearAllMocks();
  await query('DELETE FROM mail_flag_readbacks WHERE message_id = $1', [messageId]);
  await query('DELETE FROM mail_flag_intents WHERE message_id = $1', [messageId]);
  await query('UPDATE messages SET is_read = true, is_starred = true, read_changed_at = NOW(), star_changed_at = NOW() WHERE id = $1', [messageId]);
  await query("UPDATE folders SET highest_modseq = 1 WHERE account_id = $1 AND path = 'INBOX'", [accountId]);
  await query("UPDATE messages SET uid = 300 WHERE account_id = $1 AND id <> $2", [accountId, messageId]);
});

afterAll(async () => {
  if (!enabled) return;
  await query('DELETE FROM users WHERE id = $1', [userId]);
  await pool.end();
});

describe.skipIf(!enabled)('IMAP protected flags (synthetic PostgreSQL)', () => {
  it('persists a readback obligation before advancing the CONDSTORE cursor', async () => {
    // The provider re-observed this old UID while it was locally protected. Simulate
    // that precise changedSince response without any external account/network.
    const calls: Array<{ range: string; changedSince?: bigint }> = [];
    const client = mockImapClient({
      mailbox: { path: 'INBOX', exists: 300, uidValidity: 7n, uidNext: 301, highestModseq: 2n },
      capabilities: new Map([['CONDSTORE', true]]),
      enabled: new Set(['CONDSTORE']),
      getMailboxLock: async () => ({ release() {} }),
      async *fetch(range: string, _fields: unknown, options?: { changedSince?: bigint }) {
        calls.push({ range, changedSince: options?.changedSince });
        if (options?.changedSince !== undefined) yield { uid: 1, flags: new Set<string>(), modseq: 2n };
      },
    });
    await ImapManager.prototype.syncMessages.call(manager, account, client, 'INBOX', 20, false, true);
    expect(await message()).toEqual({ is_read: true, is_starred: true });
    expect((await query('SELECT message_id FROM mail_flag_readbacks WHERE message_id = $1', [messageId])).rows).toHaveLength(1);
    expect(String((await query("SELECT highest_modseq FROM folders WHERE account_id = $1 AND path = 'INBOX'", [accountId])).rows[0].highest_modseq)).toBe('2');
    await query("UPDATE messages SET uid = 6001 WHERE account_id = $1 AND id <> $2", [accountId, messageId]);
    await ImapManager.prototype.syncMessages.call(manager, account, client, 'INBOX', 20, false, true);
    expect(calls.filter(call => call.changedSince !== undefined)).toHaveLength(1);
    // Empty subsequent deltas do not clear the durable obligation.
    expect((await query('SELECT message_id FROM mail_flag_readbacks WHERE message_id = $1', [messageId])).rows).toHaveLength(1);
    await query("UPDATE messages SET read_changed_at = NOW()-interval '1 minute', star_changed_at = NOW()-interval '1 minute' WHERE id = $1", [messageId]);
    await query('UPDATE mail_flag_readbacks SET next_attempt_at = NOW() WHERE message_id = $1', [messageId]);
    const readMessageFlags = vi.fn(async () => ({ isRead: false, isStarred: false }));
    const restarted = mockImapManager({ readMessageFlags, setFlag: vi.fn(), broadcast: vi.fn() });
    await drainMailFlagReadbacks({ manager: restarted }, 25, accountId);
    expect(readMessageFlags).toHaveBeenCalledWith(expect.objectContaining({ id: accountId }), '1', 'INBOX', '7');
    expect(restarted.setFlag).not.toHaveBeenCalled();
    expect(await message()).toEqual({ is_read: false, is_starred: false });
    expect((await query('SELECT message_id FROM mail_flag_readbacks WHERE message_id = $1', [messageId])).rows).toHaveLength(0);
    expect((await query("SELECT unread_count FROM folders WHERE account_id = $1 AND path = 'INBOX'", [accountId])).rows[0].unread_count).toBe(1);
    expect(restarted.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'message_flags', accountId }), userId);
  });

  it('preserves the same durable obligation when a metadata upsert suppresses flags', async () => {
    await upsertIngestedMessageRow(account, 'INBOX', {
      uid: 1, messageId: '<old@example.test>', subject: 'Updated metadata',
      fromName: 'Sender', fromEmail: 'sender@example.test', to: [], cc: [], replyTo: [],
      inReplyTo: null, references: null, date: new Date(), snippet: '',
      isRead: false, isStarred: false, hasAttachments: false, flags: [],
      deliveryAddresses: [], senderName: null, senderEmail: null,
    }, { sanitizeHtml: null, textBody: null, attachments: [] });
    expect(await message()).toEqual({ is_read: true, is_starred: true });
    expect((await query('SELECT message_id FROM mail_flag_readbacks WHERE message_id = $1', [messageId])).rows).toHaveLength(1);
    expect((await query('SELECT subject FROM messages WHERE id = $1', [messageId])).rows[0].subject).toBe('Updated metadata');
  });

  it('applies ordinary unprotected read/star changes and repairs folder counts', async () => {
    await query("UPDATE messages SET read_changed_at = NOW()-interval '1 minute', star_changed_at = NOW()-interval '1 minute' WHERE id = $1", [messageId]);
    expect(await manager._applyFlagUpdates(account, 'INBOX', [{ uid: 1, isRead: false, isStarred: false }])).toBe(1);
    expect(await message()).toEqual({ is_read: false, is_starred: false });
    expect((await query("SELECT unread_count FROM folders WHERE account_id = $1 AND path = 'INBOX'", [accountId])).rows[0].unread_count).toBe(1);
    expect((await query('SELECT message_id FROM mail_flag_readbacks WHERE message_id = $1', [messageId])).rows).toHaveLength(0);
  });

  it('keeps a pending durable intent protected after the 30-second window', async () => {
    const { enqueueMailFlagIntent } = await import('./mailFlagState.js');
    await enqueueMailFlagIntent({ userId, accountId, messageId, flag: '\\Seen', value: true });
    await query("UPDATE messages SET read_changed_at = NOW()-interval '1 minute', star_changed_at = NOW()-interval '1 minute' WHERE id = $1", [messageId]);
    await manager._applyFlagUpdates(account, 'INBOX', [{ uid: 1, isRead: false, isStarred: false }]);
    expect(await message()).toEqual({ is_read: true, is_starred: false });
    expect((await query('SELECT message_id FROM mail_flag_readbacks WHERE message_id = $1', [messageId])).rows).toHaveLength(1);
  });
});
