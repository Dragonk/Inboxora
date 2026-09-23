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
import { repairExistingGraphLegacyMessageBindings } from '../services/providers/microsoft/graphLegacyMessageBindingRepair.js';
import mailRoutes from './mail.js';
import { listeningPort } from '../test/net.js';

const hasPg = process.env.DB_HOST && process.env.DB_NAME;
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
});
