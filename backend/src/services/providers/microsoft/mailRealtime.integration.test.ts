import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { query, withTransaction } from '../../db.js';
import { setupWebSocket } from '../../websocket.js';
import { readUnreadInboxCounts } from '../../unreadInboxCounts.js';
import { MICROSOFT_GRANT_AUDIENCE, MICROSOFT_ISSUER, storeOAuthGrant, upsertProviderConnection } from '../../providerAuthService.js';
import { syncGraphMailFoldersForAccount, syncGraphMailMessagesForAccount } from './graphMailSync.js';

const configured = Boolean(process.env.DB_HOST && process.env.DB_NAME);
if (process.env.REQUIRE_GRAPH_POSTGRES === '1' && !configured) throw new Error('PR14 requires PostgreSQL in the database job');
if (configured && !process.env.DB_NAME?.includes('test')) throw new Error('PR14 requires an isolated TEST database');
const suite = configured ? describe : describe.skip;
const USER = '00000000-0000-0000-0000-00000000fe11';
const ACCOUNT = '00000000-0000-0000-0000-00000000fe12';
const OTHER_USER = '00000000-0000-0000-0000-00000000fe13';
const EXCLUDED = '00000000-0000-0000-0000-00000000fe14';
const CONFIG = { clientId: 'pr14-test', clientSecret: 'fixture', redirectUri: 'https://example.test/cb', providerRedirectUri: 'https://example.test/oauth/provider/microsoft/callback', tenantId: 'common' };
const DELTA = 'https://graph.microsoft.com/v1.0/me/mailFolders/graph-inbox/messages/delta?$deltatoken=pr14';
const keyBefore = process.env.ENCRYPTION_KEY;
let connectionId: string;
let wss: WebSocketServer;
let ownerSocket: WebSocket;
let otherSocket: WebSocket;
let ownerFrames: Array<{ type: string; accountId?: string }> = [];
let otherFrames: Array<{ type: string }> = [];

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
function message(id: string, subject = 'PR14 committed mail') {
  return { id, parentFolderId: 'graph-inbox', subject, internetMessageId: `<${id}@example.test>`,
    conversationId: `thread-${id}`, bodyPreview: 'PR14 preview', receivedDateTime: '2026-09-26T10:00:00Z',
    from: { emailAddress: { address: 'sender@example.test' } }, isRead: false, hasAttachments: false };
}
function provider(messages: unknown[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith('/messages/delta')) return response({ value: messages, '@odata.deltaLink': DELTA });
    if (url.pathname.includes('/me/messages/')) return response(message(decodeURIComponent(url.pathname.split('/').at(-1)!)));
    if (url.pathname.endsWith('/childFolders')) return response({ value: [] });
    if (/\/me\/mailFolders\/[^/]+$/.test(url.pathname)) {
      return url.pathname.endsWith('/inbox') ? response({ id: 'graph-inbox' }) : response({ error: { code: 'ErrorItemNotFound' } }, 404);
    }
    if (url.pathname.endsWith('/mailFolders')) return response({ value: [{ id: 'graph-inbox', displayName: 'Inbox', childFolderCount: 0 }] });
    throw new Error(`Unexpected test Graph URL: ${url.pathname}`);
  }) as typeof fetch;
}
async function waitFor(predicate: () => boolean): Promise<void> {
  const until = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > until) throw new Error('No committed-mail WebSocket event arrived');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

