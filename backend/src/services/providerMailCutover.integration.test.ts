// Real PostgreSQL tests for the P12 in-place Microsoft Graph cutover.
//
// The provider is faked only where folder discovery is exercised; the switch itself, the state
// bookkeeping, ownership, idempotency and the survival of local data are all real database
// behaviour. Run with:
//
//   DB_HOST=127.0.0.1 DB_PORT=55432 DB_NAME=inboxora_p12_gate DB_USER=mailflow_test DB_PASSWORD=mailflow_test \
//     npx vitest run src/services/providerMailCutover.integration.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { pool } from './db.js';
import {
  MICROSOFT_GRANT_AUDIENCE,
  MICROSOFT_ISSUER,
  storeOAuthGrant,
  upsertProviderConnection,
} from './providerAuthService.js';
import { resolveMailTransportForSync } from './mailTransportTarget.js';
import { listProviderSyncTargets } from './providerSyncScheduler.js';
import { listGraphMailAccounts } from './providers/microsoft/graphMailSync.js';
import {
  cutOverMicrosoftMailAccount,
  missingGraphMailScopes,
  normaliseGraphScope,
} from './providerMailCutover.js';

const hasPg = process.env.DB_HOST && process.env.DB_NAME;
const describeOrSkip = hasPg ? describe : describe.skip;

const USER_ID = '00000000-0000-0000-0000-000000000c01';
const OTHER_USER_ID = '00000000-0000-0000-0000-000000000c02';
const ACCOUNT_ID = '00000000-0000-0000-0000-000000000c11';
const OTHER_ACCOUNT_ID = '00000000-0000-0000-0000-000000000c12';
const MAILBOX = 'sam@contoso.test';
const CONFIG = {
  clientId: 'client-1', clientSecret: 'secret-1', redirectUri: 'https://x/cb',
  providerRedirectUri: 'https://x/oauth/provider/microsoft/callback', tenantId: 'common',
};
const originalKey = process.env.ENCRYPTION_KEY;
const originalClientId = process.env.MS_CLIENT_ID;

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body } as Response;
}

/** Serve a scripted sequence of folder pages; every other URL gets the same tree. */
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

const TREE = {
  value: [
    { id: 'graph-inbox', displayName: 'Inbox', wellKnownName: 'inbox', childFolderCount: 1 },
    { id: 'graph-sent', displayName: 'Sent Items', wellKnownName: 'sentitems', childFolderCount: 0 },
  ],
};
const CHILDREN = { value: [{ id: 'graph-work', displayName: 'Work', parentFolderId: 'graph-inbox', childFolderCount: 0 }] };
/** The empty answer every childFolders call after the first one gets. */
const NO_CHILDREN = { value: [] };

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

interface SeedOptions {
  userId?: string;
  accountId?: string;
  email?: string;
  scopes?: string[];
  providerUserId?: string | null;
}

/**
 * An existing Microsoft IMAP account (no `mail_transport` recorded, `oauth_provider = 'microsoft'`)
 * and the Graph connection + grant that a `mail_migration` authorization would have produced.
 */
async function seedMicrosoftAccount(options: SeedOptions = {}): Promise<{ connectionId: string; accountId: string; userId: string }> {
  const userId = options.userId ?? USER_ID;
  const accountId = options.accountId ?? ACCOUNT_ID;
  const email = options.email ?? MAILBOX;
  const providerUserId = options.providerUserId === undefined ? email : options.providerUserId;
  const scopes = options.scopes ?? ['https://graph.microsoft.com/Mail.ReadWrite', 'https://graph.microsoft.com/Mail.Send'];
  return inTransaction(async client => {
    const connectionId = await upsertProviderConnection(client, {
      userId, provider: 'microsoft', issuer: MICROSOFT_ISSUER, subject: `ms-sub-${accountId}`,
      providerUserId,
    });
    await storeOAuthGrant(client, {
      connectionId,
      audience: MICROSOFT_GRANT_AUDIENCE,
      accessToken: 'graph-access-valid',
      refreshToken: 'graph-refresh-1',
      expiresAt: new Date(Date.now() + 3600_000),
      scopes,
      clientIdAtIssue: CONFIG.clientId,
    });
    await client.query(
      `INSERT INTO email_accounts
         (id, user_id, name, email_address, protocol, imap_host, oauth_provider, migration_state)
       VALUES ($1, $2, 'Outlook', $3, 'imap', 'outlook.office365.com', 'microsoft', 'not_applicable')`,
      [accountId, userId, email],
    );
    return { connectionId, accountId, userId };
  });
}

