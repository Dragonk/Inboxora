// Real PostgreSQL tests for the P12 in-place Gmail API cutover.
//
// The provider is faked only where label discovery is exercised; the switch itself, the state bookkeeping,
// ownership, idempotency and the survival of local data are all real database behaviour. Run with:
//
//   DB_HOST=127.0.0.1 DB_PORT=55432 DB_NAME=<db> DB_USER=mailflow_test DB_PASSWORD=mailflow_test \
//     npx vitest run src/services/providerGoogleMailCutover.integration.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { pool } from './db.js';
import {
  GOOGLE_GRANT_AUDIENCE,
  GOOGLE_ISSUER,
  storeOAuthGrant,
  upsertProviderConnection,
} from './providerAuthService.js';
import { resolveMailTransportForSync } from './mailTransportTarget.js';
import { listGmailMailAccounts } from './providers/google/gmailMailSync.js';
import {
  cutOverGoogleMailAccount,
  missingGmailMailScopes,
  normaliseGoogleScope,
} from './providerGoogleMailCutover.js';

const hasPg = process.env.DB_HOST && process.env.DB_NAME;
const describeOrSkip = hasPg ? describe : describe.skip;

const USER_ID = '00000000-0000-0000-0000-00000000d001';
const OTHER_USER_ID = '00000000-0000-0000-0000-00000000d002';
const ACCOUNT_ID = '00000000-0000-0000-0000-00000000d011';
const OTHER_ACCOUNT_ID = '00000000-0000-0000-0000-00000000d012';
const MAILBOX = 'ada@gmail.test';
const CONFIG = {
  clientId: 'client-g', clientSecret: 'secret-g', redirectUri: 'https://x/oauth/google/callback',
};
const originalKey = process.env.ENCRYPTION_KEY;
const originalClientId = process.env.GOOGLE_CLIENT_ID;

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

async function autocommit<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { return await fn(client); } finally { client.release(); }
}

interface SeedOptions {
  userId?: string; accountId?: string; email?: string;
  providerUserId?: string | null; scopes?: string[]; connectionStatus?: string;
  withAccount?: boolean; mailTransport?: string | null;
}

/** An existing Google IMAP account and the connection + grant a Gmail authorization would have produced. */
async function seedGoogleAccount(options: SeedOptions = {}): Promise<{ connectionId: string; accountId: string; userId: string }> {
  const userId = options.userId ?? USER_ID;
  const accountId = options.accountId ?? ACCOUNT_ID;
  const email = options.email ?? MAILBOX;
  const providerUserId = options.providerUserId === undefined ? email : options.providerUserId;
  const scopes = options.scopes ?? ['https://www.googleapis.com/auth/gmail.modify'];
  return inTransaction(async client => {
    const connectionId = await upsertProviderConnection(client, {
      userId, provider: 'google', issuer: GOOGLE_ISSUER, subject: `g-sub-${accountId}`,
      providerUserId,
    });
    if (options.connectionStatus && options.connectionStatus !== 'active') {
      await client.query('UPDATE provider_connections SET status = $2 WHERE id = $1', [connectionId, options.connectionStatus]);
    }
    await storeOAuthGrant(client, {
      connectionId,
      audience: GOOGLE_GRANT_AUDIENCE,
      accessToken: 'google-access-valid',
      refreshToken: 'google-refresh-1',
      expiresAt: new Date(Date.now() + 3600_000),
      scopes,
      clientIdAtIssue: CONFIG.clientId,
    });
    if (options.withAccount !== false) {
      await client.query(
        `INSERT INTO email_accounts
           (id, user_id, name, email_address, protocol, imap_host, oauth_provider, mail_transport, migration_state)
         VALUES ($1, $2, 'Gmail', $3, 'imap', 'imap.gmail.com', 'google', $4, 'not_applicable')`,
        [accountId, userId, email, options.mailTransport ?? null],
      );
    }
    return { connectionId, accountId, userId };
  });
}

async function readAccount(accountId: string) {
  const result = await autocommit(client => client.query<{
    id: string; email_address: string; mail_transport: string | null; protocol: string | null;
    provider_connection_id: string | null; provider_mailbox_id: string | null;
    migration_state: string; migration_required: boolean; migration_error_code: string | null;
    mail_method_preference: string | null; transport_generation: string;
  }>(
    `SELECT id, email_address, mail_transport, protocol, provider_connection_id, provider_mailbox_id,
            migration_state, migration_required, migration_error_code, mail_method_preference, transport_generation
       FROM email_accounts WHERE id = $1`,
    [accountId],
  ));
  return result.rows[0] ?? null;
}

