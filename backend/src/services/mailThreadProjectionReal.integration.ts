import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, describe, it } from 'node:test';
import { pool, query } from './db.js';
import { listMessages } from './messageService.js';
import { listThreadMessages, ThreadAccountNotFoundError } from './mailThreadService.js';
import { readUnreadInboxCounts } from './unreadInboxCounts.js';

// Excluded from ordinary Vitest: run explicitly with localhost DB_* test credentials.
// node --import tsx --test --test-concurrency=2 src/services/mailThreadProjectionReal.integration.ts
if (!['127.0.0.1', 'localhost'].includes(process.env.DB_HOST ?? '') || !process.env.DB_NAME?.endsWith('_test')) {
  throw new Error('Projection regressions require an explicitly configured localhost test database');
}
const userId = randomUUID();
const foreignUserId = randomUUID();
let nextUid = 1;
const connectionIds = new Map<string, string>();
async function account(transport = 'imap_smtp', owner = userId, included = true) {
  const id = randomUUID();
  const connectionId = randomUUID();
  await query(`INSERT INTO provider_connections(id,user_id,provider,issuer,subject)
    VALUES($1,$2,$3,'synthetic-projection',$4)`,
  [connectionId, owner, transport === 'microsoft_graph' ? 'microsoft' : 'google', id]);
  await query(`INSERT INTO email_accounts(id,user_id,name,email_address,protocol,mail_transport,provider_connection_id,include_in_unified_inbox)
    VALUES($1,$2,'Synthetic projection','projection@example.test','imap',$3,$4,$5)`,
  [id, owner, transport, connectionId, included]);
  connectionIds.set(id, connectionId);
  return id;
}
async function message(accountId: string, options: {
  folder?: string; rfcId?: string | null; thread?: string | null; read?: boolean;
  providerId?: string | null; subject?: string | null; category?: string | null;
  archived?: boolean; deleted?: boolean; date?: string;
} = {}) {
  const id = randomUUID();
  await query(`INSERT INTO messages(id,account_id,uid,folder,message_id,thread_id,is_read,provider_message_id,
    subject,category,is_archived,is_deleted,date,snippet)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'')`,
  [id, accountId, nextUid++, options.folder ?? 'INBOX',
    options.rfcId === undefined ? '<shared@example.test>' : options.rfcId,
    options.thread === undefined ? 'shared-thread' : options.thread,
    options.read ?? false, options.providerId ?? null,
    options.subject === undefined ? 'Synthetic projection' : options.subject,
    options.category ?? null, options.archived ?? false, options.deleted ?? false,
    options.date ?? '2026-09-01T10:00:00Z']);
  return id;
}
async function children(accountId: string, threadId = 'shared-thread') {
  return (await listThreadMessages({ userId, accountId, threadId })).messages;
}
async function bind(accountId: string, legacy: string, canonical: string, status = 'bound', connectionId = connectionIds.get(accountId)) {
  await query(`INSERT INTO graph_legacy_message_bindings(legacy_message_id,canonical_message_id,account_id,connection_id,status)
    VALUES($1,$2,$3,$4,$5)`, [legacy, canonical, accountId, connectionId, status]);
}

