// Real PostgreSQL tests for Microsoft Graph mail folder discovery (P07b). The
// provider is faked at the HTTP boundary; the folder projection, the collection
// link, the lease and the sync-state bookkeeping are real.
//
// Run with:
//   DB_HOST=localhost DB_PORT=5432 DB_NAME=mailflow_test DB_USER=… DB_PASSWORD=… \
//     npx vitest run src/services/providers/microsoft/graphMailSync.integration.test.ts

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
import { acquireSyncLease, ensureSyncState } from '../../syncCoordinator.js';
import { graphFolderIdForPath, syncGraphMailFolders, syncGraphMailFoldersForAccount, syncGraphMailMessagesForAccount } from './graphMailSync.js';
import { graphFlagIntent } from './graphMailMutations.js';

const hasPg = process.env.DB_HOST && process.env.DB_NAME;
const describeOrSkip = hasPg ? describe : describe.skip;

const USER_ID = '00000000-0000-0000-0000-0000000004b1';
const ACCOUNT_ID = '00000000-0000-0000-0000-0000000004b2';
const CONFIG = { clientId: 'client-1', clientSecret: 'secret-1', redirectUri: 'https://x/cb', providerRedirectUri: 'https://x/oauth/provider/microsoft/callback', tenantId: 'common' };
const originalKey = process.env.ENCRYPTION_KEY;

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body } as Response;
}

/**
 * A single-page folder tree, served for every folder request in a run.
 *
 * The fixtures carry `wellKnownName` to say which folder plays which role, but v1.0 does not return that
 * property (GRAPH-01) — the adapter resolves each role from `GET /me/mailFolders/{alias}` instead. The fake
 * therefore answers those alias requests from the fixture and serves the positional pages only for the listing
 * and `childFolders` calls.
 */
function fakeFolders(pages: Array<unknown | (() => Response)>): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  let index = 0;
  const aliasIds = new Map<string, string>();
  const collect = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const folder = value as { id?: string; wellKnownName?: string | null };
    if (folder.id && folder.wellKnownName) aliasIds.set(folder.wellKnownName.toLowerCase(), folder.id);
  };
  for (const page of pages) {
    if (typeof page === 'function') continue;
    const value = (page as { value?: unknown[] }).value;
    if (Array.isArray(value)) value.forEach(collect);
  }
  const fetchImpl = async (url: string): Promise<Response> => {
    urls.push(String(url));
    const path = new URL(String(url)).pathname;
    const aliasMatch = /\/me\/mailFolders\/([^/]+)$/.exec(path);
    if (aliasMatch && !path.endsWith('/childFolders')) {
      const id = aliasIds.get(decodeURIComponent(aliasMatch[1]).toLowerCase());
      return id ? json({ id }) : new Response('not found', { status: 404 });
    }
    const page = pages[Math.min(index, pages.length - 1)];
    index += 1;
    return typeof page === 'function' ? (page as () => Response)() : json(page);
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, urls };
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
      userId: USER_ID, provider: 'microsoft', issuer: MICROSOFT_ISSUER, subject: 'ms-sub-mail',
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

async function storedFolders(): Promise<Array<{ path: string; name: string; special_use: string | null }>> {
  const result = await autocommit(client => client.query<{ path: string; name: string; special_use: string | null }>(
    'SELECT path, name, special_use FROM folders WHERE account_id = $1 ORDER BY path', [ACCOUNT_ID],
  ));
  return result.rows;
}

const TREE = {
  value: [
    { id: 'graph-inbox', displayName: 'Inbox', wellKnownName: 'inbox', childFolderCount: 1 },
    { id: 'graph-sent', displayName: 'Sent Items', wellKnownName: 'sentitems', childFolderCount: 0 },
  ],
};

const CHILDREN = {
  value: [{ id: 'graph-work', displayName: 'Work', parentFolderId: 'graph-inbox', childFolderCount: 1 }],
};

const WORK_CHILDREN = {
  value: [{ id: 'graph-projects', displayName: 'Projects', parentFolderId: 'graph-work', childFolderCount: 0 }],
};

