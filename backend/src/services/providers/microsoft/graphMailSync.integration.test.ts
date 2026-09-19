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
import { syncGraphMailFolders, syncGraphMailFoldersForAccount } from './graphMailSync.js';

const hasPg = process.env.DB_HOST && process.env.DB_NAME;
const describeOrSkip = hasPg ? describe : describe.skip;

const USER_ID = '00000000-0000-0000-0000-0000000004b1';
const ACCOUNT_ID = '00000000-0000-0000-0000-0000000004b2';
const CONFIG = { clientId: 'client-1', clientSecret: 'secret-1', redirectUri: 'https://x/cb', providerRedirectUri: 'https://x/oauth/provider/microsoft/callback', tenantId: 'common' };
const originalKey = process.env.ENCRYPTION_KEY;

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body } as Response;
}

/** A single-page folder tree, served for every folder request in a run. */
function fakeFolders(pages: Array<unknown | (() => Response)>): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  let index = 0;
  const fetchImpl = async (url: string): Promise<Response> => {
    urls.push(String(url));
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
    })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('is a no-op for a connection with no Graph mail account', async () => {
    const connectionId = await inTransaction(async client => upsertProviderConnection(client, {
      userId: USER_ID, provider: 'microsoft', issuer: MICROSOFT_ISSUER, subject: 'ms-sub-no-mail',
    }));
    await expect(syncGraphMailFolders({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: fakeFolders([TREE]).fetchImpl }))
      .resolves.toEqual([]);
  });
});