describeOrSkip('cutOverGoogleMailAccount (PostgreSQL)', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    process.env.GOOGLE_CLIENT_ID = CONFIG.clientId;
    process.env.GOOGLE_CLIENT_SECRET = CONFIG.clientSecret;
    process.env.GOOGLE_REDIRECT_URI = CONFIG.redirectUri;
    await autocommit(async client => {
      for (const [id, username] of [[USER_ID, 'g-cutover-1'], [OTHER_USER_ID, 'g-cutover-2']] as const) {
        await client.query('INSERT INTO users (id, username) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [id, username]);
      }
    });
  });

  afterAll(async () => {
    await autocommit(client => client.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[USER_ID, OTHER_USER_ID]]));
    if (originalKey === undefined) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = originalKey;
    if (originalClientId === undefined) delete process.env.GOOGLE_CLIENT_ID; else process.env.GOOGLE_CLIENT_ID = originalClientId;
  });

  beforeEach(async () => {
    await autocommit(async client => {
      await client.query('DELETE FROM provider_connections WHERE user_id = ANY($1::uuid[])', [[USER_ID, OTHER_USER_ID]]);
      await client.query('DELETE FROM email_accounts WHERE user_id = ANY($1::uuid[])', [[USER_ID, OTHER_USER_ID]]);
    });
  });

  it('moves the account in place, keeping its id and its local data', async () => {
    const { connectionId } = await seedGoogleAccount();
    // Local data the account owns, in the real tables: folders, messages, an alias, a conversation and a
    // contact. None of it may move or disappear because the transport changed.
    await autocommit(async client => {
      await client.query(
        `INSERT INTO folders (account_id, path, name, special_use) VALUES
           ($1, 'INBOX', 'Inbox', '\\Inbox'), ($1, 'Sent', 'Sent', '\\Sent')`,
        [ACCOUNT_ID],
      );
      await client.query(
        `INSERT INTO messages (account_id, uid, folder, message_id, subject, body_text, is_read) VALUES
           ($1, 1, 'INBOX', '<keep-1@gmail.test>', 'Quarterly plan', 'body one', false)`,
        [ACCOUNT_ID],
      );
      await client.query(
        `INSERT INTO account_aliases (account_id, name, email) VALUES ($1, 'Ada (alias)', 'ada+alias@gmail.test')`,
        [ACCOUNT_ID],
      );
      await client.query(
        `INSERT INTO conversations (user_id, account_id, subject_snapshot, copy_count) VALUES ($1, $2, 'Quarterly plan', 1)`,
        [USER_ID, ACCOUNT_ID],
      );
    });
    const contact = await autocommit(async client => {
      const book = await client.query<{ id: string }>(
        `INSERT INTO address_books (user_id, name) VALUES ($1, 'Contacts') RETURNING id`,
        [USER_ID],
      );
      return client.query<{ id: string }>(
        `INSERT INTO contacts (user_id, address_book_id, display_name, uid) VALUES ($1, $2, 'Ada', $3) RETURNING id`,
        [USER_ID, book.rows[0]?.id, crypto.randomUUID()],
      );
    });

    const result = await cutOverGoogleMailAccount({ userId: USER_ID, accountId: ACCOUNT_ID, config: CONFIG, discoverLabels: false });

    expect(result.status).toBe('migrated');
    if (result.status !== 'migrated') return;
    expect(result.account.id).toBe(ACCOUNT_ID);
    expect(result.account.mail_transport).toBe('gmail_api');
    expect(result.account.protocol).toBe('gmail_api');
    expect(result.account.provider_connection_id).toBe(connectionId);
    expect(result.account.migration_state).toBe('active_native');

    const stored = await readAccount(ACCOUNT_ID);
    expect(stored?.mail_transport).toBe('gmail_api');
    expect(stored?.protocol).toBe('gmail_api');
    expect(stored?.migration_error_code).toBeNull();
    // No second account for the same mailbox.
    const accounts = await autocommit(client => client.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM email_accounts WHERE user_id = $1', [USER_ID],
    ));
    expect(accounts.rows[0]?.count).toBe('1');
    // The account's own rows survive, still pointing at the same account id.
    const kept = await autocommit(async client => ({
      folders: (await client.query('SELECT path FROM folders WHERE account_id = $1 ORDER BY path', [ACCOUNT_ID])).rows,
      messages: (await client.query('SELECT uid, subject FROM messages WHERE account_id = $1 ORDER BY uid', [ACCOUNT_ID])).rows,
      aliases: (await client.query('SELECT email FROM account_aliases WHERE account_id = $1', [ACCOUNT_ID])).rows,
      conversations: (await client.query('SELECT subject_snapshot FROM conversations WHERE account_id = $1', [ACCOUNT_ID])).rows,
    }));
    expect(kept.folders.map(row => row.path)).toEqual(['INBOX', 'Sent']);
    expect(kept.messages).toHaveLength(1);
    expect(kept.aliases.map(row => row.email)).toEqual(['ada+alias@gmail.test']);
    expect(kept.conversations).toHaveLength(1);
    expect((await autocommit(client => client.query('SELECT id FROM contacts WHERE id = $1', [contact.rows[0]?.id]))).rows).toHaveLength(1);
    // And the transport resolution every account-scoped operation uses now answers the Gmail path.
    await expect(resolveMailTransportForSync(USER_ID, ACCOUNT_ID)).resolves.toMatchObject({ kind: 'gmail' });
    // The Gmail sync's own account list answers with this account, which is what the label and message
    // syncs iterate — the same proof the Microsoft suite makes for Graph.
    await expect(autocommit(client => listGmailMailAccounts(client, { userId: USER_ID, connectionId })))
      .resolves.toEqual([ACCOUNT_ID]);
  });

  it('migrates a legacy Gmail account added over IMAP with an app password', async () => {
    // The real 4.0.4 shape: a Gmail IMAP host, an app-password account, `oauth_provider` NULL and no native
    // transport. The recommendation card offers "Migrate to the Google API" for exactly this account, so the
    // cutover must classify it as Google and perform the switch rather than answering "not applicable".
    await inTransaction(async client => {
      await upsertProviderConnection(client, {
        userId: USER_ID, provider: 'google', issuer: GOOGLE_ISSUER, subject: 'legacy-gmail',
        providerUserId: 'kmaciag93@gmail.com',
      }).then(connectionId => storeOAuthGrant(client, {
        connectionId,
        audience: GOOGLE_GRANT_AUDIENCE,
        accessToken: 'google-access-legacy',
        refreshToken: 'google-refresh-legacy',
        expiresAt: new Date(Date.now() + 3600_000),
        scopes: ['https://www.googleapis.com/auth/gmail.modify'],
        clientIdAtIssue: CONFIG.clientId,
      }));
      await client.query(
        `INSERT INTO email_accounts (id, user_id, name, email_address, protocol, imap_host, oauth_provider, mail_transport, migration_state)
         VALUES ($1, $2, 'Gmail (legacy)', 'kmaciag93@gmail.com', 'imap', 'imap.gmail.com', NULL, NULL, 'not_applicable')`,
        [ACCOUNT_ID, USER_ID],
      );
    });

    const result = await cutOverGoogleMailAccount({ userId: USER_ID, accountId: ACCOUNT_ID, discoverLabels: false });

    expect(result.status).toBe('migrated');
    if (result.status !== 'migrated') return;
    expect(result.account.id).toBe(ACCOUNT_ID);
    expect(result.account.mail_transport).toBe('gmail_api');
    expect(result.account.protocol).toBe('gmail_api');
    const rows = await autocommit(client => client.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM email_accounts WHERE user_id = $1', [USER_ID],
    ));
    expect(rows.rows[0]?.count).toBe('1');
  });

  it('is idempotent: a retry on a migrated account is a no-op', async () => {
    const { connectionId } = await seedGoogleAccount();
    const first = await cutOverGoogleMailAccount({ userId: USER_ID, accountId: ACCOUNT_ID, config: CONFIG, discoverLabels: false });
    expect(first.status).toBe('migrated');
    const generation = (await readAccount(ACCOUNT_ID))?.transport_generation;

    const second = await cutOverGoogleMailAccount({ userId: USER_ID, accountId: ACCOUNT_ID, config: CONFIG, discoverLabels: false });

    expect(second.status).toBe('already_native');
    if (second.status === 'already_native') expect(second.connectionId).toBe(connectionId);
    expect((await readAccount(ACCOUNT_ID))?.transport_generation).toBe(generation);
  });

  it('refuses a connection owned by another user', async () => {
    const { connectionId } = await seedGoogleAccount({ userId: OTHER_USER_ID, accountId: OTHER_ACCOUNT_ID });
    await seedGoogleAccount();

    const result = await cutOverGoogleMailAccount({
      userId: USER_ID, accountId: ACCOUNT_ID, connectionId, config: CONFIG, discoverLabels: false,
    });

    expect(result).toMatchObject({ status: 'refused', code: 'ACCOUNT_MIGRATION_CONNECTION_INVALID' });
    expect((await readAccount(ACCOUNT_ID))?.mail_transport).toBeNull();
  });

  it('refuses a connection for a different mailbox and leaves the transport alone', async () => {
    const { connectionId } = await seedGoogleAccount({
      accountId: OTHER_ACCOUNT_ID, email: 'someone-else@gmail.test',
    });
    await seedGoogleAccount();

    const result = await cutOverGoogleMailAccount({
      userId: USER_ID, accountId: ACCOUNT_ID, connectionId, config: CONFIG, discoverLabels: false,
    });

    expect(result).toMatchObject({ status: 'refused', code: 'ACCOUNT_MIGRATION_IDENTITY_MISMATCH' });
    const stored = await readAccount(ACCOUNT_ID);
    expect(stored?.mail_transport).toBeNull();
    // A request-shaped refusal records no account state at all.
    expect(stored?.migration_state).toBe('not_applicable');
  });

  it('refuses a grant without the Gmail scope and records authorization_required', async () => {
    // A Calendar/People authorization on the same connection is not a mail authorization.
    await seedGoogleAccount({ scopes: ['https://www.googleapis.com/auth/calendar.events'] });

    const result = await cutOverGoogleMailAccount({ userId: USER_ID, accountId: ACCOUNT_ID, config: CONFIG, discoverLabels: false });

    expect(result).toMatchObject({ status: 'refused', code: 'PROVIDER_AUTH_REQUIRED', missingScopes: ['gmail.modify'] });
    const stored = await readAccount(ACCOUNT_ID);
    expect(stored?.mail_transport).toBeNull();
    expect(stored?.protocol).toBe('imap');
    expect(stored?.migration_state).toBe('authorization_required');
    expect(stored?.migration_error_code).toBe('PROVIDER_AUTH_REQUIRED');
  });

  it('keeps the IMAP transport when there is no Google connection at all', async () => {
    await seedGoogleAccount({ withAccount: true, providerUserId: 'different@gmail.test' });

    const result = await cutOverGoogleMailAccount({ userId: USER_ID, accountId: ACCOUNT_ID, config: CONFIG, discoverLabels: false });

    expect(result).toMatchObject({ status: 'refused', code: 'PROVIDER_AUTH_REQUIRED' });
    expect((await readAccount(ACCOUNT_ID))?.mail_transport).toBeNull();
  });

  it('reports itself as not applicable for an account that is not Google', async () => {
    await autocommit(client => client.query(
      `INSERT INTO email_accounts (id, user_id, name, email_address, protocol, imap_host, oauth_provider)
       VALUES ($1, $2, 'Other', 'other@example.test', 'imap', 'imap.example.test', 'microsoft')`,
      [ACCOUNT_ID, USER_ID],
    ));

    const result = await cutOverGoogleMailAccount({ userId: USER_ID, accountId: ACCOUNT_ID, config: CONFIG, discoverLabels: false });

    expect(result.status).toBe('not_applicable');
  });

  it('reads the Gmail scope strictly and prefix-aware', () => {
    expect(missingGmailMailScopes(['https://www.googleapis.com/auth/gmail.modify'])).toEqual([]);
    expect(missingGmailMailScopes(['gmail.modify'])).toEqual([]);
    expect(missingGmailMailScopes(['https://www.googleapis.com/auth/gmail.modify.all'])).toEqual([]);
    expect(missingGmailMailScopes(['https://www.googleapis.com/auth/gmail.readonly'])).toEqual(['gmail.modify']);
    expect(missingGmailMailScopes([])).toEqual(['gmail.modify']);
    expect(normaliseGoogleScope('https://www.googleapis.com/auth/gmail.modify')).toBe('gmail.modify');
    expect(normaliseGoogleScope('gmail.modify')).toBe('gmail.modify');
  });
});
