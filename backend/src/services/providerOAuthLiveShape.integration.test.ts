// The two release-blocking provider facts a live acceptance round depends on: the callback a Microsoft
// authorization actually sends, and the scopes a provider connection has accumulated.
//
//   DB_HOST=127.0.0.1 DB_PORT=55432 DB_NAME=<db> DB_USER=mailflow_test DB_PASSWORD=mailflow_test \
//     npx vitest run src/services/providerOAuthLiveShape.integration.test.ts

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { pool } from './db.js';
import { readGrantForUser } from './providerTokenService.js';
import {
  GOOGLE_GRANT_AUDIENCE,
  GOOGLE_ISSUER,
  MICROSOFT_GRANT_AUDIENCE,
  MICROSOFT_ISSUER,
  googleScopesForPurpose,
  microsoftAuthorizeUrl,
  microsoftScopesForPurpose,
  storeOAuthGrant,
  upsertProviderConnection,
} from './providerAuthService.js';

const hasPg = process.env.DB_HOST && process.env.DB_NAME;
const describeOrSkip = hasPg ? describe : describe.skip;

const USER_ID = '00000000-0000-0000-0000-00000000b001';
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

/** Authorize one more feature on the same connection, the way an incremental consent callback does. */
async function authorize(connectionId: string, audience: string, scopes: string[], tokens: { access: string; refresh?: string } = { access: 'a' }): Promise<void> {
  await inTransaction(client => storeOAuthGrant(client, {
    connectionId,
    audience,
    accessToken: tokens.access,
    refreshToken: tokens.refresh ?? null,
    expiresAt: new Date(Date.now() + 3600_000),
    scopes,
    clientIdAtIssue: 'client-1',
  }));
}

async function scopesOf(connectionId: string, audience: string): Promise<string[]> {
  const grant = await autocommit(client => readGrantForUser(client, { userId: USER_ID, connectionId, audience }));
  return (grant?.scopes ?? []).slice().sort();
}

