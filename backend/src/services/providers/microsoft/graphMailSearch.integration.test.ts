// Real PostgreSQL tests for Microsoft Graph provider-side mail search (P07b).
//
// The provider is faked at the HTTP boundary (the folder tree and the search page);
// the ingest is real: folder discovery runs when the account has none, the hits are
// projected through the sync's own upsert, the conversation engine groups them and a
// repeated search is a no-op. That is what makes this a test of the landing rule and
// not only of a mapper.
//
// Run with:
//   DB_HOST=127.0.0.1 DB_PORT=55432 DB_NAME=inboxora_search_gate \
//     DB_USER=mailflow_test DB_PASSWORD=mailflow_test \
//     npx vitest run src/services/providers/microsoft/graphMailSearch.integration.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { pool } from '../../db.js';
import {
  MICROSOFT_GRANT_AUDIENCE,
  MICROSOFT_ISSUER,
  storeOAuthGrant,
  upsertProviderConnection,
} from '../../providerAuthService.js';
import { ingestGraphMailSearch } from './graphMailSearch.js';

const hasPg = process.env.DB_HOST && process.env.DB_NAME;
const describeOrSkip = hasPg ? describe : describe.skip;

const USER_ID = '00000000-0000-0000-0000-0000000004c1';
const ACCOUNT_ID = '00000000-0000-0000-0000-0000000004c2';
const CONFIG = { clientId: 'client-1', clientSecret: 'secret-1', redirectUri: 'https://x/cb', providerRedirectUri: 'https://x/oauth/provider/microsoft/callback', tenantId: 'common' };
const originalKey = process.env.ENCRYPTION_KEY;

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body } as Response;
}

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
  } finally {
    client.release();
  }
}

async function seedConnection(): Promise<string> {
  return inTransaction(async client => {
    const connectionId = await upsertProviderConnection(client, {
      userId: USER_ID, provider: 'microsoft', issuer: MICROSOFT_ISSUER, subject: 'ms-sub-search',
    });
    await storeOAuthGrant(client, {
      connectionId,
      audience: MICROSOFT_GRANT_AUDIENCE,
      accessToken: 'graph-access-valid',
      refreshToken: 'graph-refresh-1',
      expiresAt: new Date(Date.now() + 3600_000),
      scopes: ['https://graph.microsoft.com/Mail.ReadWrite'],
      clientIdAtIssue: CONFIG.clientId,
    });
    await client.query(
      `INSERT INTO email_accounts (id, user_id, name, email_address, protocol, imap_host, mail_transport, provider_connection_id)
       VALUES ($1, $2, 'Outlook', 'sam@contoso.test', 'imap', 'outlook.office365.com', 'microsoft_graph', $3)
       ON CONFLICT (id) DO UPDATE SET provider_connection_id = EXCLUDED.provider_connection_id, mail_transport = 'microsoft_graph'`,
      [ACCOUNT_ID, USER_ID, connectionId],
    );
    return connectionId;
  });
}

/** One root folder with one child, so a hit can prove it landed in the right path. */
const TREE = {
  value: [{ id: 'graph-inbox', displayName: 'Inbox', wellKnownName: 'inbox', childFolderCount: 1 }],
};
const CHILDREN = {
  value: [{ id: 'graph-work', displayName: 'Work', parentFolderId: 'graph-inbox', childFolderCount: 0 }],
};

/** Serve the folder tree once, then a scripted sequence of `/me/messages?$search=` pages. */
function fakeSearchProvider(searchPages: unknown[]) {
  const urls: string[] = [];
  const pages = [...searchPages];
  const fetchImpl = async (url: string): Promise<Response> => {
    const target = String(url);
    urls.push(target);
    if (target.includes('/childFolders')) return json(CHILDREN);
    if (target.includes('/me/messages')) return json(pages.shift() ?? { value: [] });
    return json(TREE);
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, urls };
}

function graphMessage(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    internetMessageId: `<${id}@contoso.test>`,
    conversationId: `conv-${id}`,
    subject: `Subject ${id}`,
    bodyPreview: `Preview ${id}`,
    receivedDateTime: '2026-03-04T09:15:00Z',
    isRead: false,
    flag: { flagStatus: 'notFlagged' },
    from: { emailAddress: { name: 'Ada Lovelace', address: 'ada@contoso.test' } },
    toRecipients: [{ emailAddress: { address: 'sam@contoso.test' } }],
    ccRecipients: [],
    replyTo: [],
    parentFolderId: 'graph-inbox',
    ...overrides,
  };
}

async function storedMessages(): Promise<Array<{ provider_message_id: string | null; folder: string; thread_id: string | null }>> {
  const result = await autocommit(client => client.query<{ provider_message_id: string | null; folder: string; thread_id: string | null }>(
    'SELECT provider_message_id, folder, thread_id FROM messages WHERE account_id = $1 ORDER BY provider_message_id',
    [ACCOUNT_ID],
  ));
  return result.rows;
}