interface AccountRow {
  id: string;
  mail_transport: string | null;
  protocol: string | null;
  provider_connection_id: string | null;
  provider_mailbox_id: string | null;
  migration_state: string;
  migration_required: boolean;
  migration_error_code: string | null;
  mail_method_preference: string | null;
  transport_generation: string | number;
}

async function readAccount(accountId: string): Promise<AccountRow | undefined> {
  const result = await autocommit(client => client.query<AccountRow>(
    `SELECT id, mail_transport, protocol, provider_connection_id, provider_mailbox_id, migration_state,
            migration_required, migration_error_code, mail_method_preference, transport_generation
       FROM email_accounts WHERE id = $1`,
    [accountId],
  ));
  return result.rows[0];
}

/** The local data the cutover must not touch: folders, messages, aliases and conversations. */
async function seedLocalData(userId: string, accountId: string): Promise<void> {
  await autocommit(async client => {
    await client.query(
      `INSERT INTO folders (account_id, path, name, special_use) VALUES
         ($1, 'INBOX', 'Inbox', '\\Inbox'), ($1, 'Sent', 'Sent', '\\Sent'), ($1, 'Drafts', 'Drafts', '\\Drafts')`,
      [accountId],
    );
    await client.query(
      `INSERT INTO messages (account_id, uid, folder, message_id, subject, body_text, is_read) VALUES
         ($1, 1, 'INBOX', '<keep-1@contoso.test>', 'Quarterly plan', 'body one', false),
         ($1, 2, 'Drafts',  NULL,                  'Unsent reply',  NULL,       true)`,
      [accountId],
    );
    await client.query(
      `INSERT INTO account_aliases (account_id, name, email) VALUES ($1, 'Sam (alias)', 'sam+alias@contoso.test')`,
      [accountId],
    );
    await client.query(
      `INSERT INTO conversations (user_id, account_id, subject_snapshot, copy_count) VALUES ($1, $2, 'Quarterly plan', 1)`,
      [userId, accountId],
    );
  });
}

async function localDataSnapshot(accountId: string, userId: string) {
  return autocommit(async client => {
    const folders = await client.query('SELECT path, name, special_use FROM folders WHERE account_id = $1 ORDER BY path', [accountId]);
    const messages = await client.query('SELECT uid, folder, subject, body_text, is_read FROM messages WHERE account_id = $1 ORDER BY uid', [accountId]);
    const aliases = await client.query('SELECT name, email FROM account_aliases WHERE account_id = $1 ORDER BY email', [accountId]);
    const conversations = await client.query('SELECT subject_snapshot, copy_count FROM conversations WHERE user_id = $1 AND account_id = $2 ORDER BY subject_snapshot', [userId, accountId]);
    return { folders: folders.rows, messages: messages.rows, aliases: aliases.rows, conversations: conversations.rows };
  });
}

