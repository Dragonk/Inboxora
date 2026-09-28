// LIVE-01: this is deliberately an HTTP-route + PostgreSQL test. A legacy UUID must
// remain readable after Graph sync creates its separate native copy and records a
// verified binding; the provider is faked only at its HTTP boundary.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import express from 'express';
import type { PoolClient } from 'pg';
import type { Server } from 'node:http';

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: { session?: { userId?: string } }, _res: unknown, next: () => void) => {
    req.session = { userId: USER_ID };
    next();
  },
}));
vi.mock('../index.js', () => ({
  imapManager: {
    noteUserActivity: vi.fn(), fetchMessageBody: vi.fn(), fetchAttachment: vi.fn(), broadcast: vi.fn(),
    prefetchFolderBodies: vi.fn(async () => undefined),
    setFlag: vi.fn(), _resolveFlagPush: vi.fn(), _enqueueFlagPush: vi.fn(), pluginFacade: {},
  },
}));
vi.mock('../services/providerAuthService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../services/providerAuthService.js')>()),
  microsoftConfigFromEnv: () => ({ clientId: 'client-1', clientSecret: 'secret-1', redirectUri: 'https://inboxora.test/callback', tenantId: 'common' }),
}));

import { pool } from '../services/db.js';
import { MICROSOFT_GRANT_AUDIENCE, MICROSOFT_ISSUER, storeOAuthGrant, upsertProviderConnection } from '../services/providerAuthService.js';
import { applyGraphMailMessagesPage } from '../services/providers/microsoft/graphMailSync.js';
import { bindVerifiedLegacyGraphMessage } from '../services/providers/microsoft/graphLegacyMessageBindings.js';
import { repairExistingGraphLegacyMessageBindings } from '../services/providers/microsoft/graphLegacyMessageBindingRepair.js';
import mailRoutes from './mail.js';
import { listeningPort } from '../test/net.js';

const hasPg = process.env.DB_HOST && process.env.DB_NAME;
if (hasPg && !process.env.DB_NAME?.includes('test')) throw new Error('Graph identity route tests require an isolated test database');
const describeOrSkip = hasPg ? describe : describe.skip;
const USER_ID = '00000000-0000-0000-0000-00000000l101'.replace('l', '1');
const ACCOUNT_ID = '00000000-0000-0000-0000-00000000a101';
const LEGACY_ID = '00000000-0000-0000-0000-00000000b101';
const GRAPH_ID = 'AAMkAD-legacy-bound-1';
const originalKey = process.env.ENCRYPTION_KEY;
const nativeFetch = globalThis.fetch;

async function autocommit<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { return await fn(client); } finally { client.release(); }
}

async function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

let server: Server;
let base = '';

