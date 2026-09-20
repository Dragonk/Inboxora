// Real PostgreSQL tests for `createNativeMailAccount` — the path that adds a mailbox natively.
//
// This is the release's critical account-creation path: a user signs in with Microsoft or Google and the
// account is written directly on `microsoft_graph` or `gmail_api`. The row, the transport columns, the
// absence of IMAP credentials, the connection ownership, the duplicate answer and the idempotent retry are
// database facts, so they are asserted against a real database rather than a mocked service.
//
//   DB_HOST=127.0.0.1 DB_PORT=55432 DB_NAME=<db> DB_USER=mailflow_test DB_PASSWORD=mailflow_test \
//     npx vitest run src/services/nativeAccountService.integration.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { pool } from './db.js';
import {
  GOOGLE_GRANT_AUDIENCE,
  GOOGLE_ISSUER,
  MICROSOFT_GRANT_AUDIENCE,
  MICROSOFT_ISSUER,
  storeOAuthGrant,
  upsertProviderConnection,
} from './providerAuthService.js';
import { createNativeMailAccount } from './nativeAccountService.js';

const hasPg = process.env.DB_HOST && process.env.DB_NAME;
const describeOrSkip = hasPg ? describe : describe.skip;

const USER_ID = '00000000-0000-0000-0000-00000000a001';
const OTHER_USER_ID = '00000000-0000-0000-0000-00000000a002';
const IMAP_ACCOUNT_ID = '00000000-0000-0000-0000-00000000a011';
const MAILBOX = 'native@gmail.test';
const originalKey = process.env.ENCRYPTION_KEY;

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

/** An authorized mailbox: a connection with a verified address and an active grant. */
async function seedConnection(input: {
  userId?: string;
  provider?: 'microsoft' | 'google';
  address?: string | null;
  subject?: string;
  scopes?: string[];
} = {}): Promise<string> {
  const provider = input.provider ?? 'google';
  const userId = input.userId ?? USER_ID;
  const address = input.address === undefined ? MAILBOX : input.address;
  return inTransaction(async client => {
    const connectionId = await upsertProviderConnection(client, {
      userId,
      provider,
      issuer: provider === 'google' ? GOOGLE_ISSUER : MICROSOFT_ISSUER,
      subject: input.subject ?? `${provider}-subject`,
      providerUserId: address,
    });
    await storeOAuthGrant(client, {
      connectionId,
      audience: provider === 'google' ? GOOGLE_GRANT_AUDIENCE : MICROSOFT_GRANT_AUDIENCE,
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: new Date(Date.now() + 3600_000),
      scopes: input.scopes ?? (provider === 'google'
        ? ['https://www.googleapis.com/auth/gmail.modify']
        : ['https://graph.microsoft.com/Mail.ReadWrite', 'https://graph.microsoft.com/Mail.Send']),
      clientIdAtIssue: 'client-1',
    });
    return connectionId;
  });
}

async function accountsFor(userId = USER_ID) {
  const result = await autocommit(client => client.query<{
    id: string; email_address: string; name: string | null; protocol: string | null;
    mail_transport: string | null; provider_connection_id: string | null; provider_mailbox_id: string | null;
    migration_state: string | null; imap_host: string | null; imap_port: number | null;
    auth_user: string | null; auth_pass: string | null; smtp_host: string | null; smtp_port: number | null;
    oauth_access_token: string | null;
  }>(
    `SELECT id, email_address, name, protocol, mail_transport, provider_connection_id, provider_mailbox_id,
            migration_state, imap_host, imap_port, auth_user, auth_pass, smtp_host, smtp_port, oauth_access_token
       FROM email_accounts WHERE user_id = $1 ORDER BY created_at`,
    [userId],
  ));
  return result.rows;
}