suite('PR14 committed Graph changes reach an authenticated real WebSocket', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
    await query("INSERT INTO users(id,username) VALUES ($1,'pr14-live-fixture') ON CONFLICT(id) DO NOTHING", [USER]);
    wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    let connections = 0;
    setupWebSocket(wss as unknown as Parameters<typeof setupWebSocket>[0], (req, _res, next) => {
      req.session = { userId: connections++ === 0 ? USER : OTHER_USER };
      next();
    }, { connectAllForUser: async () => {} });
    await once(wss, 'listening');
    const address = wss.address();
    if (!address || typeof address === 'string') throw new Error('No test WebSocket port');
    ownerSocket = new WebSocket(`ws://127.0.0.1:${address.port}`);
    ownerSocket.on('message', bytes => ownerFrames.push(JSON.parse(String(bytes))));
    await once(ownerSocket, 'open');
    await waitFor(() => ownerFrames.some(frame => frame.type === 'connected'));
    otherSocket = new WebSocket(`ws://127.0.0.1:${address.port}`);
    otherSocket.on('message', bytes => otherFrames.push(JSON.parse(String(bytes))));
    await once(otherSocket, 'open');
    await waitFor(() => otherFrames.some(frame => frame.type === 'connected'));
  });
  beforeEach(async () => {
    await query('DELETE FROM provider_connections WHERE user_id=$1', [USER]);
    await query('DELETE FROM email_accounts WHERE user_id=$1', [USER]);
    connectionId = await withTransaction(async client => {
      const id = await upsertProviderConnection(client, { userId: USER, provider: 'microsoft', issuer: MICROSOFT_ISSUER, subject: 'pr14-fixture' });
      await storeOAuthGrant(client, { connectionId: id, audience: MICROSOFT_GRANT_AUDIENCE,
        accessToken: 'pr14-access', refreshToken: 'pr14-refresh', expiresAt: new Date(Date.now() + 3600000),
        scopes: ['https://graph.microsoft.com/Mail.ReadWrite'], clientIdAtIssue: CONFIG.clientId });
      await client.query(`INSERT INTO email_accounts(id,user_id,name,email_address,protocol,imap_host,mail_transport,provider_connection_id,enabled)
        VALUES($1,$2,'PR14','pr14@example.test','imap','outlook.office365.com','microsoft_graph',$3,true)`, [ACCOUNT, USER, id]);
      return id;
    });
    await syncGraphMailFoldersForAccount({ userId: USER, accountId: ACCOUNT, connectionId, config: CONFIG, fetchImpl: provider([]) });
    await new Promise(resolve => setTimeout(resolve, 300));
    ownerFrames = []; otherFrames = [];
  });
  afterAll(async () => {
    ownerSocket?.terminate(); otherSocket?.terminate();
    if (wss) await new Promise<void>(resolve => wss.close(() => resolve()));
    await query('ALTER TABLE messages DROP CONSTRAINT IF EXISTS pr14_reject_fixture_message');
    await query('DELETE FROM users WHERE id=$1', [USER]);
    if (keyBefore === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = keyBefore;
  });
  it('publishes only to the owner and the API can read the committed row', async () => {
    const result = await syncGraphMailMessagesForAccount({ userId: USER, accountId: ACCOUNT, connectionId, config: CONFIG, fetchImpl: provider([message('pr14-new')]) });
    expect(result.failedFolders).toBe(0);
    await waitFor(() => ownerFrames.some(frame => frame.type === 'mail_state_changed'));
    const changes = ownerFrames.filter(frame => frame.type === 'mail_state_changed');
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.every(frame => frame.accountId === ACCOUNT)).toBe(true);
    expect(otherFrames).toEqual([]);
    expect((await readUnreadInboxCounts(USER)).total).toBe(1);
    expect((await query('SELECT subject FROM messages WHERE account_id=$1', [ACCOUNT])).rows).toEqual([{ subject: 'PR14 committed mail' }]);
    expect(JSON.stringify(ownerFrames)).not.toContain('sender@example.test');
    expect(JSON.stringify(ownerFrames)).not.toContain('PR14 committed mail');
    expect(ownerFrames.some(frame => frame.type === 'new_messages')).toBe(false);
  });
  it('does not publish a page whose second write rolls the transaction back', async () => {
    await query(`ALTER TABLE messages ADD CONSTRAINT pr14_reject_fixture_message
      CHECK (account_id <> '${ACCOUNT}'::uuid OR subject IS DISTINCT FROM 'reject PR14') NOT VALID`);
    try {
      const result = await syncGraphMailMessagesForAccount({ userId: USER, accountId: ACCOUNT, connectionId, config: CONFIG,
        fetchImpl: provider([message('first'), message('second', 'reject PR14')]) });
      expect(result.failedFolders).toBe(1);
      await new Promise(resolve => setTimeout(resolve, 350));
      expect((await query('SELECT id FROM messages WHERE account_id=$1', [ACCOUNT])).rowCount).toBe(0);
      expect(ownerFrames.filter(frame => frame.type === 'mail_state_changed')).toEqual([]);
    } finally { await query('ALTER TABLE messages DROP CONSTRAINT pr14_reject_fixture_message'); }
  });
  it('signals an external read update without replaying an arrival alert', async () => {
    await syncGraphMailMessagesForAccount({ userId: USER, accountId: ACCOUNT, connectionId, config: CONFIG, fetchImpl: provider([message('read-me')]) });
    await waitFor(() => ownerFrames.some(frame => frame.type === 'mail_state_changed'));
    ownerFrames = [];
    await syncGraphMailMessagesForAccount({ userId: USER, accountId: ACCOUNT, connectionId, config: CONFIG,
      fetchImpl: provider([{ id: 'read-me', isRead: true }]) });
    await waitFor(() => ownerFrames.some(frame => frame.type === 'mail_state_changed'));
    expect((await readUnreadInboxCounts(USER)).total).toBe(0);
    expect(ownerFrames.some(frame => frame.type === 'new_messages')).toBe(false);
  });
  it('matches inbox label membership and excludes archived/deleted/hollow rows and opted-out accounts', async () => {
    await query(`INSERT INTO email_accounts(id,user_id,name,email_address,protocol,imap_host,enabled,include_in_unified_inbox)
      VALUES($1,$2,'Excluded','excluded@example.test','imap','example.test',true,false)`, [EXCLUDED, USER]);
    const values = [
      [1, ACCOUNT, 'INBOX', false, false, 'Inbox'],
      [2, ACCOUNT, 'Work', false, false, 'Label inbox'],
      [3, ACCOUNT, 'INBOX', true, false, 'Archived'],
      [4, ACCOUNT, 'INBOX', false, true, 'Deleted'],
      [5, EXCLUDED, 'INBOX', false, false, 'Opted out'],
    ];
    for (const [uid, account, folder, archived, deleted, subject] of values) {
      const result = await query<{id: string}>(`INSERT INTO messages(account_id,uid,folder,is_archived,is_deleted,subject,is_read)
        VALUES($1,$2,$3,$4,$5,$6,false) RETURNING id`, [account, uid, folder, archived, deleted, subject]);
      if (uid === 2) {
        await query(`INSERT INTO message_labels(message_id,account_id,label_id,folder_path)
          VALUES($1,$2,'INBOX','INBOX'),($1,$2,'another-inbox-label','INBOX')`, [result.rows[0].id, ACCOUNT]);
      }
    }
    await query("INSERT INTO messages(account_id,uid,folder,is_read) VALUES($1,6,'INBOX',false)", [ACCOUNT]);
    expect(await readUnreadInboxCounts(USER)).toEqual({ total: 2, byAccount: { [ACCOUNT]: 2, [EXCLUDED]: 1 } });
    expect(await readUnreadInboxCounts(OTHER_USER)).toEqual({ total: 0, byAccount: {} });
  });
});