// This suite shares a database with other integration suites, so it owns only its
// UUID namespace and removes it through the users FK after each run.
describeOrSkip('LIVE-01 legacy Graph identity route (PostgreSQL)', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    const app = express();
    app.use(express.json());
    app.use('/api/mail', mailRoutes);
    await new Promise<void>(resolve => { server = app.listen(0, () => resolve()); });
    base = `http://127.0.0.1:${listeningPort(server)}`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (originalKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = originalKey;
  });

  beforeEach(async () => {
    await autocommit(client => client.query('DELETE FROM users WHERE id = $1', [USER_ID]));
    await autocommit(client => client.query(
      `INSERT INTO users (id, username) VALUES ($1, 'live-01-graph-user')`, [USER_ID],
    ));
  });

  it('binds one verified legacy UUID to its Graph row and serves the Graph body through that UUID', async () => {
    const connectionId = await autocommit(async client => {
      const id = await upsertProviderConnection(client, {
        userId: USER_ID, provider: 'microsoft', issuer: MICROSOFT_ISSUER, subject: 'live-01-subject', providerUserId: 'live-01@contoso.test',
      });
      await storeOAuthGrant(client, {
        connectionId: id, audience: MICROSOFT_GRANT_AUDIENCE, accessToken: 'access-valid', refreshToken: 'refresh-valid',
        expiresAt: new Date(Date.now() + 3_600_000), scopes: ['https://graph.microsoft.com/Mail.Read'], clientIdAtIssue: 'client-1',
      });
      await client.query(
        `INSERT INTO email_accounts
           (id, user_id, name, email_address, protocol, imap_host, mail_transport, provider_connection_id, migration_state)
         VALUES ($1, $2, 'Live Graph', 'live-01@contoso.test', 'imap', 'outlook.office365.com', 'microsoft_graph', $3, 'active_native')`,
        [ACCOUNT_ID, USER_ID, id],
      );
      await client.query(
        `INSERT INTO messages (id, account_id, uid, folder, message_id, from_email, date, subject, is_read)
         VALUES ($1, $2, 42, 'INBOX', '<live-01@example.test>', 'sender@example.test', $3::timestamptz, 'legacy copy', false)`,
        [LEGACY_ID, ACCOUNT_ID, '2026-09-23T10:00:00Z'],
      );
      return id;
    });

    await inTransaction(client => applyGraphMailMessagesPage(client, {
      userId: USER_ID, accountId: ACCOUNT_ID, connectionId, folderPath: 'INBOX',
    }, [{
      id: GRAPH_ID, internetMessageId: '<live-01@example.test>', conversationId: 'conversation-1', subject: 'native copy',
      from: { emailAddress: { address: 'sender@example.test', name: 'Sender' } },
      receivedDateTime: '2026-09-23T10:00:00Z', isRead: false, flag: { flagStatus: 'notFlagged' },
    }]));

    const binding = await autocommit(client => client.query<{ canonical_message_id: string; provider_message_id: string }>(
      `SELECT b.canonical_message_id, m.provider_message_id
         FROM graph_legacy_message_bindings b JOIN messages m ON m.id = b.canonical_message_id
        WHERE b.legacy_message_id = $1 AND b.account_id = $2 AND b.connection_id = $3 AND b.status = 'bound'`,
      [LEGACY_ID, ACCOUNT_ID, connectionId],
    ));
    expect(binding.rows).toEqual([{ canonical_message_id: expect.any(String), provider_message_id: GRAPH_ID }]);

    const providerUrls: string[] = [];
    vi.stubGlobal('fetch', (async (input: string | URL | Request) => {
      const url = String(input);
      if (!url.startsWith('https://graph.microsoft.com/')) return nativeFetch(input);
      providerUrls.push(url);
      if (url.includes('/attachments')) return new Response(JSON.stringify({ value: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ body: { contentType: 'text', content: 'body via legacy UUID' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch);
    try {
      const response = await nativeFetch(`${base}/api/mail/messages/${LEGACY_ID}/body`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ text: 'body via legacy UUID', html: null, attachments: [] });
      expect(providerUrls).toHaveLength(2);
      expect(providerUrls.every(url => url.includes(encodeURIComponent(GRAPH_ID)))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('fails closed for two verified legacy candidates instead of binding either one', async () => {
    const connectionId = await autocommit(async client => {
      const id = await upsertProviderConnection(client, {
        userId: USER_ID, provider: 'microsoft', issuer: MICROSOFT_ISSUER, subject: 'live-01-ambiguous', providerUserId: 'live-01@contoso.test',
      });
      await client.query(
        `INSERT INTO email_accounts
           (id, user_id, name, email_address, protocol, imap_host, mail_transport, provider_connection_id, migration_state)
         VALUES ($1, $2, 'Live Graph', 'live-01@contoso.test', 'imap', 'outlook.office365.com', 'microsoft_graph', $3, 'active_native')`,
        [ACCOUNT_ID, USER_ID, id],
      );
      for (const [idValue, uid] of [[LEGACY_ID, 42], ['00000000-0000-0000-0000-00000000b102', 43]] as const) {
        await client.query(
          `INSERT INTO messages (id, account_id, uid, folder, message_id, from_email, date, subject, is_read)
           VALUES ($1, $2, $3, 'INBOX', '<live-01@example.test>', 'sender@example.test', $4::timestamptz, 'legacy copy', false)`,
          [idValue, ACCOUNT_ID, uid, '2026-09-23T10:00:00Z'],
        );
      }
      return id;
    });

    await inTransaction(client => applyGraphMailMessagesPage(client, {
      userId: USER_ID, accountId: ACCOUNT_ID, connectionId, folderPath: 'INBOX',
    }, [{
      id: GRAPH_ID, internetMessageId: '<live-01@example.test>', from: { emailAddress: { address: 'sender@example.test' } },
      receivedDateTime: '2026-09-23T10:00:00Z', isRead: false,
    }]));

    const bindings = await autocommit(client => client.query<{ legacy_message_id: string; status: string }>(
      'SELECT legacy_message_id, status FROM graph_legacy_message_bindings WHERE account_id = $1 ORDER BY legacy_message_id', [ACCOUNT_ID],
    ));
    // Ambiguity is durable review work, never an arbitrary canonical binding.
    expect(bindings.rows).toEqual([
      { legacy_message_id: LEGACY_ID, status: 'needs_review' },
      { legacy_message_id: '00000000-0000-0000-0000-00000000b102', status: 'needs_review' },
    ]);
    const response = await nativeFetch(`${base}/api/mail/messages/${LEGACY_ID}/body`);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'MESSAGE_BINDING_AMBIGUOUS' });
  });

  it('repairs an existing legacy/native cache pair without a new delta item, then serves its old UUID', async () => {
    const connectionId = await autocommit(async client => {
      const id = await upsertProviderConnection(client, { userId: USER_ID, provider: 'microsoft', issuer: MICROSOFT_ISSUER, subject: 'live-01-cache', providerUserId: 'live-01@contoso.test' });
      await storeOAuthGrant(client, { connectionId: id, audience: MICROSOFT_GRANT_AUDIENCE, accessToken: 'access-valid', refreshToken: 'refresh-valid', expiresAt: new Date(Date.now() + 3_600_000), scopes: ['https://graph.microsoft.com/Mail.Read'], clientIdAtIssue: 'client-1' });
      await client.query(`INSERT INTO email_accounts (id, user_id, name, email_address, protocol, imap_host, mail_transport, provider_connection_id, migration_state) VALUES ($1,$2,'Live Graph','live-01@contoso.test','imap','outlook.office365.com','microsoft_graph',$3,'active_native')`, [ACCOUNT_ID, USER_ID, id]);
      await client.query(`INSERT INTO messages (id, account_id, uid, folder, message_id, from_email, date, subject, is_read) VALUES ($1,$2,42,'INBOX','<cache@example.test>','sender@example.test',$3::timestamptz,'legacy',true)`, [LEGACY_ID, ACCOUNT_ID, '2026-09-23T11:00:00Z']);
      await client.query(`INSERT INTO messages (id, account_id, uid, folder, provider_message_id, message_id, from_email, date, subject, is_read) VALUES ('00000000-0000-0000-0000-00000000c101',$1,43,'INBOX',$2,'<cache@example.test>','sender@example.test',$3::timestamptz,'native',false)`, [ACCOUNT_ID, GRAPH_ID, '2026-09-23T11:00:00Z']);
      return id;
    });
    const repair = await inTransaction(client => repairExistingGraphLegacyMessageBindings(client, { userId: USER_ID, accountId: ACCOUNT_ID, connectionId, limit: 1 }));
    expect(repair).toMatchObject({ bound: 1, failed: 0, checkpoint: LEGACY_ID });
    vi.stubGlobal('fetch', (async (input: string | URL | Request) => {
      const url = String(input);
      if (!url.startsWith('https://graph.microsoft.com/')) return nativeFetch(input);
      return new Response(JSON.stringify(url.includes('/attachments') ? { value: [] } : { body: { contentType: 'text', content: 'recovered cache body' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch);
    try {
      const response = await nativeFetch(`${base}/api/mail/messages/${LEGACY_ID}/body`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ text: 'recovered cache body' });
    } finally { vi.unstubAllGlobals(); }
  });

  interface MailReadReply {
    messages: Array<{ id: string; is_read: boolean; message_count?: number; unread_count?: number }>;
    total: number;
  }
  interface UnreadReply { total: number; byAccount: Record<string, number> }
  // The assertions below validate each endpoint's concrete success contract.
  async function readJson<T>(response: Response): Promise<T> {
    expect(response.status).toBe(200);
    return await response.json() as T;
  }

  async function seedReadAliases(nativeUnread: number, legacyUnread: boolean) {
    const connectionId = await autocommit(client => upsertProviderConnection(client, {
      userId: USER_ID, provider: 'microsoft', issuer: MICROSOFT_ISSUER, subject: 'read-alias-consistency',
    }));
    await autocommit(client => client.query(
      `INSERT INTO email_accounts(id,user_id,name,email_address,protocol,mail_transport,provider_connection_id,migration_state)
       VALUES($1,$2,'Read consistency','read-consistency@example.test','imap','microsoft_graph',$3,'active_native')`,
      [ACCOUNT_ID, USER_ID, connectionId],
    ));
    const canonical: string[] = [], legacy: string[] = [];
    const threadId = 'read-alias-thread';
    for (let n = 0; n < 17; n++) {
      const id = crypto.randomUUID(); canonical.push(id);
      const date = new Date(Date.UTC(2026, 8, 27, 10, n)).toISOString();
      const rfc = `<read-alias-${n}@example.test>`;
      if (n < 4) {
        const alias = crypto.randomUUID(); legacy.push(alias);
        await autocommit(client => client.query(
          `INSERT INTO messages(id,account_id,uid,folder,message_id,from_email,date,subject,is_read,thread_id)
           VALUES($1,$2,$3,'INBOX',$4,'sender@example.test',$5,'Read consistency',$6,$7)`,
          [alias, ACCOUNT_ID, n + 1, rfc, date, !legacyUnread, threadId],
        ));
      }
      await autocommit(client => client.query(
        `INSERT INTO messages(id,account_id,uid,folder,message_id,from_email,date,subject,is_read,thread_id,provider_message_id)
         VALUES($1,$2,$3,'INBOX',$4,'sender@example.test',$5,'Read consistency',$6,$7,$8)`,
        [id, ACCOUNT_ID, n + 1001, rfc, date, n >= nativeUnread, threadId, `graph-read-alias-${n}`],
      ));
      if (n < 4) expect(await autocommit(client => bindVerifiedLegacyGraphMessage(client, {
        accountId: ACCOUNT_ID, connectionId, canonicalMessageId: id, providerMessageId: `graph-read-alias-${n}`,
        rfcMessageId: rfc, fromEmail: 'sender@example.test', date,
      }))).toBe('bound');
    }
    return { connectionId, canonical, legacy, threadId };
  }

  it('does not count four stale unread legacy aliases when all 17 verified native messages are read', async () => {
    const { canonical, legacy, threadId } = await seedReadAliases(0, true);
    const counts = await nativeFetch(`${base}/api/mail/unread-counts`).then(readJson<UnreadReply>);
    expect(counts).toEqual({ total: 0, byAccount: {} });
    const categories = await nativeFetch(`${base}/api/mail/category-counts?accountId=${ACCOUNT_ID}`).then(readJson<{ counts: Record<string, number> }>);
    expect(categories.counts).toEqual({ primary: 0 });
    const filtered = await nativeFetch(`${base}/api/mail/messages?accountId=${ACCOUNT_ID}&threaded=true&unreadOnly=true`).then(readJson<MailReadReply>);
    expect(filtered.messages).toEqual([]);
    const flat = await nativeFetch(`${base}/api/mail/messages?accountId=${ACCOUNT_ID}`).then(readJson<MailReadReply>);
    expect(flat.total).toBe(17);
    expect(flat.messages.map((m: { id: string }) => m.id).sort()).toEqual([...canonical].sort());
    const thread = await nativeFetch(`${base}/api/mail/thread/${threadId}?accountId=${ACCOUNT_ID}`).then(readJson<MailReadReply>);
    expect(thread.messages).toHaveLength(17);
    expect(thread.messages.every((m: { is_read: boolean }) => m.is_read)).toBe(true);
    expect(thread.messages.map((m: { id: string }) => m.id).sort()).toEqual([...canonical].sort());
    // Projection does not delete recovery rows or invalidate old UUID links.
    const retained = await autocommit(client => client.query('SELECT id FROM messages WHERE id=ANY($1::uuid[]) AND is_deleted=false', [legacy]));
    expect(retained.rows).toHaveLength(4);
  });

  it('expands the four genuinely unread native messages rather than their already-read aliases', async () => {
    const { canonical, threadId } = await seedReadAliases(4, false);
    const filtered = await nativeFetch(`${base}/api/mail/messages?accountId=${ACCOUNT_ID}&threaded=true&unreadOnly=true`).then(readJson<MailReadReply>);
    expect(filtered.messages).toHaveLength(1);
    expect(filtered.messages[0]).toMatchObject({ message_count: 17, unread_count: 4 });
    const thread = await nativeFetch(`${base}/api/mail/thread/${threadId}?accountId=${ACCOUNT_ID}`).then(readJson<MailReadReply>);
    expect(thread.messages.filter((m: { is_read: boolean }) => !m.is_read).map((m: { id: string }) => m.id).sort()).toEqual(canonical.slice(0, 4).sort());
    expect(thread.messages.map((m: { id: string }) => m.id).sort()).toEqual([...canonical].sort());
  });


  it.each([
    ['ambiguous binding', "UPDATE graph_legacy_message_bindings SET status='needs_review' WHERE account_id=$1"],
    ['no verified binding', 'DELETE FROM graph_legacy_message_bindings WHERE account_id=$1'],
    ['changed connection', "UPDATE email_accounts SET provider_connection_id=NULL WHERE id=$1"],
    ['IMAP fallback', "UPDATE email_accounts SET mail_transport='imap_smtp' WHERE id=$1"],
    ['deleted canonical', "UPDATE messages SET is_deleted=true WHERE account_id=$1 AND provider_message_id IS NOT NULL"],
    ['missing provider identity', "UPDATE messages SET provider_message_id=NULL WHERE account_id=$1"],
    ['unconfirmed folder change', "UPDATE messages SET folder='Archive' WHERE account_id=$1 AND provider_message_id IS NOT NULL"],
  ])('retains legacy recovery rows for %s', async (_name, sql) => {
    const { legacy } = await seedReadAliases(0, true);
    await autocommit(client => client.query(sql, [ACCOUNT_ID]));
    const flat = await nativeFetch(`${base}/api/mail/messages?accountId=${ACCOUNT_ID}`).then(readJson<MailReadReply>);
    const visible = new Set(flat.messages.map((m: { id: string }) => m.id));
    expect(legacy.every(id => visible.has(id))).toBe(true);
    const counts = await nativeFetch(`${base}/api/mail/unread-counts`).then(readJson<UnreadReply>);
    expect(counts).toEqual({ total: 4, byAccount: { [ACCOUNT_ID]: 4 } });
  });

  it('a verified provider move does not resurrect old inbox aliases or their old thread bucket', async () => {
    const { canonical, legacy, threadId } = await seedReadAliases(0, true);
    await autocommit(client => client.query("UPDATE messages SET folder='Archive', thread_id='moved-thread' WHERE account_id=$1 AND provider_message_id IS NOT NULL", [ACCOUNT_ID]));
    await autocommit(client => client.query("UPDATE graph_legacy_message_bindings SET evidence=jsonb_build_object('kind','confirmed_provider_move') WHERE account_id=$1", [ACCOUNT_ID]));
    const inbox = await nativeFetch(`${base}/api/mail/messages?accountId=${ACCOUNT_ID}&threaded=true`).then(readJson<MailReadReply>);
    expect(inbox).toMatchObject({ messages: [], total: 0 });
    const counts = await nativeFetch(`${base}/api/mail/unread-counts`).then(readJson<UnreadReply>);
    expect(counts.total).toBe(0);
    const oldThread = await nativeFetch(`${base}/api/mail/thread/${threadId}?accountId=${ACCOUNT_ID}`).then(readJson<MailReadReply>);
    expect(oldThread.messages).toEqual([]);
    const archive = await nativeFetch(`${base}/api/mail/messages?accountId=${ACCOUNT_ID}&folder=Archive&threaded=true`).then(readJson<MailReadReply>);
    expect(archive.messages).toHaveLength(1);
    expect(archive.messages[0]).toMatchObject({ message_count: 17, unread_count: 0 });
    const moved = await nativeFetch(`${base}/api/mail/thread/moved-thread?accountId=${ACCOUNT_ID}`).then(readJson<MailReadReply>);
    expect(moved.messages.map((m: { id: string }) => m.id).sort()).toEqual([...canonical].sort());
    const retained = await autocommit(client => client.query('SELECT id FROM messages WHERE id=ANY($1::uuid[]) AND is_deleted=false', [legacy]));
    expect(retained.rows).toHaveLength(4);
  });


  it('reads and unreads the 17 canonical thread IDs through HTTP and the Graph write boundary', async () => {
    const { connectionId, canonical, threadId } = await seedReadAliases(4, false);
    await autocommit(client => storeOAuthGrant(client, {
      connectionId, audience: MICROSOFT_GRANT_AUDIENCE, accessToken: 'access-valid', refreshToken: 'refresh-valid',
      expiresAt: new Date(Date.now() + 3_600_000), scopes: ['https://graph.microsoft.com/Mail.ReadWrite'], clientIdAtIssue: 'client-1',
    }));
    const writes: Array<{ providerId: string; read: boolean }> = [];
    vi.stubGlobal('fetch', (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith('https://graph.microsoft.com/')) return nativeFetch(input, init);
      expect(init?.method).toBe('PATCH');
      const body = JSON.parse(String(init?.body));
      expect(typeof body.isRead).toBe('boolean');
      writes.push({ providerId: decodeURIComponent(new URL(url).pathname.split('/').at(-1)!), read: body.isRead });
      return new Response(null, { status: 204 });
    }) as typeof fetch);
    try {
      for (const [index, read] of [true, false, true].entries()) {
        writes.length = 0;
        const response = await nativeFetch(`${base}/api/mail/messages/bulk-read`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: canonical, read }),
        });
        expect(response.status).toBe(200);
        const result = await readJson<{ updated: string[] }>(response);
        const expectedIds = index === 0 ? canonical.slice(0, 4) : canonical;
        expect([...result.updated].sort()).toEqual([...expectedIds].sort());
        expect(writes).toHaveLength(expectedIds.length);
        expect(writes.map(write => write.providerId).sort()).toEqual(
          expectedIds.map(id => `graph-read-alias-${canonical.indexOf(id)}`).sort(),
        );
        expect(writes.every(write => write.read === read)).toBe(true);
        const counts = await nativeFetch(`${base}/api/mail/unread-counts`).then(readJson<UnreadReply>);
        expect(counts.total).toBe(read ? 0 : 17);
        const categories = await nativeFetch(`${base}/api/mail/category-counts?accountId=${ACCOUNT_ID}`).then(readJson<{ counts: Record<string, number> }>);
        expect(categories.counts).toEqual({ primary: read ? 0 : 17 });
        const thread = await nativeFetch(`${base}/api/mail/thread/${threadId}?accountId=${ACCOUNT_ID}`).then(readJson<MailReadReply>);
        expect(thread.messages).toHaveLength(17);
        expect(thread.messages.every((m: { is_read: boolean }) => m.is_read === read)).toBe(true);
        const filtered = await nativeFetch(`${base}/api/mail/messages?accountId=${ACCOUNT_ID}&threaded=true&unreadOnly=true`).then(readJson<MailReadReply>);
        expect(filtered.messages).toHaveLength(read ? 0 : 1);
      }
    } finally { vi.unstubAllGlobals(); }
  });


  it('never substitutes a bound canonical row from a different account', async () => {
    const { canonical, legacy, connectionId } = await seedReadAliases(0, true);
    const otherAccount = crypto.randomUUID();
    await autocommit(client => client.query(
      `INSERT INTO email_accounts(id,user_id,name,email_address,protocol,mail_transport,provider_connection_id)
       VALUES($1,$2,'Other identity','other@example.test','imap','microsoft_graph',$3)`, [otherAccount, USER_ID, connectionId],
    ));
    // Simulate inconsistent legacy binding data: its pointer must not be trusted
    // across accounts merely because the canonical UUID exists.
    await autocommit(client => client.query('UPDATE messages SET account_id=$1 WHERE id=ANY($2::uuid[])', [otherAccount, canonical]));
    const flat = await nativeFetch(`${base}/api/mail/messages?accountId=${ACCOUNT_ID}`).then(readJson<MailReadReply>);
    expect(flat.messages.map((m: { id: string }) => m.id).sort()).toEqual([...legacy].sort());
    const counts = await nativeFetch(`${base}/api/mail/unread-counts`).then(readJson<UnreadReply>);
    expect(counts.byAccount[ACCOUNT_ID]).toBe(4);
  });

});