describeOrSkip('cutOverMicrosoftMailAccount (PostgreSQL)', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    // `resolveMailTransportForSync` reads the installation configuration rather than a passed one, so
    // the dispatch assertion needs a configured Microsoft client.
    process.env.MS_CLIENT_ID = 'client-1';
    await autocommit(async client => {
      for (const [id, username] of [[USER_ID, 'p12-user'], [OTHER_USER_ID, 'p12-other']] as const) {
        await client.query('INSERT INTO users (id, username) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [id, username]);
      }
    });
  });

  afterAll(async () => {
    await autocommit(client => client.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[USER_ID, OTHER_USER_ID]]));
    if (originalKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = originalKey;
    if (originalClientId === undefined) delete process.env.MS_CLIENT_ID;
    else process.env.MS_CLIENT_ID = originalClientId;
  });

  beforeEach(async () => {
    await autocommit(async client => {
      await client.query('DELETE FROM provider_connections WHERE user_id = ANY($1::uuid[])', [[USER_ID, OTHER_USER_ID]]);
      await client.query('DELETE FROM email_accounts WHERE user_id = ANY($1::uuid[])', [[USER_ID, OTHER_USER_ID]]);
      await client.query('DELETE FROM conversations WHERE user_id = ANY($1::uuid[])', [[USER_ID, OTHER_USER_ID]]);
    });
  });

  it('switches the account in place: same id, one row, local data intact, Graph afterwards', async () => {
    const { connectionId } = await seedMicrosoftAccount();
    await seedLocalData(USER_ID, ACCOUNT_ID);
    const before = await localDataSnapshot(ACCOUNT_ID, USER_ID);

    const result = await cutOverMicrosoftMailAccount({
      userId: USER_ID, accountId: ACCOUNT_ID, connectionId, discoverFolders: false,
    });

    expect(result.status).toBe('migrated');
    if (result.status !== 'migrated') return;
    expect(result.connectionId).toBe(connectionId);
    expect(result.transitions).toEqual([{ from: 'not_applicable', to: 'active_native' }]);

    // The same account, one row, now native.
    const rows = await autocommit(client => client.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM email_accounts WHERE user_id = $1', [USER_ID],
    ));
    expect(rows.rows[0]?.count).toBe('1');
    const account = await readAccount(ACCOUNT_ID);
    expect(account).toMatchObject({
      id: ACCOUNT_ID,
      mail_transport: 'microsoft_graph',
      protocol: 'microsoft_graph',
      provider_connection_id: connectionId,
      migration_state: 'active_native',
      migration_required: false,
      migration_error_code: null,
      mail_method_preference: 'microsoft_graph',
    });
    expect(Number(account?.transport_generation)).toBe(2);
    // The provider mailbox id is the connection's verified subject, not a guess.
    expect(account?.provider_mailbox_id).toBe(`ms-sub-${ACCOUNT_ID}`);

    // Everything the user had locally is exactly where it was.
    expect(await localDataSnapshot(ACCOUNT_ID, USER_ID)).toEqual(before);

    // The next mail operation dispatches to Graph, and the schedule finds the account on its
    // connection: this is the "the next sync actually picks it up" property.
    await expect(resolveMailTransportForSync(USER_ID, ACCOUNT_ID)).resolves.toMatchObject({
      kind: 'graph', connectionId,
    });
    const mailAccounts = await inTransaction(client => listGraphMailAccounts(client, { userId: USER_ID, connectionId }));
    expect(mailAccounts).toEqual([ACCOUNT_ID]);
  });

  it('is idempotent: a retry is a no-op, not a second migration', async () => {
    const { connectionId } = await seedMicrosoftAccount();
    const first = await cutOverMicrosoftMailAccount({ userId: USER_ID, accountId: ACCOUNT_ID, discoverFolders: false });
    expect(first.status).toBe('migrated');
    const afterFirst = await readAccount(ACCOUNT_ID);

    const second = await cutOverMicrosoftMailAccount({ userId: USER_ID, accountId: ACCOUNT_ID, connectionId, discoverFolders: false });
    expect(second.status).toBe('already_native');
    if (second.status !== 'already_native') return;
    expect(second.connectionId).toBe(connectionId);
    expect(second.transitions).toEqual([]);

    // Nothing moved the second time: not the generation, not the state, not the rows.
    expect(await readAccount(ACCOUNT_ID)).toEqual(afterFirst);
    const rows = await autocommit(client => client.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM email_accounts WHERE user_id = $1', [USER_ID],
    ));
    expect(rows.rows[0]?.count).toBe('1');
  });

  it('serializes two concurrent cutovers so exactly one switches and neither half-migrates', async () => {
    await seedMicrosoftAccount();

    const [a, b] = await Promise.all([
      cutOverMicrosoftMailAccount({ userId: USER_ID, accountId: ACCOUNT_ID, discoverFolders: false }),
      cutOverMicrosoftMailAccount({ userId: USER_ID, accountId: ACCOUNT_ID, discoverFolders: false }),
    ]);

    expect([a.status, b.status].sort()).toEqual(['already_native', 'migrated']);
    const account = await readAccount(ACCOUNT_ID);
    expect(account?.mail_transport).toBe('microsoft_graph');
    expect(account?.migration_state).toBe('active_native');
    // One switch, one generation bump — not two.
    expect(Number(account?.transport_generation)).toBe(2);
  });

  it('refuses a grant that does not cover the mailbox, and records why without touching the transport', async () => {
    // A grant that can read and file but not send: a native account would silently lose sending.
    const { connectionId } = await seedMicrosoftAccount({ scopes: ['https://graph.microsoft.com/Mail.ReadWrite'] });

    const result = await cutOverMicrosoftMailAccount({ userId: USER_ID, accountId: ACCOUNT_ID, discoverFolders: false });

    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.code).toBe('PROVIDER_AUTH_REQUIRED');
    expect(result.missingScopes).toEqual(['Mail.Send']);
    expect(result.recorded).toBe(true);

    const account = await readAccount(ACCOUNT_ID);
    // The account still reads and sends exactly as it did; the reason is visible.
    expect(account).toMatchObject({
      mail_transport: null,
      protocol: 'imap',
      provider_connection_id: null,
      migration_state: 'authorization_required',
      migration_error_code: 'PROVIDER_AUTH_REQUIRED',
    });
    // And the dispatch still says IMAP, so nothing was switched behind the refusal.
    await expect(resolveMailTransportForSync(USER_ID, ACCOUNT_ID)).resolves.toEqual({ kind: 'imap' });
    expect(connectionId).toBeTruthy();
  });

  it('refuses a mailbox with no Graph authorization at all', async () => {
    // Account only: no connection, so no grant.
    await inTransaction(client => client.query(
      `INSERT INTO email_accounts (id, user_id, name, email_address, protocol, imap_host, oauth_provider)
       VALUES ($1, $2, 'Outlook', $3, 'imap', 'outlook.office365.com', 'microsoft')`,
      [ACCOUNT_ID, USER_ID, MAILBOX],
    ));

    const result = await cutOverMicrosoftMailAccount({ userId: USER_ID, accountId: ACCOUNT_ID, discoverFolders: false });
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.code).toBe('PROVIDER_AUTH_REQUIRED');
    expect((await readAccount(ACCOUNT_ID))?.migration_state).toBe('authorization_required');
  });

  it('refuses when more than one authorization matches the mailbox instead of guessing', async () => {
    await seedMicrosoftAccount();
    // A second connection whose verified identity is the same mailbox.
    await inTransaction(async client => {
      const connectionId = await upsertProviderConnection(client, {
        userId: USER_ID, provider: 'microsoft', issuer: MICROSOFT_ISSUER, subject: 'ms-sub-second', providerUserId: MAILBOX,
      });
      await storeOAuthGrant(client, {
        connectionId,
        audience: MICROSOFT_GRANT_AUDIENCE,
        accessToken: 'graph-access-valid',
        refreshToken: null,
        expiresAt: new Date(Date.now() + 3600_000),
        scopes: ['https://graph.microsoft.com/Mail.ReadWrite', 'https://graph.microsoft.com/Mail.Send'],
        clientIdAtIssue: CONFIG.clientId,
      });
    });

    const result = await cutOverMicrosoftMailAccount({ userId: USER_ID, accountId: ACCOUNT_ID, discoverFolders: false });
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.code).toBe('ACCOUNT_MIGRATION_CONNECTION_REQUIRED');
    // A request-shape problem is not recorded as an account state.
    expect(result.recorded).toBe(false);
    expect((await readAccount(ACCOUNT_ID))?.migration_state).toBe('not_applicable');
  });

  it('refuses an explicit connection for another mailbox unless the caller says the difference is intended', async () => {
    // The connection belongs to the same user but its verified identity is another address (an alias, or
    // a second mailbox). Auto-resolution must not guess, and the explicit choice must not silently change
    // which mailbox the account operates on: after the switch Inboxora would read and send that other
    // mailbox while the account still says this one. So the deliberate case is explicit too.
    const { connectionId } = await seedMicrosoftAccount({ providerUserId: 'other-alias@contoso.test' });

    const auto = await cutOverMicrosoftMailAccount({ userId: USER_ID, accountId: ACCOUNT_ID, discoverFolders: false });
    expect(auto.status).toBe('refused');
    if (auto.status === 'refused') expect(auto.code).toBe('PROVIDER_AUTH_REQUIRED');

    const refused = await cutOverMicrosoftMailAccount({
      userId: USER_ID, accountId: ACCOUNT_ID, connectionId, discoverFolders: false,
    });
    expect(refused.status).toBe('refused');
    if (refused.status === 'refused') {
      expect(refused.code).toBe('ACCOUNT_MIGRATION_IDENTITY_MISMATCH');
      expect(refused.message).toContain('other-alias@contoso.test');
    }
    // Refused means nothing was switched. This refusal is a request-shape problem, not an account state,
    // so it records nothing — unlike a missing grant, which records `authorization_required`.
    expect((await readAccount(ACCOUNT_ID))?.mail_transport).toBeNull();
    if (refused.status === 'refused') {
      expect(refused.migrationState).toBeNull();
      expect(refused.recorded).toBe(false);
    }

    const deliberate = await cutOverMicrosoftMailAccount({
      userId: USER_ID, accountId: ACCOUNT_ID, connectionId, allowIdentityMismatch: true, discoverFolders: false,
    });
    expect(deliberate.status).toBe('migrated');
    if (deliberate.status === 'migrated') expect(deliberate.connectionId).toBe(connectionId);
  });

  it('refuses an account the actor does not own, changing nothing', async () => {
    const mine = await seedMicrosoftAccount();
    await seedMicrosoftAccount({ userId: OTHER_USER_ID, accountId: OTHER_ACCOUNT_ID, email: 'other@contoso.test' });

    // Another user's account id, this user's session.
    await expect(cutOverMicrosoftMailAccount({ userId: USER_ID, accountId: OTHER_ACCOUNT_ID, discoverFolders: false }))
      .resolves.toEqual({ status: 'not_found' });
    // This user's own account, but named under the other user's session.
    await expect(cutOverMicrosoftMailAccount({ userId: OTHER_USER_ID, accountId: ACCOUNT_ID, discoverFolders: false }))
      .resolves.toEqual({ status: 'not_found' });
    // Another user's connection named explicitly for this user's account.
    const theirs = await autocommit(client => client.query<{ id: string }>(
      'SELECT id FROM provider_connections WHERE user_id = $1', [OTHER_USER_ID],
    ));
    const forged = await cutOverMicrosoftMailAccount({
      userId: USER_ID, accountId: ACCOUNT_ID, connectionId: theirs.rows[0]?.id, discoverFolders: false,
    });
    expect(forged.status).toBe('refused');
    if (forged.status === 'refused') expect(forged.code).toBe('ACCOUNT_MIGRATION_CONNECTION_INVALID');

    // Both accounts are exactly as they were.
    for (const accountId of [ACCOUNT_ID, OTHER_ACCOUNT_ID]) {
      expect(await readAccount(accountId)).toMatchObject({
        mail_transport: null, provider_connection_id: null, migration_state: 'not_applicable',
      });
    }
    expect(mine.connectionId).toBeTruthy();
  });

  it('refuses an account that is not a Microsoft account', async () => {
    await inTransaction(client => client.query(
      `INSERT INTO email_accounts (id, user_id, name, email_address, protocol, imap_host, oauth_provider)
       VALUES ($1, $2, 'Gmail', 'sam@gmail.test', 'imap', 'imap.gmail.com', 'google')`,
      [ACCOUNT_ID, USER_ID],
    ));

    const result = await cutOverMicrosoftMailAccount({ userId: USER_ID, accountId: ACCOUNT_ID, discoverFolders: false });
    expect(result).toMatchObject({ status: 'not_applicable', reason: expect.stringContaining('not a Microsoft account') });
    expect((await readAccount(ACCOUNT_ID))?.migration_state).toBe('not_applicable');
  });

  it('activates the account for the schedule: discovery creates the collections the refresh visits', async () => {
    const { connectionId } = await seedMicrosoftAccount();
    const provider = fakeFolders([TREE, CHILDREN, NO_CHILDREN]);

    const result = await cutOverMicrosoftMailAccount({
      userId: USER_ID, accountId: ACCOUNT_ID, config: CONFIG, fetchImpl: provider.fetchImpl,
    });

    expect(result.status).toBe('migrated');
    if (result.status !== 'migrated') return;
    expect(result.foldersDiscovered).toBe(true);
    expect(result.folders).toBe(3);
    expect(provider.urls[0]).toContain('/me/mailFolders');

    // The folders are local and linked to their Graph ids, which is what the message sync needs.
    const folders = await autocommit(client => client.query<{ path: string }>(
      'SELECT path FROM folders WHERE account_id = $1 ORDER BY path', [ACCOUNT_ID],
    ));
    expect(folders.rows.map(row => row.path)).toEqual(['INBOX', 'INBOX/Work', 'Sent']);

    // And the refresh schedule — which only visits collections that already exist — now sees it.
    const targets = await listProviderSyncTargets();
    const target = targets.find(candidate => candidate.connectionId === connectionId);
    expect(target?.features).toContain('mail_folder');
  });

  it('migrates a legacy Outlook account that has no oauth_provider recorded', async () => {
    // Exactly what a 4.0.4 installation holds: the Microsoft host, a NULL `oauth_provider` (the column was
    // not written for these accounts) and no native transport. The recommendation and the cutover have to
    // agree that this is a Microsoft account, or the user is offered a migration that refuses to run.
    await inTransaction(async client => {
      await upsertProviderConnection(client, {
        userId: USER_ID, provider: 'microsoft', issuer: MICROSOFT_ISSUER, subject: 'legacy-ms',
        providerUserId: 'dragonk93@outlook.com',
      }).then(connectionId => storeOAuthGrant(client, {
        connectionId,
        audience: MICROSOFT_GRANT_AUDIENCE,
        accessToken: 'graph-access-legacy',
        refreshToken: 'graph-refresh-legacy',
        expiresAt: new Date(Date.now() + 3600_000),
        scopes: ['https://graph.microsoft.com/Mail.ReadWrite', 'https://graph.microsoft.com/Mail.Send'],
        clientIdAtIssue: CONFIG.clientId,
      }));
      await client.query(
        `INSERT INTO email_accounts (id, user_id, name, email_address, protocol, imap_host, oauth_provider, migration_state)
         VALUES ($1, $2, 'Outlook (legacy)', 'dragonk93@outlook.com', 'imap', 'outlook.office365.com', NULL, 'not_applicable')`,
        [ACCOUNT_ID, USER_ID],
      );
    });

    const result = await cutOverMicrosoftMailAccount({ userId: USER_ID, accountId: ACCOUNT_ID, discoverFolders: false });

    expect(result.status).toBe('migrated');
    if (result.status !== 'migrated') return;
    // The same account, now native, and still exactly one row for that mailbox.
    expect(result.account.id).toBe(ACCOUNT_ID);
    expect(result.account.mail_transport).toBe('microsoft_graph');
    expect(result.account.protocol).toBe('microsoft_graph');
    const rows = await autocommit(client => client.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM email_accounts WHERE user_id = $1', [USER_ID],
    ));
    expect(rows.rows[0]?.count).toBe('1');
  });

  it('does not un-migrate when post-switch folder discovery fails', async () => {
    await seedMicrosoftAccount();
    const failing = fakeFolders([() => json({ error: { code: 'ErrorAccessDenied', message: 'no mailbox' } }, 403)]);

    const result = await cutOverMicrosoftMailAccount({
      userId: USER_ID, accountId: ACCOUNT_ID, config: CONFIG, fetchImpl: failing.fetchImpl,
    });

    // The switch is what the caller asked for; discovery is a retryable sync concern.
    expect(result.status).toBe('migrated');
    if (result.status !== 'migrated') return;
    expect(result.foldersDiscovered).toBe(false);
    expect(await readAccount(ACCOUNT_ID)).toMatchObject({
      mail_transport: 'microsoft_graph', migration_state: 'active_native',
    });
  });
});

describe('Graph scope coverage', () => {
  it('normalises the full and short scope forms identically', () => {
    expect(normaliseGraphScope('https://graph.microsoft.com/Mail.ReadWrite')).toBe('mail.readwrite');
    expect(normaliseGraphScope('Mail.ReadWrite')).toBe('mail.readwrite');
    expect(normaliseGraphScope('  https://graph.microsoft.com/Mail.Send  ')).toBe('mail.send');
  });

  it('reports the missing mail scopes, and accepts a superset spelling', () => {
    expect(missingGraphMailScopes(['Mail.ReadWrite', 'https://graph.microsoft.com/Mail.Send'])).toEqual([]);
    expect(missingGraphMailScopes(['Mail.ReadWrite.All', 'Mail.Send.Shared'])).toEqual([]);
    expect(missingGraphMailScopes(['https://graph.microsoft.com/Mail.ReadWrite'])).toEqual(['Mail.Send']);
    expect(missingGraphMailScopes(['Calendars.ReadWrite'])).toEqual(['Mail.ReadWrite', 'Mail.Send']);
    expect(missingGraphMailScopes([])).toEqual(['Mail.ReadWrite', 'Mail.Send']);
  });
});