describeOrSkip('Microsoft Graph mail folder discovery (PostgreSQL)', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    await autocommit(client => client.query(
      `INSERT INTO users (id, username) VALUES ($1, 'graph-mail-user') ON CONFLICT (id) DO NOTHING`,
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
      // Cascades to folders and messages; the connection goes first so nothing
      // re-links an account to it.
      await client.query('DELETE FROM provider_connections WHERE user_id = $1', [USER_ID]);
      await client.query('DELETE FROM email_accounts WHERE user_id = $1', [USER_ID]);
    });
  });

  it('projects the folder tree into the local model and links each folder to its Graph id', async () => {
    const connectionId = await seedConnection();
    const provider = fakeFolders([TREE, CHILDREN, WORK_CHILDREN]);

    const results = await syncGraphMailFolders({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: provider.fetchImpl });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ accountId: ACCOUNT_ID, folders: 4, created: 4, updated: 0, renamed: 0 });
    expect(provider.urls[0]).toContain('/me/mailFolders');

    // The well-known folders keep the canonical local paths the rest of the
    // application compares against; the ordinary ones derive a nested path.
    expect(await storedFolders()).toEqual([
      { path: 'INBOX', name: 'Inbox', special_use: '\\Inbox' },
      { path: 'INBOX/Work', name: 'Work', special_use: null },
      { path: 'INBOX/Work/Projects', name: 'Projects', special_use: null },
      { path: 'Sent', name: 'Sent Items', special_use: '\\Sent' },
    ]);

    const links = await autocommit(client => client.query<{ remote_id: string; local_folder_id: string | null }>(
      `SELECT remote_id, local_folder_id FROM integration_collections
        WHERE connection_id = $1 AND kind = 'mail_folder' ORDER BY remote_id`, [connectionId],
    ));
    expect(links.rows.map(row => row.remote_id)).toEqual(['graph-inbox', 'graph-projects', 'graph-sent', 'graph-work']);
    for (const row of links.rows) expect(row.local_folder_id).not.toBeNull();

    const state = await autocommit(client => client.query<{ last_success_at: Date | null; last_error_code: string | null; coverage: string }>(
      `SELECT last_success_at, last_error_code, coverage FROM sync_states WHERE user_id = $1 AND feature = 'mail' AND coverage = 'folders'`, [USER_ID],
    ));
    expect(state.rows[0]?.last_success_at).not.toBeNull();
    expect(state.rows[0]?.last_error_code).toBeNull();
  });

  it('is idempotent: a second run updates the same rows instead of duplicating them', async () => {
    const connectionId = await seedConnection();
    await syncGraphMailFolders({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: fakeFolders([TREE, CHILDREN, WORK_CHILDREN]).fetchImpl });
    const first = await storedFolders();

    const second = await syncGraphMailFolders({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: fakeFolders([TREE, CHILDREN, WORK_CHILDREN]).fetchImpl });
    expect(second[0]).toMatchObject({ created: 0, updated: 4 });
    expect(await storedFolders()).toEqual(first);
  });

  it('retracts the link of a folder a complete snapshot no longer lists', async () => {
    // GRAPH-06: a folder deleted at the provider stayed a target, kept being synchronised and answered 404,
    // which ended the whole mailbox's run. A complete snapshot now retracts the links it does not list.
    const connectionId = await seedConnection();
    await syncGraphMailFolders({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: fakeFolders([FLAT_TREE]).fetchImpl });
    const before = await autocommit(client => client.query<{ remote_id: string; enabled: boolean }>(
      "SELECT remote_id, enabled FROM integration_collections WHERE user_id = $1 AND kind = 'mail_folder' ORDER BY remote_id", [USER_ID],
    ));
    expect(before.rows).toEqual([
      { remote_id: 'graph-inbox', enabled: true },
      { remote_id: 'graph-sent', enabled: true },
    ]);

    // The provider no longer has Sent Items.
    const reduced = { value: [FLAT_TREE.value[0]] };
    const result = await syncGraphMailFolders({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: fakeFolders([reduced]).fetchImpl });
    expect(result[0]).toMatchObject({ retracted: 1 });

    const after = await autocommit(client => client.query<{ remote_id: string; enabled: boolean }>(
      "SELECT remote_id, enabled FROM integration_collections WHERE user_id = $1 AND kind = 'mail_folder' ORDER BY remote_id", [USER_ID],
    ));
    // The vanished folder is no longer a target; the one that still exists is untouched.
    expect(after.rows).toEqual([
      { remote_id: 'graph-inbox', enabled: true },
      { remote_id: 'graph-sent', enabled: false },
    ]);
  });

  it('moves a renamed folder and its messages instead of orphaning them', async () => {
    const connectionId = await seedConnection();
    await syncGraphMailFolders({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: fakeFolders([TREE, CHILDREN, WORK_CHILDREN]).fetchImpl });

    // A message sits under the folder that is about to be renamed.
    await autocommit(client => client.query(
      `INSERT INTO messages (account_id, uid, folder, subject) VALUES ($1, 1, 'INBOX/Work/Projects', 'Quarterly plan')`,
      [ACCOUNT_ID],
    ));

    const renamed = {
      ...TREE,
      value: [TREE.value[0], TREE.value[1]],
    };
    const renamedChildren = { value: [{ id: 'graph-work', displayName: 'Work', parentFolderId: 'graph-inbox', childFolderCount: 1 }] };
    const renamedGrandchildren = { value: [{ id: 'graph-projects', displayName: 'Programmes', parentFolderId: 'graph-work', childFolderCount: 0 }] };

    const result = await syncGraphMailFolders({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: fakeFolders([renamed, renamedChildren, renamedGrandchildren]).fetchImpl });
    expect(result[0]).toMatchObject({ renamed: 1, relocatedMessages: 1 });

    expect((await storedFolders()).map(row => row.path)).toEqual(['INBOX', 'INBOX/Work', 'INBOX/Work/Programmes', 'Sent']);
    const message = await autocommit(client => client.query<{ folder: string }>('SELECT folder FROM messages WHERE account_id = $1', [ACCOUNT_ID]));
    expect(message.rows[0]?.folder).toBe('INBOX/Work/Programmes');
  });

  it('keeps a renamed well-known folder on its canonical path', async () => {
    const connectionId = await seedConnection();
    await syncGraphMailFolders({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: fakeFolders([TREE, CHILDREN, WORK_CHILDREN]).fetchImpl });

    const renamedInbox = {
      value: [
        { id: 'graph-inbox', displayName: 'Poczta', wellKnownName: 'inbox', childFolderCount: 1 },
        { id: 'graph-sent', displayName: 'Sent Items', wellKnownName: 'sentitems', childFolderCount: 0 },
      ],
    };
    await syncGraphMailFolders({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: fakeFolders([renamedInbox, CHILDREN, WORK_CHILDREN]).fetchImpl });

    // The display name follows the provider; the path the application compares
    // against does not, so every INBOX assumption keeps working.
    const inbox = (await storedFolders()).find(row => row.special_use === '\\Inbox');
    expect(inbox).toMatchObject({ path: 'INBOX', name: 'Poczta' });
  });

  it('records the failure and keeps the error code when the provider refuses the call', async () => {
    const connectionId = await seedConnection();
    // A 403 rather than a 401: `graphGet` retries a 401 once through the token
    // service, which is a different path and not the one under test here.
    const forbidden = fakeFolders([() => json({ error: { code: 'ErrorAccessDenied', message: 'no mailbox' } }, 403)]);

    await expect(syncGraphMailFolders({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: forbidden.fetchImpl }))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_SCOPES' });

    expect(await storedFolders()).toEqual([]);
    const state = await autocommit(client => client.query<{ last_error_code: string | null; last_success_at: Date | null }>(
      `SELECT last_error_code, last_success_at FROM sync_states WHERE user_id = $1 AND feature = 'mail' AND coverage = 'folders'`, [USER_ID],
    ));
    expect(state.rows[0]?.last_error_code).toBe('INSUFFICIENT_SCOPES');
  });

  it('refuses a second concurrent run through the sync lease', async () => {
    const connectionId = await seedConnection();
    // Hold the lease the way another worker would, then let this run try.
    await inTransaction(async client => {
      const syncStateId = await ensureSyncState(client, {
        userId: USER_ID, connectionId, accountId: ACCOUNT_ID, feature: 'mail', coverage: 'folders',
      });
      await acquireSyncLease(client, { syncStateId, owner: 'other-worker', leaseSeconds: 300 });
    });

    await expect(syncGraphMailFoldersForAccount({
      userId: USER_ID, connectionId, accountId: ACCOUNT_ID, config: CONFIG, fetchImpl: fakeFolders([TREE]).fetchImpl,
    })).rejects.toMatchObject({ code: 'SYNC_ALREADY_RUNNING' });
  });

  it('is a no-op for a connection with no Graph mail account', async () => {
    const connectionId = await inTransaction(async client => upsertProviderConnection(client, {
      userId: USER_ID, provider: 'microsoft', issuer: MICROSOFT_ISSUER, subject: 'ms-sub-no-mail',
    }));
    await expect(syncGraphMailFolders({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: fakeFolders([TREE]).fetchImpl }))
      .resolves.toEqual([]);
  });
});