describeOrSkip('live OAuth shape (PostgreSQL)', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY ||= 'c'.repeat(64);
    await autocommit(client => client.query(
      "INSERT INTO users (id, username) VALUES ($1, 'live-shape') ON CONFLICT (id) DO NOTHING", [USER_ID],
    ));
  });

  afterAll(async () => {
    await autocommit(async client => {
      await client.query('DELETE FROM provider_connections WHERE user_id = $1', [USER_ID]);
      await client.query('DELETE FROM users WHERE id = $1', [USER_ID]);
    });
    if (originalKey === undefined) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = originalKey;
  });

  it('sends the Graph callback the card displays', () => {
    const config = {
      clientId: 'client-1', clientSecret: 'secret-1', tenantId: 'common',
      redirectUri: 'https://email.example.com/oauth/microsoft/callback',
      providerRedirectUri: 'https://email.example.com/oauth/provider/microsoft/callback',
    };
    const url = new URL(microsoftAuthorizeUrl({ config, scopes: microsoftScopesForPurpose('mail_migration'), state: 's', codeChallenge: 'c' }));
    // Exactly the effective provider callback — the one the Integrations card reports and an administrator must
    // register. The legacy mailbox callback is a different URI and must never be used here.
    expect(url.searchParams.get('redirect_uri')).toBe('https://email.example.com/oauth/provider/microsoft/callback');
    expect(url.searchParams.get('redirect_uri')).not.toBe(config.redirectUri);
    // The mail migration asks for the scopes a native mailbox needs.
    const scopes = String(url.searchParams.get('scope'));
    expect(scopes).toContain('Mail.ReadWrite');
    expect(scopes).toContain('Mail.Send');
  });

  it('accumulates Google scopes across Gmail, Calendar and Contacts authorizations', async () => {
    const connectionId = await inTransaction(client => upsertProviderConnection(client, {
      userId: USER_ID, provider: 'google', issuer: GOOGLE_ISSUER, subject: 'google-accumulate',
      providerUserId: 'live@gmail.test',
    }));

    // 1) mail
    await authorize(connectionId, GOOGLE_GRANT_AUDIENCE, googleScopesForPurpose('mail_migration'));
    const hasScope = (scopes: string[], suffix: string) => scopes.some(scope => scope.endsWith(suffix));
    expect(hasScope(await scopesOf(connectionId, GOOGLE_GRANT_AUDIENCE), 'gmail.modify')).toBe(true);

    // 2) calendar — the mail scope must survive, or the mailbox stops being authorized for its own mail.
    await authorize(connectionId, GOOGLE_GRANT_AUDIENCE, googleScopesForPurpose('calendar_enable'), { access: 'b', refresh: 'rt-2' });
    const afterCalendar = await scopesOf(connectionId, GOOGLE_GRANT_AUDIENCE);
    expect(hasScope(afterCalendar, 'gmail.modify')).toBe(true);
    expect(hasScope(afterCalendar, '/calendar.events')).toBe(true);
    expect(hasScope(afterCalendar, 'calendar.calendarlist.readonly')).toBe(true);
    // The refresh token from the first authorization is kept when the second one does not return a new one.
    const grant = await autocommit(client => readGrantForUser(client, { userId: USER_ID, connectionId, audience: GOOGLE_GRANT_AUDIENCE }));
    expect(grant?.refreshToken).toBeTruthy();

    // 3) contacts
    await authorize(connectionId, GOOGLE_GRANT_AUDIENCE, googleScopesForPurpose('contacts_enable'), { access: 'c' });
    const afterContacts = await scopesOf(connectionId, GOOGLE_GRANT_AUDIENCE);
    for (const scope of ['gmail.modify', '/calendar.events', 'calendar.calendarlist.readonly', '/contacts']) {
      expect(hasScope(afterContacts, scope), `${scope} was dropped by a later authorization`).toBe(true);
    }
  });

  it('accumulates Graph scopes across mail, calendar and contacts authorizations', async () => {
    const connectionId = await inTransaction(client => upsertProviderConnection(client, {
      userId: USER_ID, provider: 'microsoft', issuer: MICROSOFT_ISSUER, subject: 'graph-accumulate',
      providerUserId: 'live@outlook.test',
    }));

    await authorize(connectionId, MICROSOFT_GRANT_AUDIENCE, microsoftScopesForPurpose('mail_migration'));
    await authorize(connectionId, MICROSOFT_GRANT_AUDIENCE, microsoftScopesForPurpose('calendar_enable'), { access: 'b' });
    await authorize(connectionId, MICROSOFT_GRANT_AUDIENCE, microsoftScopesForPurpose('contacts_enable', 'read_only'), { access: 'c' });

    const scopes = await scopesOf(connectionId, MICROSOFT_GRANT_AUDIENCE);
    expect(scopes.some(scope => scope.endsWith('Mail.ReadWrite'))).toBe(true);
    expect(scopes.some(scope => scope.endsWith('Mail.Send'))).toBe(true);
    expect(scopes.some(scope => scope.endsWith('Calendars.ReadWrite'))).toBe(true);
    expect(scopes.some(scope => scope.endsWith('Contacts.Read'))).toBe(true);
  });

  it('removes only the scopes a caller says the provider revoked', async () => {
    const connectionId = await inTransaction(client => upsertProviderConnection(client, {
      userId: USER_ID, provider: 'google', issuer: GOOGLE_ISSUER, subject: 'google-revoke',
      providerUserId: 'revoke@gmail.test',
    }));
    await authorize(connectionId, GOOGLE_GRANT_AUDIENCE, [...googleScopesForPurpose('mail_migration'), ...googleScopesForPurpose('calendar_enable')]);
    await inTransaction(client => storeOAuthGrant(client, {
      connectionId,
      audience: GOOGLE_GRANT_AUDIENCE,
      accessToken: 'd',
      refreshToken: null,
      expiresAt: new Date(Date.now() + 3600_000),
      // The provider reported that this authorization no longer includes the calendar.
      dropScopes: ['https://www.googleapis.com/auth/calendar.events'],
      scopes: ['https://www.googleapis.com/auth/gmail.modify'],
      clientIdAtIssue: 'client-1',
    }));

    const scopes = await scopesOf(connectionId, GOOGLE_GRANT_AUDIENCE);
    expect(scopes.some(scope => scope.endsWith('gmail.modify'))).toBe(true);
    expect(scopes.some(scope => scope.endsWith('calendar.events'))).toBe(false);
  });
});