describeOrSkip('Microsoft Graph provider-side mail search (PostgreSQL)', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    await autocommit(client => client.query(
      `INSERT INTO users (id, username) VALUES ($1, 'graph-mail-search-user') ON CONFLICT (id) DO NOTHING`,
      [USER_ID],
    ));
  });

  afterAll(async () => {
    await autocommit(client => client.query('DELETE FROM users WHERE id = $1', [USER_ID]));
    if (originalKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = originalKey;
  });

  beforeEach(async () => {
    await autocommit(async client => {
      await client.query('DELETE FROM provider_connections WHERE user_id = $1', [USER_ID]);
      await client.query('DELETE FROM email_accounts WHERE user_id = $1', [USER_ID]);
    });
  });

  it('discovers the folders, then lands a hit in its resolved folder and thread', async () => {
    const connectionId = await seedConnection();
    const provider = fakeSearchProvider([{
      value: [
        graphMessage('s-1', { parentFolderId: 'graph-inbox', conversationId: 'conv-search' }),
        graphMessage('s-2', { parentFolderId: 'graph-work', conversationId: 'conv-search' }),
      ],
    }]);

    // No folders are discovered for this account yet: the ingest has to do that first,
    // because a hit names its folder by Graph id while the local row stores a path.
    const result = await ingestGraphMailSearch({
      userId: USER_ID, connectionId, accountId: ACCOUNT_ID, query: 'quarterly', config: CONFIG, fetchImpl: provider.fetchImpl,
    });

    expect(result).toMatchObject({ accountId: ACCOUNT_ID, hits: 2, created: 2, updated: 0, skipped: 0, unresolvedFolders: 0 });
    expect(await storedMessages()).toEqual([
      { provider_message_id: 's-1', folder: 'INBOX', thread_id: 'conv-search' },
      { provider_message_id: 's-2', folder: 'INBOX/Work', thread_id: 'conv-search' },
    ]);

    // The post-commit conversation projection ran: the provider thread id is stored and
    // the engine grouped the two hits into one conversation.
    const threads = await autocommit(client => client.query<{ provider_thread_id: string | null }>(
      'SELECT DISTINCT provider_thread_id FROM messages WHERE account_id = $1', [ACCOUNT_ID],
    ));
    expect(threads.rows.map(row => row.provider_thread_id)).toEqual(['conv-search']);
    const conversations = await autocommit(client => client.query<{ copy_count: number }>(
      'SELECT copy_count FROM conversations WHERE account_id = $1', [ACCOUNT_ID],
    ));
    expect(conversations.rows.map(row => Number(row.copy_count))).toEqual([2]);

    // The search asks the provider endpoint with the message sync's own shape, not a
    // second one, and the query is a quoted KQL literal.
    const searchUrl = new URL(provider.urls.find(url => url.includes('/me/messages')) ?? '');
    expect(searchUrl.pathname).toBe('/v1.0/me/messages');
    expect(searchUrl.searchParams.get('$search')).toBe('"quarterly"');
    expect(searchUrl.searchParams.get('$select')).toContain('conversationId');

    // Search is not a sync: it must not create a message delta cursor, so a later sync
    // still resumes from the cursor it stored rather than from a state search invented.
    const cursors = await autocommit(client => client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM sync_states WHERE user_id = $1 AND coverage = 'messages'", [USER_ID],
    ));
    expect(cursors.rows[0]?.count).toBe('0');
  });

  it('escapes the search literal at the request boundary', async () => {
    const connectionId = await seedConnection();
    const provider = fakeSearchProvider([{ value: [] }]);

    await ingestGraphMailSearch({
      userId: USER_ID, connectionId, accountId: ACCOUNT_ID, query: 'say "hi"', config: CONFIG, fetchImpl: provider.fetchImpl,
    });

    const searchUrl = new URL(provider.urls.find(url => url.includes('/me/messages')) ?? '');
    expect(searchUrl.searchParams.get('$search')).toBe('"say \\"hi\\""');
  });

  it('does not duplicate a hit when the same search runs twice', async () => {
    const connectionId = await seedConnection();
    const page = { value: [graphMessage('s-1'), graphMessage('s-2', { parentFolderId: 'graph-work' })] };
    await ingestGraphMailSearch({
      userId: USER_ID, connectionId, accountId: ACCOUNT_ID, query: 'quarterly', config: CONFIG,
      fetchImpl: fakeSearchProvider([page]).fetchImpl,
    });
    const first = await storedMessages();
    expect(first).toHaveLength(2);

    const second = await ingestGraphMailSearch({
      userId: USER_ID, connectionId, accountId: ACCOUNT_ID, query: 'quarterly', config: CONFIG,
      fetchImpl: fakeSearchProvider([page]).fetchImpl,
    });

    expect(second).toMatchObject({ hits: 2, created: 0, updated: 2, skipped: 0 });
    expect(await storedMessages()).toEqual(first);
  });

  it('skips and counts a hit whose folder cannot be resolved to a local path', async () => {
    const connectionId = await seedConnection();
    const provider = fakeSearchProvider([{
      value: [
        graphMessage('s-1'),
        graphMessage('s-lost', { parentFolderId: 'graph-never-discovered' }),
      ],
    }]);

    const result = await ingestGraphMailSearch({
      userId: USER_ID, connectionId, accountId: ACCOUNT_ID, query: 'quarterly', config: CONFIG, fetchImpl: provider.fetchImpl,
    });

    expect(result).toMatchObject({ hits: 2, created: 1, skipped: 1, unresolvedFolders: 1 });
    // The resolvable hit landed; the one naming an unknown folder was not guessed into one.
    expect(await storedMessages()).toEqual([
      { provider_message_id: 's-1', folder: 'INBOX', thread_id: 'conv-s-1' },
    ]);
  });

  it('counts a hit Graph returned without an id as skipped, not as a row', async () => {
    const connectionId = await seedConnection();
    const provider = fakeSearchProvider([{ value: [{ subject: 'no id', parentFolderId: 'graph-inbox' }] }]);

    const result = await ingestGraphMailSearch({
      userId: USER_ID, connectionId, accountId: ACCOUNT_ID, query: 'quarterly', config: CONFIG, fetchImpl: provider.fetchImpl,
    });

    expect(result).toMatchObject({ hits: 1, created: 0, skipped: 1, unresolvedFolders: 0 });
    expect(await storedMessages()).toEqual([]);
  });
});