// ── Message metadata sync (P07b, second slice) ───────────────────────────────

const FLAT_TREE = {
  value: [
    { id: 'graph-inbox', displayName: 'Inbox', wellKnownName: 'inbox', childFolderCount: 0 },
    { id: 'graph-sent', displayName: 'Sent Items', wellKnownName: 'sentitems', childFolderCount: 0 },
  ],
};

const DELTA_INBOX = 'https://graph.microsoft.com/v1.0/me/mailFolders/graph-inbox/messages/delta?$deltatoken=inbox';
const DELTA_SENT = 'https://graph.microsoft.com/v1.0/me/mailFolders/graph-sent/messages/delta?$deltatoken=sent';

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
    ...overrides,
  };
}

/** Serve the folder tree once, then a scripted sequence of message delta pages. */
function fakeMailProvider(script: {
  inbox?: unknown[];
  sent?: unknown[];
  lookup?: Record<string, unknown | null>;
}) {
  const urls: string[] = [];
  const inbox = [...(script.inbox ?? [])];
  const sent = [...(script.sent ?? [])];
  const fetchImpl = async (url: string): Promise<Response> => {
    const target = String(url);
    urls.push(target);
    if (target.includes('/childFolders')) return json({ value: [] });
    if (target.includes('/messages/delta')) {
      const next = target.includes('graph-inbox') ? inbox.shift() : sent.shift();
      return json(next ?? { value: [], '@odata.deltaLink': `${DELTA_INBOX}-empty` });
    }

    if (target.includes('/me/messages?')) {
      const parsed = new URL(target);
      const filter = parsed.searchParams.get('$filter') ?? '';

      const match = filter.match(/internetMessageId eq '(.+)'/);
      const internetMessageId = match?.[1]?.replace(/''/g, "'") ?? '';

      const values = Object.values(script.lookup ?? {})
        .filter((value): value is Record<string, unknown> => value !== null && typeof value === 'object')
        .filter(value => value.internetMessageId === internetMessageId);

      return json({ value: values });
    }

    if (target.includes('/me/messages/')) {
      const id = decodeURIComponent(target.split('/me/messages/')[1]?.split('?')[0] ?? '');
      if (Object.prototype.hasOwnProperty.call(script.lookup ?? {}, id)) {
        const value = script.lookup?.[id];
        if (value === null) {
          return json({ error: { code: 'ErrorItemNotFound', message: 'Message not found' } }, 404);
        }
        return json(value);
      }

      // Default tombstone verification: the item still exists in the mailbox.
      return json(graphMessage(id, { parentFolderId: 'graph-inbox' }));
    }

    return json(FLAT_TREE);
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, urls };
}

async function storedMessages(): Promise<Array<{ provider_message_id: string; folder: string; subject: string | null; thread_id: string | null; is_read: boolean; is_starred: boolean; from_email: string | null }>> {
  const result = await autocommit(client => client.query<{ provider_message_id: string; folder: string; subject: string | null; thread_id: string | null; is_read: boolean; is_starred: boolean; from_email: string | null }>(
    'SELECT provider_message_id, folder, subject, thread_id, is_read, is_starred, from_email FROM messages WHERE account_id = $1 ORDER BY provider_message_id',
    [ACCOUNT_ID],
  ));
  return result.rows;
}

async function discoverFolders(connectionId: string): Promise<void> {
  await syncGraphMailFolders({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: fakeFolders([FLAT_TREE]).fetchImpl });
}