describe('physical mail thread projection on PostgreSQL', { concurrency: false }, () => {
  beforeEach(async () => {
    await query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[userId, foreignUserId]]);
    for (const id of [userId, foreignUserId]) {
      await query('INSERT INTO users(id,username,password_hash) VALUES($1,$2,$3)', [id, `projection-${id}`, 'unused']);
    }
    connectionIds.clear();
    nextUid = 1;
  });
  after(async () => {
    await query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[userId, foreignUserId]]);
    await pool.end();
  });
  for (const transport of ['microsoft_graph', 'gmail_api', 'imap_smtp']) {
    it(`${transport}: equal RFC IDs preserve mixed read states and physical action IDs`, async () => {
      const accountId = await account(transport);
      const read = await message(accountId, { read: true, providerId: transport === 'imap_smtp' ? null : 'read-copy', date: '2026-09-01T10:00:02Z' });
      const unread = await message(accountId, { read: false, providerId: transport === 'imap_smtp' ? null : 'unread-copy', date: '2026-09-01T10:00:01Z' });
      const sent = await message(accountId, { folder: 'Sent', read: true, rfcId: '<reply@example.test>', providerId: transport === 'imap_smtp' ? null : 'sent-copy' });
      assert.equal((await readUnreadInboxCounts(userId)).total, 1);
      const all = await listMessages({ userId, accountId, threaded: true });
      const onlyUnread = await listMessages({ userId, accountId, threaded: true, unreadOnly: true });
      assert.equal(all.total, 1);
      assert.equal(all.messages[0]?.message_count, 3);
      assert.equal(all.messages[0]?.unread_count, 1);
      assert.equal(all.messages[0]?.id, read);
      assert.equal(all.messages[0]?.is_read, false);
      assert.equal(all.messages[0]?.physical_is_read, true);
      assert.equal(onlyUnread.messages[0]?.is_read, false);
      assert.equal(onlyUnread.total, 1);
      assert.equal(onlyUnread.messages[0]?.message_count, 3);
      const expanded = await children(accountId);
      assert.deepEqual(new Set(expanded.map(row => row.id)), new Set([read, unread, sent]));
      assert.deepEqual(expanded.filter(row => !row.is_read).map(row => row.id), [unread]);
      assert.equal((await listMessages({ userId, accountId })).total, 2);
      await query('UPDATE messages SET is_read=true WHERE id=$1', [unread]);
      const confirmedRead = await listMessages({ userId, accountId, threaded: true });
      assert.equal(confirmedRead.messages[0]?.unread_count, 0);
      assert.equal(confirmedRead.messages[0]?.is_read, true);
    });
  }
  it('retains NULL/blank RFC IDs and omits deleted rows and hollow placeholders consistently', async () => {
    const accountId = await account();
    const ids = [];
    for (const rfcId of [null, '', '   ', '<shared@example.test>', '<shared@example.test>']) ids.push(await message(accountId, { rfcId }));
    await message(accountId, { rfcId: null, subject: null });
    await message(accountId, { deleted: true });
    assert.deepEqual(new Set((await children(accountId)).map(row => row.id)), new Set(ids));
    const list = await listMessages({ userId, accountId, threaded: true });
    assert.equal(list.messages[0]?.message_count, 5);
    assert.equal(list.messages[0]?.unread_count, 5);
    assert.equal((await listMessages({ userId, accountId })).total, 5);
    assert.equal((await readUnreadInboxCounts(userId)).total, 5);
    const singleton = await message(accountId, { thread: null, rfcId: null });
    assert.deepEqual((await children(accountId, singleton)).map(row => row.id), [singleton]);
  });
  for (const transport of ['microsoft_graph', 'gmail_api']) it(`${transport}: keeps real provider items without an RFC ID, subject or preview`, async () => {
    const accountId = await account(transport);
    const native = await message(accountId, { rfcId: null, subject: null, providerId: 'real-empty-item' });
    await message(accountId, { rfcId: null, subject: null });
    assert.deepEqual((await children(accountId)).map(row => row.id), [native]);
    assert.equal((await listMessages({ userId, accountId })).total, 1);
    assert.equal((await listMessages({ userId, accountId, threaded: true })).messages[0]?.unread_count, 1);
    assert.equal((await readUnreadInboxCounts(userId)).total, 1);
  });
  it('aligns folder/label/category/unread heads and totals, full expansion and pagination', async () => {
    const accountId = await account('gmail_api');
    const inbox = await message(accountId, { category: 'primary' });
    const promotions = await message(accountId, { category: 'promotions', read: true });
    const sent = await message(accountId, { folder: 'Sent', read: true });
    const archive = await message(accountId, { archived: true });
    await query(`INSERT INTO message_labels(message_id,account_id,label_id,folder_path) VALUES($1,$2,'work','Work'),($1,$2,'another','Work')`, [inbox, accountId]);
    await message(accountId, { thread: 'other-thread', date: '2026-09-01T09:00:00Z' });
    const filtered = await listMessages({ userId, accountId, threaded: true, category: 'primary', unreadOnly: true, limit: 1 });
    assert.equal(filtered.total, 2);
    assert.equal(filtered.messages[0]?.message_count, 4);
    assert.equal(filtered.messages[0]?.unread_count, 1);
    const page2 = await listMessages({ userId, accountId, threaded: true, category: 'primary', unreadOnly: true, limit: 1, offset: 1 });
    assert.equal(page2.total, 2);
    assert.equal(page2.messages[0]?.thread_id, 'other-thread');
    const expanded = await children(accountId);
    assert.deepEqual(new Set(expanded.map(row => row.id)), new Set([inbox, promotions, sent, archive]));
    assert.deepEqual(expanded.find(row => row.id === inbox)?.folder_paths, ['Work', 'Work']);
    assert.equal(expanded.find(row => row.id === inbox)?.is_archived, false);
    assert.deepEqual(expanded.find(row => row.id === archive)?.folder_paths, []);
    assert.equal(expanded.find(row => row.id === archive)?.is_archived, true);
    const labelled = await listMessages({ userId, accountId, folder: 'Work', threaded: true });
    assert.equal(labelled.total, 1);
    assert.equal(labelled.messages[0]?.folder, 'Work');
    assert.equal(labelled.messages[0]?.unread_count, 1);
    assert.equal((await listMessages({ userId, accountId, folder: 'Work' })).total, 1);
    assert.equal((await listMessages({ userId, accountId, folder: 'Archive' })).total, 1);
    assert.equal((await readUnreadInboxCounts(userId)).total, 2);
  });
  it('preserves account namespaces, ownership, enabled state and unified opt-out', async () => {
    const included = await account();
    const excluded = await account('imap_smtp', userId, false);
    const foreign = await account('imap_smtp', foreignUserId);
    const disabled = await account();
    await query('UPDATE email_accounts SET enabled=false WHERE id=$1', [disabled]);
    const includedId = await message(included);
    const excludedId = await message(excluded);
    await message(foreign);
    await message(disabled);
    const unified = await listMessages({ userId, threaded: true });
    assert.equal(unified.total, 1);
    assert.equal(unified.messages[0]?.thread_id, `${included}:shared-thread`);
    assert.deepEqual((await listThreadMessages({ userId, unified: true, threadId: `${included}:shared-thread` })).messages.map(row => row.id), [includedId]);
    assert.equal((await listThreadMessages({ userId, unified: true, threadId: `${excluded}:shared-thread` })).messages.length, 0);
    assert.deepEqual((await listThreadMessages({ userId, threadId: `${excluded}:shared-thread` })).messages.map(row => row.id), [excludedId]);
    assert.equal((await children(excluded)).length, 1);
    assert.equal((await listThreadMessages({ userId, threadId: `${foreign}:shared-thread` })).messages.length, 0);
    await assert.rejects(children(foreign), ThreadAccountNotFoundError);
    await assert.rejects(children(disabled), ThreadAccountNotFoundError);
    assert.deepEqual(await readUnreadInboxCounts(userId), { total: 1, byAccount: { [included]: 1, [excluded]: 1 } });
  });
  it('hides only proven Graph aliases, retaining uncertain, stale, moved, deleted-target and native copies', async () => {
    const accountId = await account('microsoft_graph');
    const canonical = await message(accountId, { providerId: 'canonical', read: true });
    const hidden = await message(accountId);
    await bind(accountId, hidden, canonical);
    const unbound = await message(accountId);
    const uncertain = await message(accountId);
    await bind(accountId, uncertain, canonical, 'needs_review');
    const staleAccount = await account('microsoft_graph');
    const stale = await message(accountId);
    await bind(accountId, stale, canonical, 'bound', connectionIds.get(staleAccount));
    const moved = await message(accountId, { folder: 'Archive' });
    await bind(accountId, moved, canonical);
    const deletedCanonical = await message(accountId, { deleted: true, providerId: 'deleted-canonical' });
    const deletedTargetAlias = await message(accountId);
    await bind(accountId, deletedTargetAlias, deletedCanonical);
    const native = await message(accountId, { providerId: 'another-provider-object' });
    await bind(accountId, native, canonical);
    const expected = [canonical, unbound, uncertain, stale, moved, deletedTargetAlias, native];
    assert.deepEqual(new Set((await children(accountId)).map(row => row.id)), new Set(expected));
    const listed = await listMessages({ userId, accountId, threaded: true });
    assert.equal(listed.messages[0]?.message_count, expected.length);
    assert.equal(listed.messages[0]?.unread_count, 5);
    assert.equal((await readUnreadInboxCounts(userId)).total, 5);
  });
});
