// Real PostgreSQL tests for the Google mail migration recommendation (P09). The notice table, the
// account identification and the suppression upsert are real; the assertion is about which rows the
// service is willing to surface and what a suppression durably changes.
//
// Run with:
//   DB_HOST=127.0.0.1 DB_PORT=55432 DB_NAME=inboxora_google_gate DB_USER=mailflow_test DB_PASSWORD=mailflow_test \
//     npx vitest run src/services/accountNotices.integration.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { pool } from './db.js';
import {
  GOOGLE_MAIL_RECOMMENDATION,
  listActiveGoogleMailRecommendations,
  suppressGoogleMailRecommendation,
} from './accountNotices.js';

const hasPg = process.env.DB_HOST && process.env.DB_NAME;
const describeOrSkip = hasPg ? describe : describe.skip;

const USER_ID = '00000000-0000-0000-0000-0000000007b1';
const OTHER_USER_ID = '00000000-0000-0000-0000-0000000007b2';
const originalEnv = {
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI,
  PROVIDER_INTEGRATIONS_ENABLED: process.env.PROVIDER_INTEGRATIONS_ENABLED,
};

async function autocommit<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { return await fn(client); } finally { client.release(); }
}

async function seedAccount(input: {
  userId?: string;
  address: string;
  imapHost: string | null;
  oauthProvider?: string | null;
  mailTransport?: string | null;
  enabled?: boolean;
}): Promise<string> {
  const result = await autocommit(client => client.query<{ id: string }>(
    `INSERT INTO email_accounts (user_id, name, email_address, imap_host, oauth_provider, mail_transport, enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      input.userId ?? USER_ID, input.address, input.address, input.imapHost,
      input.oauthProvider ?? null, input.mailTransport ?? null, input.enabled ?? true,
    ],
  ));
  return result.rows[0].id;
}

async function preferenceRow(accountId: string, userId = USER_ID): Promise<{ suppressed: boolean; revision: string } | null> {
  const result = await autocommit(client => client.query<{ suppressed: boolean; revision: string }>(
    'SELECT suppressed, revision FROM account_notice_preferences WHERE user_id = $1 AND account_id = $2 AND notice_type = $3',
    [userId, accountId, GOOGLE_MAIL_RECOMMENDATION],
  ));
  return result.rows[0] ?? null;
}

describeOrSkip('Google mail migration recommendation (PostgreSQL)', () => {
  beforeAll(async () => {
    process.env.GOOGLE_CLIENT_ID = 'client-1';
    process.env.GOOGLE_CLIENT_SECRET = 'secret-1';
    process.env.GOOGLE_REDIRECT_URI = 'https://inboxora.example/oauth/google/callback';
    await autocommit(async client => {
      await client.query(
        `INSERT INTO users (id, username) VALUES ($1, 'notices-user'), ($2, 'notices-other') ON CONFLICT (id) DO NOTHING`,
        [USER_ID, OTHER_USER_ID],
      );
    });
  });

  afterAll(async () => {
    await autocommit(client => client.query('DELETE FROM users WHERE id IN ($1, $2)', [USER_ID, OTHER_USER_ID]));
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(async () => {
    await autocommit(async client => {
      await client.query('DELETE FROM email_accounts WHERE user_id IN ($1, $2)', [USER_ID, OTHER_USER_ID]);
      await client.query("DELETE FROM integration_config WHERE provider = 'google'");
    });
  });

  it('recommends only a Google mailbox still on imap_smtp, for the caller’s own accounts', async () => {
    const gmailHost = await seedAccount({ address: 'me@gmail.test', imapHost: 'imap.gmail.com' });
    const googleOauth = await seedAccount({ address: 'me@workspace.test', imapHost: 'imap.workspace.test', oauthProvider: 'google' });
    await seedAccount({ address: 'not-google@fastmail.test', imapHost: 'imap.fastmail.test' });
    await seedAccount({ address: 'already-native@gmail.test', imapHost: 'imap.gmail.com', mailTransport: 'gmail_api' });
    await seedAccount({ address: 'disabled@gmail.test', imapHost: 'imap.gmail.com', enabled: false });
    await seedAccount({ userId: OTHER_USER_ID, address: 'other@gmail.test', imapHost: 'imap.gmail.com' });

    const notices = await listActiveGoogleMailRecommendations(USER_ID);
    expect(notices).toEqual([
      { accountId: gmailHost, address: 'me@gmail.test', noticeType: GOOGLE_MAIL_RECOMMENDATION },
      { accountId: googleOauth, address: 'me@workspace.test', noticeType: GOOGLE_MAIL_RECOMMENDATION },
    ]);
  });

  it('shows nothing while the installation cannot offer the destination', async () => {
    await seedAccount({ address: 'me@gmail.test', imapHost: 'imap.gmail.com' });

    process.env.PROVIDER_INTEGRATIONS_ENABLED = '0';
    await expect(listActiveGoogleMailRecommendations(USER_ID)).resolves.toEqual([]);
    delete process.env.PROVIDER_INTEGRATIONS_ENABLED;

    await autocommit(client => client.query(
      `INSERT INTO integration_config (provider, config) VALUES ('google', '{"apiEnabled": false}'::jsonb)`,
    ));
    await expect(listActiveGoogleMailRecommendations(USER_ID)).resolves.toEqual([]);
    await autocommit(client => client.query("DELETE FROM integration_config WHERE provider = 'google'"));

    const configured = process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_ID;
    await expect(listActiveGoogleMailRecommendations(USER_ID)).resolves.toEqual([]);
    process.env.GOOGLE_CLIENT_ID = configured;
  });

  it('suppresses durably, bumps the revision, and keeps the recommendation gone', async () => {
    const accountId = await seedAccount({ address: 'me@gmail.test', imapHost: 'imap.gmail.com' });
    await expect(listActiveGoogleMailRecommendations(USER_ID)).resolves.toHaveLength(1);

    await expect(suppressGoogleMailRecommendation(USER_ID, accountId)).resolves.toEqual({ ok: true });
    await expect(listActiveGoogleMailRecommendations(USER_ID)).resolves.toEqual([]);
    await expect(preferenceRow(accountId)).resolves.toEqual({ suppressed: true, revision: '1' });

    // A second "do not show again" is idempotent in effect but still records a new revision.
    await expect(suppressGoogleMailRecommendation(USER_ID, accountId)).resolves.toEqual({ ok: true });
    await expect(preferenceRow(accountId)).resolves.toEqual({ suppressed: true, revision: '2' });
  });

  it('refuses to touch an account that is not the caller’s', async () => {
    const foreign = await seedAccount({ userId: OTHER_USER_ID, address: 'other@gmail.test', imapHost: 'imap.gmail.com' });

    await expect(suppressGoogleMailRecommendation(USER_ID, foreign)).resolves.toEqual({ ok: false, status: 404, error: 'Account not found' });
    await expect(preferenceRow(foreign, OTHER_USER_ID)).resolves.toBeNull();
    await expect(preferenceRow(foreign, USER_ID)).resolves.toBeNull();
  });

  it('cannot represent the Microsoft requirement notice, so that notice can never be suppressed', async () => {
    const accountId = await seedAccount({ address: 'me@gmail.test', imapHost: 'imap.gmail.com' });

    // The schema's closed set is the guarantee: there is no notice type a requirement could be stored
    // under, so no code path can quiet it. Widening this CHECK would make a requirement dismissible.
    await expect(autocommit(client => client.query(
      `INSERT INTO account_notice_preferences (user_id, account_id, notice_type, suppressed) VALUES ($1,$2,'microsoft_requirement',true)`,
      [USER_ID, accountId],
    ))).rejects.toThrow(/notice_type/);
  });
});