describeOrSkip('Microsoft Graph mail message sync (PostgreSQL)', () => {
  // This suite is separate from the folder one, so it establishes the same owner
  // and the same clean slate rather than depending on a sibling suite's hooks.
  beforeAll(async () => {
    if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    await autocommit(client => client.query(
      `INSERT INTO users (id, username) VALUES ($1, 'graph-mail-message-user') ON CONFLICT (id) DO NOTHING`,
      [USER_ID],
    ));
  });

  beforeEach(async () => {
    await autocommit(async client => {
      await client.query('DELETE FROM provider_connections WHERE user_id = $1', [USER_ID]);
      await client.query('DELETE FROM email_accounts WHERE user_id = $1', [USER_ID]);
    });
  });

  it('ingests a baseline into the local message list with the provider identity', async () => {
    const connectionId = await seedConnection();
    await discoverFolders(connectionId);

    const provider = fakeMailProvider({
      inbox: [{ value: [graphMessage('m1'), graphMessage('m2', { isRead: true, flag: { flagStatus: 'flagged' } })], '@odata.deltaLink': DELTA_INBOX }],
    });
    const result = await syncGraphMailMessagesForAccount({ userId: USER_ID, connectionId, accountId: ACCOUNT_ID, config: CONFIG, fetchImpl: provider.fetchImpl });

    // Both folders are baselines on the first run: neither has a cursor yet.
    expect(result).toMatchObject({ accountId: ACCOUNT_ID, folders: 2, created: 2, deleted: 0, fullSyncFolders: 2 });
    const messages = await storedMessages();
    expect(messages.map(row => row.provider_message_id)).toEqual(['m1', 'm2']);
    expect(messages[0]).toMatchObject({ folder: 'INBOX', subject: 'Subject m1', thread_id: 'conv-m1', is_read: false, is_starred: false, from_email: 'ada@contoso.test' });
    expect(messages[1]).toMatchObject({ is_read: true, is_starred: true });
    expect(provider.urls.some(url => url.includes('top='))).toBe(false);

    // The cursor is stored per folder, so the next run is incremental.
    const cursors = await autocommit(client => client.query<{ cursor: string | null }>(
      "SELECT cursor FROM sync_states WHERE user_id = $1 AND feature = 'mail' AND coverage = 'messages' ORDER BY cursor", [USER_ID],
    ));
    expect(cursors.rows.map(row => row.cursor)).toContain(DELTA_INBOX);
  });

  it('applies a delta change without deleting local mail from an ambiguous tombstone, and re-sends the stored cursor', async () => {
    const connectionId = await seedConnection();
    await discoverFolders(connectionId);
    await syncGraphMailMessagesForAccount({
      userId: USER_ID, connectionId, accountId: ACCOUNT_ID, config: CONFIG,
      fetchImpl: fakeMailProvider({ inbox: [{ value: [graphMessage('m1'), graphMessage('m2')], '@odata.deltaLink': DELTA_INBOX }] }).fetchImpl,
    });

    const delta = fakeMailProvider({
      inbox: [{ value: [graphMessage('m1', { subject: 'Renamed' }), { id: 'm2', '@removed': { reason: 'deleted' } }], '@odata.deltaLink': `${DELTA_INBOX}-2` }],
    });
    const result = await syncGraphMailMessagesForAccount({ userId: USER_ID, connectionId, accountId: ACCOUNT_ID, config: CONFIG, fetchImpl: delta.fetchImpl });

    expect(result).toMatchObject({ created: 0, updated: 1, deleted: 0, skipped: 1, fullSyncFolders: 0 });
    const messages = await storedMessages();
    expect(messages.map(row => row.provider_message_id)).toEqual(['m1', 'm2']);
    expect(messages.find(row => row.provider_message_id === 'm1')?.subject).toBe('Renamed');
    // The stored delta link is what the run resumes from, not the folder's first page.
    expect(delta.urls.some(url => url.includes('inbox') && url.includes('deltatoken'))).toBe(true);
  });

  it('keeps a tombstoned message when its old Graph id is gone but the RFC message still exists', async () => {
    const connectionId = await seedConnection();
    await discoverFolders(connectionId);

    await syncGraphMailMessagesForAccount({
      userId: USER_ID,
      connectionId,
      accountId: ACCOUNT_ID,
      config: CONFIG,
      fetchImpl: fakeMailProvider({
        inbox: [{
          value: [graphMessage('old-id', {
            internetMessageId: '<read-test@contoso.test>',
          })],
          '@odata.deltaLink': DELTA_INBOX,
        }],
      }).fetchImpl,
    });

    const provider = fakeMailProvider({
      inbox: [{
        value: [{
          id: 'old-id',
          '@removed': { reason: 'deleted' },
        }],
        '@odata.deltaLink': `${DELTA_INBOX}-read`,
      }],
      lookup: {
        // Direct GET of old-id is gone.
        'old-id': null,

        // But the same real mail still exists under a current provider id.
        'new-id': graphMessage('new-id', {
          internetMessageId: '<read-test@contoso.test>',
          parentFolderId: 'graph-inbox',
          isRead: true,
        }),
      },
    });

    const result = await syncGraphMailMessagesForAccount({
      userId: USER_ID,
      connectionId,
      accountId: ACCOUNT_ID,
      config: CONFIG,
      fetchImpl: provider.fetchImpl,
    });

    expect(result.deleted).toBe(0);

    const messages = await storedMessages();
    expect(messages.some(row => row.provider_message_id === 'old-id')).toBe(true);

    expect(provider.urls.some(url =>
      url.includes('/me/messages?') &&
      decodeURIComponent(url).includes('internetMessageId'),
    )).toBe(true);
  });

  it('deletes a local message only after Graph confirms the tombstoned id no longer exists', async () => {
    const connectionId = await seedConnection();
    await discoverFolders(connectionId);

    await syncGraphMailMessagesForAccount({
      userId: USER_ID,
      connectionId,
      accountId: ACCOUNT_ID,
      config: CONFIG,
      fetchImpl: fakeMailProvider({
        inbox: [{
          value: [graphMessage('m1'), graphMessage('m2')],
          '@odata.deltaLink': DELTA_INBOX,
        }],
      }).fetchImpl,
    });

    const provider = fakeMailProvider({
      inbox: [{
        value: [{ id: 'm2', '@removed': { reason: 'deleted' } }],
        '@odata.deltaLink': `${DELTA_INBOX}-deleted`,
      }],
      lookup: {
        m2: null,
      },
    });

    const result = await syncGraphMailMessagesForAccount({
      userId: USER_ID,
      connectionId,
      accountId: ACCOUNT_ID,
      config: CONFIG,
      fetchImpl: provider.fetchImpl,
    });

    expect(result.deleted).toBe(1);
    expect((await storedMessages()).map(row => row.provider_message_id))
      .toEqual(['m1']);
    expect(provider.urls.some(url => url.includes('/me/messages/m2'))).toBe(true);
  });

  it('keeps synchronising the other folders when one folder answers 404', async () => {
    // GRAPH-06: a folder the provider no longer has must not end the account's run — every other folder still
    // synchronises, the failure is counted, and the dead collection stops being a target.
    const connectionId = await seedConnection();
    await discoverFolders(connectionId);

    const fetchImpl = async (url: string): Promise<Response> => {
      const target = String(url);
      if (target.includes('/childFolders')) return json({ value: [] });
      if (target.includes('/messages/delta')) {
        if (target.includes('graph-inbox')) return json({ error: { code: 'ErrorItemNotFound', message: 'The folder was not found.' } }, 404);
        return json({ value: [graphMessage('m2')], '@odata.deltaLink': DELTA_SENT });
      }
      return json(FLAT_TREE);
    };

    const result = await syncGraphMailMessagesForAccount({
      userId: USER_ID, connectionId, accountId: ACCOUNT_ID, config: CONFIG, fetchImpl: fetchImpl as never,
    });
    expect(result.failedFolders).toBe(1);
    expect((await storedMessages()).map(row => [row.provider_message_id, row.folder])).toEqual([['m2', 'Sent']]);

    const inbox = await autocommit(client => client.query<{ enabled: boolean }>(
      "SELECT enabled FROM integration_collections WHERE user_id = $1 AND remote_id = 'graph-inbox' AND kind = 'mail_folder'", [USER_ID],
    ));
    expect(inbox.rows[0]?.enabled).toBe(false);
  });

  it('keeps a message that moved to another folder, whichever delta is applied first', async () => {
    // GRAPH-05: a folder-scoped delta reports `@removed` for a message that moved out of the folder, not only
    // for one that was deleted. Deleting by account and provider id alone removed the message the destination
    // folder had already re-homed, whichever delta happened to run first.
    const connectionId = await seedConnection();
    await discoverFolders(connectionId);
    await syncGraphMailMessagesForAccount({
      userId: USER_ID, connectionId, accountId: ACCOUNT_ID, config: CONFIG,
      fetchImpl: fakeMailProvider({
        inbox: [{ value: [graphMessage('m1')], '@odata.deltaLink': DELTA_INBOX }],
        sent: [{ value: [], '@odata.deltaLink': DELTA_SENT }],
      }).fetchImpl,
    });
    expect((await storedMessages()).map(row => [row.provider_message_id, row.folder])).toEqual([['m1', 'INBOX']]);

    // Destination first: the row already sits in Sent when the source folder reports it removed.
    await autocommit(client => client.query(
      "UPDATE messages SET folder = 'Sent' WHERE account_id = $1 AND provider_message_id = 'm1'", [ACCOUNT_ID],
    ));
    await syncGraphMailMessagesForAccount({
      userId: USER_ID, connectionId, accountId: ACCOUNT_ID, config: CONFIG,
      fetchImpl: fakeMailProvider({
        inbox: [{ value: [{ id: 'm1', '@removed': { reason: 'deleted' } }], '@odata.deltaLink': `${DELTA_INBOX}-2` }],
        sent: [{ value: [], '@odata.deltaLink': DELTA_SENT }],
      }).fetchImpl,
    });
    expect((await storedMessages()).map(row => [row.provider_message_id, row.folder])).toEqual([['m1', 'Sent']]);

    // Source first: the source removes it and the destination lists it again.
    await autocommit(client => client.query(
      "UPDATE messages SET folder = 'INBOX' WHERE account_id = $1 AND provider_message_id = 'm1'", [ACCOUNT_ID],
    ));
    await syncGraphMailMessagesForAccount({
      userId: USER_ID, connectionId, accountId: ACCOUNT_ID, config: CONFIG,
      fetchImpl: fakeMailProvider({
        inbox: [{ value: [{ id: 'm1', '@removed': { reason: 'deleted' } }], '@odata.deltaLink': `${DELTA_INBOX}-3` }],
        sent: [{ value: [graphMessage('m1')], '@odata.deltaLink': `${DELTA_SENT}-2` }],
      }).fetchImpl,
    });
    expect((await storedMessages()).map(row => [row.provider_message_id, row.folder])).toEqual([['m1', 'Sent']]);
  });

  it('refuses to apply a page after another worker took the lease over', async () => {
    // SYNC-03: the network request happens outside the writing transaction, so a run can lose its lease while
    // it is waiting for a page. The fence re-checks the generation inside the transaction that would write the
    // page, so the superseded worker cannot commit over the newer run's projection.
    const connectionId = await seedConnection();
    await discoverFolders(connectionId);
    const collection = await autocommit(client => client.query<{ id: string }>(
      `SELECT ic.id FROM integration_collections ic
        WHERE ic.user_id = $1 AND ic.connection_id = $2 AND ic.remote_id = 'graph-inbox'`,
      [USER_ID, connectionId],
    ));
    const syncStateId = await inTransaction(client => ensureSyncState(client, {
      userId: USER_ID, connectionId, accountId: ACCOUNT_ID, feature: 'mail',
      collectionId: collection.rows[0]!.id, coverage: 'messages',
    }));

    let superseded = false;
    const base = fakeMailProvider({ inbox: [{ value: [graphMessage('m1')], '@odata.deltaLink': DELTA_INBOX }] });
    const fetchImpl = async (url: string): Promise<Response> => {
      if (!superseded && String(url).includes('/messages/delta')) {
        superseded = true;
        // Another worker takes over while this run is waiting on the network.
        await autocommit(client => client.query(
          "UPDATE sync_states SET lease_expires_at = NOW() - interval '1 second' WHERE id = $1", [syncStateId],
        ));
        await inTransaction(client => acquireSyncLease(client, { syncStateId, owner: 'other-worker', leaseSeconds: 300 }));
      }
      return base.fetchImpl(url as never);
    };

    await expect(syncGraphMailMessagesForAccount({
      userId: USER_ID, connectionId, accountId: ACCOUNT_ID, config: CONFIG, fetchImpl: fetchImpl as never,
    })).rejects.toMatchObject({ code: 'SYNC_LEASE_LOST' });

    // The page was never applied: no message row exists for the superseded run.
    expect(await storedMessages()).toHaveLength(0);
  });

  it('does not reconcile deletions when a baseline stops at the page cap', async () => {
    // SYNC-04: a capped run read only a prefix of the folder. Reconciling against that prefix deletes every
    // message on the pages that were not read yet, and storing a cursor would skip them for ever.
    const connectionId = await seedConnection();
    await discoverFolders(connectionId);
    await syncGraphMailMessagesForAccount({
      userId: USER_ID, connectionId, accountId: ACCOUNT_ID, config: CONFIG,
      fetchImpl: fakeMailProvider({ inbox: [{ value: [graphMessage('m1'), graphMessage('m2')], '@odata.deltaLink': DELTA_INBOX }] }).fetchImpl,
    });
    expect((await storedMessages()).map(row => row.provider_message_id)).toEqual(['m1', 'm2']);

    // Force a baseline and cap it at one page: page 1 names only m1 and promises a second page that names m2.
    await autocommit(client => client.query(
      "UPDATE sync_states SET cursor = NULL WHERE user_id = $1 AND feature = 'mail' AND coverage = 'messages'",
      [USER_ID],
    ));
    const capped = fakeMailProvider({ inbox: [
      { value: [graphMessage('m1')], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/graph-inbox/messages/delta?$skiptoken=page-2' },
      { value: [graphMessage('m2')], '@odata.deltaLink': `${DELTA_INBOX}-2` },
    ] });
    const result = await syncGraphMailMessagesForAccount({
      userId: USER_ID, connectionId, accountId: ACCOUNT_ID, config: CONFIG, fetchImpl: capped.fetchImpl, maxPages: 1,
    });

    expect(result.incompleteFolders).toBe(1);
    // The unread page must not be mistaken for "these messages are gone".
    expect((await storedMessages()).map(row => row.provider_message_id)).toEqual(['m1', 'm2']);

    // The durable continuation resumes at page 2 rather than replaying page 1 forever after a worker restart.
    const resumed = await syncGraphMailMessagesForAccount({
      userId: USER_ID, connectionId, accountId: ACCOUNT_ID, config: CONFIG, fetchImpl: capped.fetchImpl,
    });
    expect(resumed.incompleteFolders).toBe(0);
    expect((await storedMessages()).map(row => row.provider_message_id)).toEqual(['m1', 'm2']);
    const checkpoint = await autocommit(client => client.query<{ page_checkpoint: string | null }>(
      "SELECT page_checkpoint FROM sync_states WHERE user_id = $1 AND feature = 'mail' AND coverage = 'messages' LIMIT 1", [USER_ID],
    ));
    expect(checkpoint.rows[0]?.page_checkpoint).toBeNull();
  });

  it('never treats omission from a rebuilt baseline as a message deletion', async () => {
    const connectionId = await seedConnection();
    await discoverFolders(connectionId);

    // Initial state: both messages already exist locally.
    await syncGraphMailMessagesForAccount({
      userId: USER_ID, connectionId, accountId: ACCOUNT_ID, config: CONFIG,
      fetchImpl: fakeMailProvider({
        inbox: [{
          value: [graphMessage('old'), graphMessage('fresh'), graphMessage('stale')],
          '@odata.deltaLink': DELTA_INBOX,
        }],
      }).fetchImpl,
    });

    // Force a new full baseline.
    await autocommit(client => client.query(
      "UPDATE sync_states SET cursor = NULL, page_checkpoint = NULL WHERE user_id = $1 AND feature = 'mail' AND coverage = 'messages'",
      [USER_ID],
    ));

    let refreshedDuringBaseline = false;

    const fetchImpl = async (url: string): Promise<Response> => {
      const target = String(url);

      if (target.includes('/childFolders')) {
        return json({ value: [] });
      }

      if (target.includes('graph-inbox') && target.includes('/messages/delta')) {
        if (!refreshedDuringBaseline) {
          refreshedDuringBaseline = true;

          // Simulate a new push/delta observation happening AFTER the historical
          // baseline started. The historical baseline response itself intentionally
          // does not contain this fresh message.
          await autocommit(client => client.query(
            "UPDATE messages SET synced_at = NOW() WHERE account_id = $1 AND provider_message_id = 'fresh'",
            [ACCOUNT_ID],
          ));
        }

        return json({
          value: [graphMessage('old')],
          '@odata.deltaLink': `${DELTA_INBOX}-baseline`,
        });
      }

      if (target.includes('graph-sent') && target.includes('/messages/delta')) {
        return json({
          value: [],
          '@odata.deltaLink': DELTA_SENT,
        });
      }

      return json(FLAT_TREE);
    };

    const result = await syncGraphMailMessagesForAccount({
      userId: USER_ID,
      connectionId,
      accountId: ACCOUNT_ID,
      config: CONFIG,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.fullSyncFolders).toBeGreaterThan(0);

    // Production regression: neither a freshly observed message nor an older
    // local message may disappear merely because a rebuilt historical baseline
    // omitted it. Provider deletions are driven only by explicit @removed events.
    expect((await storedMessages()).map(row => row.provider_message_id)).toEqual([
      'fresh',
      'old',
      'stale',
    ]);
  });

  it('does not revert a flag the user just changed', async () => {
    const connectionId = await seedConnection();
    await discoverFolders(connectionId);
    await syncGraphMailMessagesForAccount({
      userId: USER_ID, connectionId, accountId: ACCOUNT_ID, config: CONFIG,
      fetchImpl: fakeMailProvider({ inbox: [{ value: [graphMessage('m1')], '@odata.deltaLink': DELTA_INBOX }] }).fetchImpl,
    });
    // The user marks it read locally; the server answer that arrives next still says unread.
    await autocommit(client => client.query("UPDATE messages SET is_read = true, read_changed_at = NOW() WHERE account_id = $1 AND provider_message_id = 'm1'", [ACCOUNT_ID]));

    await syncGraphMailMessagesForAccount({
      userId: USER_ID, connectionId, accountId: ACCOUNT_ID, config: CONFIG,
      fetchImpl: fakeMailProvider({ inbox: [{ value: [graphMessage('m1', { isRead: false })], '@odata.deltaLink': `${DELTA_INBOX}-2` }] }).fetchImpl,
    });

    expect((await storedMessages())[0]?.is_read).toBe(true);
  });

  it('rebuilds the folder when Graph rejects the delta token without deleting omitted local mail', async () => {
    const connectionId = await seedConnection();
    await discoverFolders(connectionId);
    await syncGraphMailMessagesForAccount({
      userId: USER_ID, connectionId, accountId: ACCOUNT_ID, config: CONFIG,
      fetchImpl: fakeMailProvider({ inbox: [{ value: [graphMessage('m1'), graphMessage('m2')], '@odata.deltaLink': DELTA_INBOX }] }).fetchImpl,
    });

    let calls = 0;
    const rebuilding = async (url: string): Promise<Response> => {
      const target = String(url);
      if (target.includes('/childFolders')) return json({ value: [] });
      if (target.includes('/messages/delta')) {
        calls += 1;
        if (calls === 1) return json({ error: { code: 'syncStateNotFound', message: 'expired' } }, 410);
        return json({ value: [graphMessage('m1')], '@odata.deltaLink': `${DELTA_INBOX}-rebuilt` });
      }
      return json(FLAT_TREE);
    };
    const result = await syncGraphMailMessagesForAccount({
      userId: USER_ID, connectionId, accountId: ACCOUNT_ID, config: CONFIG, fetchImpl: rebuilding as unknown as typeof fetch,
    });

    // A lost delta token does not make absence from the rebuilt enumeration a
    // deletion signal. m2 remains until Graph emits an explicit @removed event.
    expect(result).toMatchObject({ deleted: 0, fullSyncFolders: 1 });
    expect((await storedMessages()).map(row => row.provider_message_id)).toEqual(['m1', 'm2']);
  });

  it('is idempotent: re-reading the same baseline changes nothing', async () => {
    const connectionId = await seedConnection();
    await discoverFolders(connectionId);
    const page = { value: [graphMessage('m1'), graphMessage('m2')] };
    await syncGraphMailMessagesForAccount({
      userId: USER_ID, connectionId, accountId: ACCOUNT_ID, config: CONFIG,
      fetchImpl: fakeMailProvider({ inbox: [{ ...page, '@odata.deltaLink': DELTA_INBOX }] }).fetchImpl,
    });
    const before = await storedMessages();

    // An empty delta page, which is what a refresh with no changes returns.
    const second = await syncGraphMailMessagesForAccount({
      userId: USER_ID, connectionId, accountId: ACCOUNT_ID, config: CONFIG,
      fetchImpl: fakeMailProvider({ inbox: [{ value: [], '@odata.deltaLink': `${DELTA_INBOX}-2` }] }).fetchImpl,
    });
    expect(second).toMatchObject({ created: 0, updated: 0, deleted: 0 });
    expect(await storedMessages()).toEqual(before);
  });
});

// ── Drain of scheduled flag mutations (P07b, third slice) ────────────────────

/** Records every request so the PATCH can be asserted, not only its effect. */
function fakeRecordingProvider(deltaPages: unknown[]) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const pages = [...deltaPages];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const target = String(url);
    calls.push({
      url: target,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    });
    if (target.includes('/messages/delta')) return json(pages.shift() ?? { value: [], '@odata.deltaLink': `${DELTA_INBOX}-empty` });
    if (target.includes('/childFolders')) return json({ value: [] });
    if (target.includes('/me/messages/')) return json({ id: 'm1' });
    return json(FLAT_TREE);
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

describeOrSkip('Microsoft Graph mail flag mutations (PostgreSQL)', () => {
  beforeAll(async () => {
    if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    await autocommit(client => client.query(
      `INSERT INTO users (id, username) VALUES ($1, 'graph-mail-mutation-user') ON CONFLICT (id) DO NOTHING`,
      [USER_ID],
    ));
  });

  beforeEach(async () => {
    await autocommit(async client => {
      await client.query('DELETE FROM provider_operations WHERE user_id = $1', [USER_ID]);
      await client.query('DELETE FROM provider_connections WHERE user_id = $1', [USER_ID]);
      await client.query('DELETE FROM email_accounts WHERE user_id = $1', [USER_ID]);
    });
  });

  it('drains a scheduled flag mutation before reading the delta', async () => {
    const connectionId = await seedConnection();
    await discoverFolders(connectionId);
    // A baseline so a local message with the provider identity exists.
    await syncGraphMailMessagesForAccount({
      userId: USER_ID, connectionId, accountId: ACCOUNT_ID, config: CONFIG,
      fetchImpl: fakeMailProvider({ inbox: [{ value: [graphMessage('m1')], '@odata.deltaLink': DELTA_INBOX }] }).fetchImpl,
    });
    const local = await autocommit(client => client.query<{ id: string }>(
      "SELECT id FROM messages WHERE account_id = $1 AND provider_message_id = 'm1'", [ACCOUNT_ID],
    ));
    const localMessageId = local.rows[0].id;

    // What a `retryable` outcome leaves behind: a pending row carrying its adapter
    // parameters. Before this slice nothing could read it, so the change was lost.
    const write = { providerMessageId: 'm1', flag: '\\Seen', value: true, intentAt: '2026-03-04T09:00:00.000Z' };
    const intent = graphFlagIntent({ messageId: localMessageId, write });
    await autocommit(client => client.query(
      `INSERT INTO provider_operations (user_id, account_id, resource_type, operation, resource_id, idempotency_key, payload_hash, payload, status)
       VALUES ($1,$2,'message','update',$3,$4,$5,$6::jsonb,'pending')`,
      [USER_ID, ACCOUNT_ID, localMessageId, intent.idempotencyKey, intent.payloadHash, JSON.stringify(write)],
    ));

    const provider = fakeRecordingProvider([{ value: [], '@odata.deltaLink': `${DELTA_INBOX}-2` }]);
    await syncGraphMailMessagesForAccount({ userId: USER_ID, connectionId, accountId: ACCOUNT_ID, config: CONFIG, fetchImpl: provider.fetchImpl });

    const operation = await autocommit(client => client.query<{ status: string; result: unknown }>(
      'SELECT status, result FROM provider_operations WHERE idempotency_key = $1', [intent.idempotencyKey],
    ));
    expect(operation.rows[0]?.status).toBe('committed');
    const patch = provider.calls.find(call => call.method === 'PATCH');
    expect(patch?.url).toContain('/me/messages/m1');
    expect(patch?.body).toEqual({ isRead: true });
  });

  it('leaves a pending row the journal cannot re-run rather than dropping it', async () => {
    const connectionId = await seedConnection();
    await discoverFolders(connectionId);
    await autocommit(client => client.query(
      `INSERT INTO provider_operations (user_id, account_id, resource_type, operation, idempotency_key, payload_hash, payload, status)
       VALUES ($1,$2,'message','update','no-payload-key','hash','{}'::jsonb,'pending')`,
      [USER_ID, ACCOUNT_ID],
    ));

    const provider = fakeRecordingProvider([{ value: [], '@odata.deltaLink': DELTA_INBOX }]);
    await syncGraphMailMessagesForAccount({ userId: USER_ID, connectionId, accountId: ACCOUNT_ID, config: CONFIG, fetchImpl: provider.fetchImpl });

    // Honest and visible: a row with no adapter parameters stays pending for a human.
    const operation = await autocommit(client => client.query<{ status: string }>(
      "SELECT status FROM provider_operations WHERE idempotency_key = 'no-payload-key'",
    ));
    expect(operation.rows[0]?.status).toBe('pending');
  });
});

describeOrSkip('resolving a local folder path back to its Graph folder id (PostgreSQL)', () => {
  beforeAll(async () => {
    if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    await autocommit(client => client.query(
      `INSERT INTO users (id, username) VALUES ($1, 'graph-mail-path-user') ON CONFLICT (id) DO NOTHING`,
      [USER_ID],
    ));
  });

  beforeEach(async () => {
    await autocommit(async client => {
      await client.query('DELETE FROM provider_connections WHERE user_id = $1', [USER_ID]);
      await client.query('DELETE FROM email_accounts WHERE user_id = $1', [USER_ID]);
    });
  });

  it('reads the collection link backwards, and refuses a path it never discovered', async () => {
    const connectionId = await seedConnection();
    await syncGraphMailFolders({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: fakeFolders([TREE, CHILDREN, WORK_CHILDREN]).fetchImpl });

    // A move addresses the destination by the provider's folder id, so the local
    // path a route holds has to resolve through the link the folder slice created.
    await expect(graphFolderIdForPath({ connectionId, accountId: ACCOUNT_ID, path: 'INBOX/Work/Projects' }))
      .resolves.toBe('graph-projects');
    await expect(graphFolderIdForPath({ connectionId, accountId: ACCOUNT_ID, path: 'Trash' })).resolves.toBeNull();
    await expect(graphFolderIdForPath({ connectionId, accountId: ACCOUNT_ID, path: 'INBOX' })).resolves.toBe('graph-inbox');
  });
});

// The conversation projection runs after each page's transaction, and Graph's
// `conversationId` is strong evidence — the property that makes it correct to group on.
// Asserted on the real database, because the identity rule lives in a mapper but the
// grouping is the engine's behaviour.
describeOrSkip('Graph conversations on PostgreSQL', () => {
  beforeAll(async () => {
    if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    await autocommit(client => client.query(
      `INSERT INTO users (id, username) VALUES ($1, 'graph-mail-conversation-user') ON CONFLICT (id) DO NOTHING`,
      [USER_ID],
    ));
  });

  beforeEach(async () => {
    await autocommit(async client => {
      await client.query('DELETE FROM provider_connections WHERE user_id = $1', [USER_ID]);
      await client.query('DELETE FROM email_accounts WHERE user_id = $1', [USER_ID]);
    });
  });

  it('groups two messages that share a conversation id, and keeps a third apart', async () => {
    const connectionId = await seedConnection();
    await discoverFolders(connectionId);
    await syncGraphMailMessagesForAccount({
      userId: USER_ID, connectionId, accountId: ACCOUNT_ID, config: CONFIG,
      fetchImpl: fakeMailProvider({
        inbox: [{
          value: [
            graphMessage('c-1', { conversationId: 'conv-shared' }),
            graphMessage('c-2', { conversationId: 'conv-shared' }),
            graphMessage('c-3', { conversationId: 'conv-other' }),
          ],
          '@odata.deltaLink': DELTA_INBOX,
        }],
      }).fetchImpl,
    });

    // The projection ran: every message carries the provider thread id the mapping
    // derived, which is the part the mapper alone could not prove.
    const threads = await autocommit(client => client.query<{ provider_thread_id: string | null }>(
      'SELECT DISTINCT provider_thread_id FROM messages WHERE account_id = $1', [ACCOUNT_ID],
    ));
    expect(threads.rows.map(row => row.provider_thread_id).sort()).toEqual(['conv-other', 'conv-shared']);

    // And the engine grouped on it: two messages in one conversation, one in another.
    const conversations = await autocommit(client => client.query<{ copy_count: number }>(
      'SELECT copy_count FROM conversations WHERE account_id = $1 ORDER BY copy_count DESC', [ACCOUNT_ID],
    ));
    expect(conversations.rows.map(row => Number(row.copy_count))).toEqual([2, 1]);
  });

  it('runs durable legacy binding recovery after empty deltas in bounded resumable slices', async () => {
    const connectionId = await seedConnection();
    await discoverFolders(connectionId);
    await autocommit(async client => {
      // DA-10 starts from a current cursor: an empty incremental delta cannot reconcile existing native rows away.
      const collections = await client.query<{ id: string }>(
        "SELECT id FROM integration_collections WHERE connection_id = $1 AND kind = 'mail_folder' AND enabled = true", [connectionId],
      );
      for (const collection of collections.rows) {
        const syncStateId = await ensureSyncState(client, {
          userId: USER_ID, connectionId, accountId: ACCOUNT_ID, feature: 'mail', collectionId: collection.id, coverage: 'messages',
        });
        await client.query('UPDATE sync_states SET cursor = $2 WHERE id = $1', [syncStateId, `${DELTA_INBOX}-${collection.id}`]);
      }
      for (const [legacyId, nativeId, providerId, uid] of [
        ['00000000-0000-0000-0000-0000000004c1', '00000000-0000-0000-0000-0000000004d1', 'legacy-native-1', 7001],
        ['00000000-0000-0000-0000-0000000004c2', '00000000-0000-0000-0000-0000000004d2', 'legacy-native-2', 7002],
      ] as const) {
        await client.query(`INSERT INTO messages (id, account_id, uid, folder, message_id, from_email, date, subject, is_read) VALUES ($1,$2,$3,'INBOX',$4,'legacy@example.test',$5::timestamptz,'legacy',false)`, [legacyId, ACCOUNT_ID, uid, `<${providerId}@test>`, '2026-09-23T12:00:00Z']);
        await client.query(`INSERT INTO messages (id, account_id, uid, folder, provider_message_id, message_id, from_email, date, subject, is_read) VALUES ($1,$2,$3,'INBOX',$4,$5,'legacy@example.test',$6::timestamptz,'native',false)`, [nativeId, ACCOUNT_ID, uid + 100, providerId, `<${providerId}@test>`, '2026-09-23T12:00:00Z']);
      }
    });
    const empty = fakeMailProvider({ inbox: [{ value: [], '@odata.deltaLink': DELTA_INBOX }] });
    await syncGraphMailMessagesForAccount({ userId: USER_ID, connectionId, accountId: ACCOUNT_ID, config: CONFIG, fetchImpl: empty.fetchImpl, legacyBindingRepairLimit: 1 });
    let state = await autocommit(client => client.query<{ checkpoint: string; bound_count: number; status: string }>('SELECT checkpoint, bound_count, status FROM graph_legacy_message_binding_repair_state WHERE account_id = $1 AND connection_id = $2', [ACCOUNT_ID, connectionId]));
    expect(state.rows[0]).toMatchObject({ checkpoint: '00000000-0000-0000-0000-0000000004c1', bound_count: 1, status: 'pending' });
    await syncGraphMailMessagesForAccount({ userId: USER_ID, connectionId, accountId: ACCOUNT_ID, config: CONFIG, fetchImpl: empty.fetchImpl, legacyBindingRepairLimit: 1 });
    state = await autocommit(client => client.query<{ checkpoint: string; bound_count: number; status: string }>('SELECT checkpoint, bound_count, status FROM graph_legacy_message_binding_repair_state WHERE account_id = $1 AND connection_id = $2', [ACCOUNT_ID, connectionId]));
    expect(state.rows[0]).toMatchObject({ checkpoint: '00000000-0000-0000-0000-0000000004c2', bound_count: 2, status: 'pending' });
    const bindings = await autocommit(client => client.query('SELECT legacy_message_id FROM graph_legacy_message_bindings WHERE account_id = $1 ORDER BY legacy_message_id', [ACCOUNT_ID]));
    expect(bindings.rows).toHaveLength(2);
  });
});