describeOrSkip('createNativeMailAccount (PostgreSQL)', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY ||= 'b'.repeat(64);
    await autocommit(async client => {
      for (const [id, username] of [[USER_ID, 'native-user'], [OTHER_USER_ID, 'native-other']] as const) {
        await client.query('INSERT INTO users (id, username) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [id, username]);
      }
    });
  });

  afterAll(async () => {
    await autocommit(async client => {
      await client.query('DELETE FROM email_accounts WHERE user_id = ANY($1::uuid[])', [[USER_ID, OTHER_USER_ID]]);
      await client.query('DELETE FROM provider_connections WHERE user_id = ANY($1::uuid[])', [[USER_ID, OTHER_USER_ID]]);
      await client.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[USER_ID, OTHER_USER_ID]]);
    });
    if (originalKey === undefined) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = originalKey;
  });

  beforeEach(async () => {
    await autocommit(async client => {
      await client.query('DELETE FROM email_accounts WHERE user_id = ANY($1::uuid[])', [[USER_ID, OTHER_USER_ID]]);
      await client.query('DELETE FROM provider_connections WHERE user_id = ANY($1::uuid[])', [[USER_ID, OTHER_USER_ID]]);
    });
  });

  it('writes a Gmail API account with no IMAP configuration at all', async () => {
    const connectionId = await seedConnection({ provider: 'google' });

    const result = await createNativeMailAccount({ userId: USER_ID, provider: 'google', connectionId, discover: false });

    expect(result.status).toBe('created');
    const rows = await accountsFor();
    expect(rows).toHaveLength(1);
    const account = rows[0]!;
    expect(account.mail_transport).toBe('gmail_api');
    expect(account.protocol).toBe('gmail_api');
    expect(account.email_address).toBe(MAILBOX);
    expect(account.name).toBe(MAILBOX);
    expect(account.provider_connection_id).toBe(connectionId);
    expect(account.provider_mailbox_id).toBeTruthy();
    expect(account.migration_state).toBe('active_native');
    // Nothing IMAP/SMTP: no host, no port, no login, no password, no OAuth2-IMAP token.
    for (const field of ['imap_host', 'auth_user', 'auth_pass', 'smtp_host', 'oauth_access_token'] as const) {
      expect(account[field], `${field} must stay empty for a native account`).toBeNull();
    }
    expect(account.imap_port).toBeNull();
    expect(account.smtp_port).toBeNull();
    // The foreign key resolves: the account really is bound to that connection.
    const joined = await autocommit(client => client.query(
      `SELECT c.provider FROM email_accounts a JOIN provider_connections c ON c.id = a.provider_connection_id
        WHERE a.id = $1`,
      [account.id],
    ));
    expect(joined.rows[0]?.provider).toBe('google');
  });

  it('takes the mailbox identity from the provider, and refuses one it does not report', async () => {
    const connectionId = await seedConnection({ provider: 'google', address: 'from-provider@gmail.test' });
    await createNativeMailAccount({ userId: USER_ID, provider: 'google', connectionId, discover: false });
    expect((await accountsFor())[0]?.email_address).toBe('from-provider@gmail.test');

    await autocommit(client => client.query('DELETE FROM email_accounts WHERE user_id = $1', [USER_ID]));
    const anonymous = await seedConnection({ provider: 'google', address: null, subject: 'no-address' });
    const refused = await createNativeMailAccount({ userId: USER_ID, provider: 'google', connectionId: anonymous, discover: false });
    expect(refused).toMatchObject({ status: 'refused', code: 'PROVIDER_IDENTITY_MISSING' });
    // Nothing was written: the refusal happens before the insert.
    expect(await accountsFor()).toHaveLength(0);
  });

  it('is idempotent: a second call finds the native account instead of adding another', async () => {
    const connectionId = await seedConnection({ provider: 'microsoft' });
    const first = await createNativeMailAccount({ userId: USER_ID, provider: 'microsoft', connectionId, discover: false });
    expect(first.status).toBe('created');

    const second = await createNativeMailAccount({ userId: USER_ID, provider: 'microsoft', connectionId, discover: false });

    expect(second.status).toBe('exists_native');
    const rows = await accountsFor();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.mail_transport).toBe('microsoft_graph');
    if (first.status === 'created' && second.status === 'exists_native') {
      expect(second.account.id).toBe(first.account.id);
    }
  });

  it('never duplicates a mailbox that is already added over IMAP, and names the migration', async () => {
    await autocommit(client => client.query(
      `INSERT INTO email_accounts (id, user_id, name, email_address, protocol, imap_host, imap_port, enabled)
       VALUES ($1, $2, 'Legacy Gmail', $3, 'imap', 'imap.gmail.com', 993, true)`,
      [IMAP_ACCOUNT_ID, USER_ID, MAILBOX],
    ));
    const connectionId = await seedConnection({ provider: 'google' });

    const result = await createNativeMailAccount({ userId: USER_ID, provider: 'google', connectionId, discover: false });

    expect(result).toMatchObject({
      status: 'exists_other_transport',
      code: 'ACCOUNT_EXISTS',
      existingAccountId: IMAP_ACCOUNT_ID,
      existingTransport: 'imap_smtp',
      suggestion: 'migrate_google',
    });
    const rows = await accountsFor();
    expect(rows).toHaveLength(1);
    // The existing account was not touched: no transport change, no provider binding.
    expect(rows[0]?.id).toBe(IMAP_ACCOUNT_ID);
    expect(rows[0]?.mail_transport).toBeNull();
    expect(rows[0]?.provider_connection_id).toBeNull();
  });

  it('refuses a connection that belongs to another user, writing nothing', async () => {
    const foreign = await seedConnection({ userId: OTHER_USER_ID, provider: 'google' });

    const result = await createNativeMailAccount({ userId: USER_ID, provider: 'google', connectionId: foreign, discover: false });

    expect(result).toMatchObject({ status: 'refused', code: 'CONNECTION_NOT_FOUND' });
    expect(await accountsFor()).toHaveLength(0);
    expect(await accountsFor(OTHER_USER_ID)).toHaveLength(0);
  });

  it('refuses a connection of the other provider and a connection that is not active', async () => {
    const microsoft = await seedConnection({ provider: 'microsoft', subject: 'ms-1' });
    const wrongProvider = await createNativeMailAccount({ userId: USER_ID, provider: 'google', connectionId: microsoft, discover: false });
    expect(wrongProvider).toMatchObject({ status: 'refused', code: 'CONNECTION_PROVIDER_MISMATCH' });

    const google = await seedConnection({ provider: 'google', subject: 'g-revoked' });
    await autocommit(client => client.query("UPDATE provider_connections SET status = 'revoked' WHERE id = $1", [google]));
    const revoked = await createNativeMailAccount({ userId: USER_ID, provider: 'google', connectionId: google, discover: false });
    expect(revoked).toMatchObject({ status: 'refused', code: 'PROVIDER_AUTH_REQUIRED' });

    expect(await accountsFor()).toHaveLength(0);
  });

  it('refuses when the caller has no authorization for that provider yet', async () => {
    const result = await createNativeMailAccount({ userId: USER_ID, provider: 'microsoft', discover: false });

    expect(result).toMatchObject({ status: 'refused', code: 'PROVIDER_AUTH_REQUIRED' });
    expect(await accountsFor()).toHaveLength(0);
  });

  it('refuses an ambiguous choice rather than guessing which connection to bind', async () => {
    // Two Google connections of one user is the normal contacts + mail situation; a create without a named
    // connection must not pick one.
    await seedConnection({ provider: 'google', subject: 'g-contacts', address: 'contacts@gmail.test' });
    await seedConnection({ provider: 'google', subject: 'g-mail', address: 'mail@gmail.test' });

    const result = await createNativeMailAccount({ userId: USER_ID, provider: 'google', discover: false });

    expect(result).toMatchObject({ status: 'refused', code: 'CONNECTION_REQUIRED' });
    expect(await accountsFor()).toHaveLength(0);
  });

  it('binds the requested connection when the caller names one', async () => {
    await seedConnection({ provider: 'google', subject: 'g-contacts', address: 'contacts@gmail.test' });
    const mailConnection = await seedConnection({ provider: 'google', subject: 'g-mail', address: 'mail@gmail.test' });

    const result = await createNativeMailAccount({ userId: USER_ID, provider: 'google', connectionId: mailConnection, discover: false });

    expect(result.status).toBe('created');
    const rows = await accountsFor();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.email_address).toBe('mail@gmail.test');
    expect(rows[0]?.provider_connection_id).toBe(mailConnection);
  });

  it('rolls back completely when the insert cannot complete', async () => {
    const connectionId = await seedConnection({ provider: 'google' });
    // A check that makes the insert fail after the transaction opened: the account name column is NOT NULL in
    // the fixture's insert, so an over-long address is refused by the database itself.
    const long = `${'x'.repeat(500)}@gmail.test`;
    await autocommit(client => client.query('UPDATE provider_connections SET provider_user_id = $2 WHERE id = $1', [connectionId, long]));

    await expect(createNativeMailAccount({ userId: USER_ID, provider: 'google', connectionId, discover: false }))
      .rejects.toBeTruthy();

    // No half-written account, and the connection is untouched.
    expect(await accountsFor()).toHaveLength(0);
    const connection = await autocommit(client => client.query<{ status: string }>(
      'SELECT status FROM provider_connections WHERE id = $1', [connectionId],
    ));
    expect(connection.rows[0]?.status).toBe('active');
  });
});
