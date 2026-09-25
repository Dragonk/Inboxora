import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { pool, query } from './db.js';
import {
  MICROSOFT_GRANT_AUDIENCE,
  MICROSOFT_ISSUER,
  connectionIdentityMatches,
  loadAccountConnectionIdentity,
  microsoftScopesForPurpose,
  storeOAuthGrant,
  upsertProviderConnection,
} from './providerAuthService.js';
import { describeAccountProviderFeatures } from './accountProviderFeatures.js';

/**
 * One Microsoft identity, three consents, one connection.
 *
 * The live report was a mailbox whose mail was authorized while a later calendar consent still read "missing
 * Calendars.ReadWrite", with the same for contacts. A consent must attach its scopes to the connection that
 * already exists for that identity — the subject and issuer are what identify it, and the address is only ever
 * a convenience — and the stored scopes must accumulate rather than replace.
 *
 *   DB_HOST=127.0.0.1 DB_PORT=55432 DB_NAME=<db> DB_USER=mailflow_test DB_PASSWORD=mailflow_test \
 *     npx vitest run src/services/microsoftConsentSequence.integration.test.ts
 */

const hasPg = process.env.DB_HOST && process.env.DB_NAME;
const describeOrSkip = hasPg ? describe : describe.skip;

const userId = randomUUID();
const accountId = randomUUID();
let connectionId = '';

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

/** One consent: the same identity confirms one more feature of the same mailbox. */
async function consent(input: {
  purpose: 'mail_migration' | 'calendar_enable' | 'contacts_enable';
  access?: 'source' | 'read_only';
  /** A consent can arrive while signed in with a different alias; the subject is what must not change. */
  providerUserId?: string;
}): Promise<string> {
  return inTransaction(async client => {
    const id = await upsertProviderConnection(client, {
      userId,
      provider: 'microsoft',
      issuer: MICROSOFT_ISSUER,
      subject: 'graph-subject-stable',
      tenantId: 'common',
      providerUserId: input.providerUserId ?? 'dragonk93@outlook.com',
      clientConfigId: 'client-1',
    });
    await storeOAuthGrant(client, {
      connectionId: id,
      audience: MICROSOFT_GRANT_AUDIENCE,
      accessToken: `access-${input.purpose}`,
      // Only the first consent returns a refresh token; the later ones must not clear it.
      refreshToken: input.purpose === 'mail_migration' ? 'refresh-1' : null,
      expiresAt: new Date(Date.now() + 3600_000),
      scopes: microsoftScopesForPurpose(input.purpose, input.access),
      clientIdAtIssue: 'client-1',
    });
    return id;
  });
}

beforeAll(async () => {
  if (!hasPg) return;
  process.env.ENCRYPTION_KEY ||= 'f'.repeat(64);
  await query("INSERT INTO users (id, username) VALUES ($1, 'ms-consent') ON CONFLICT (id) DO NOTHING", [userId]);
  // The mailbox starts as a legacy Outlook account whose cutover recorded the connection it used.
  const connection = await inTransaction(client => upsertProviderConnection(client, {
    userId, provider: 'microsoft', issuer: MICROSOFT_ISSUER, subject: 'graph-subject-stable',
    tenantId: 'common', providerUserId: 'dragonk93@outlook.com', clientConfigId: 'client-1',
  }));
  connectionId = connection;
  await query(
    `INSERT INTO email_accounts (id, user_id, name, email_address, protocol, imap_host, mail_transport, provider_connection_id)
     VALUES ($1, $2, 'Outlook', 'dragonk93@outlook.com', 'imap', 'outlook.office365.com', 'microsoft_graph', $3)`,
    [accountId, userId, connectionId],
  );
});

afterAll(async () => {
  if (!hasPg) return;
  await query('DELETE FROM email_accounts WHERE user_id = $1', [userId]);
  await query('DELETE FROM provider_connections WHERE user_id = $1', [userId]);
  await query('DELETE FROM users WHERE id = $1', [userId]);
});

describeOrSkip('a Microsoft identity keeps one connection across its consents', () => {
  it('accumulates mail, calendar and contacts scopes on the same connection', async () => {
    const afterMail = await consent({ purpose: 'mail_migration' });
    const afterCalendar = await consent({ purpose: 'calendar_enable' });
    const afterContacts = await consent({ purpose: 'contacts_enable' });

    // One identity, one connection, whatever purpose each consent carried.
    expect(afterCalendar).toBe(afterMail);
    expect(afterContacts).toBe(afterMail);
    const connections = await query<{ id: string }>(
      "SELECT id FROM provider_connections WHERE user_id = $1 AND provider = 'microsoft' AND status = 'active'",
      [userId],
    );
    expect(connections.rows).toHaveLength(1);

    // One Graph grant, holding every scope the three consents granted.
    const grants = await query<{ connection_id: string; scopes: string[]; refresh_token_encrypted: string | null }>(
      'SELECT connection_id, scopes, refresh_token_encrypted FROM oauth_grants WHERE connection_id = $1 AND audience = $2',
      [connectionId, MICROSOFT_GRANT_AUDIENCE],
    );
    expect(grants.rows).toHaveLength(1);
    const scopes = grants.rows[0]!.scopes;
    for (const required of ['Mail.ReadWrite', 'Mail.Send', 'Calendars.ReadWrite', 'Contacts.ReadWrite']) {
      expect(scopes.some(scope => scope.endsWith(required)), `${required} is missing from the stored scopes`).toBe(true);
    }
    // A later consent that returned no refresh token must not have cleared the first one.
    expect(grants.rows[0]!.refresh_token_encrypted).not.toBeNull();

    // And the account still points at that same connection.
    const account = await query<{ provider_connection_id: string | null }>(
      'SELECT provider_connection_id FROM email_accounts WHERE id = $1', [accountId],
    );
    expect(account.rows[0]!.provider_connection_id).toBe(connectionId);
  });

  it('reports every feature as authorized for the account', async () => {
    const features = await describeAccountProviderFeatures({ userId, accountId });
    expect(features!.provider).toBe('microsoft');
    expect(features!.mail.authorized).toBe(true);
    expect(features!.calendar?.authorized, 'calendar should be authorized by the accumulated grant').toBe(true);
    expect(features!.calendar?.missingScopes).toEqual([]);
    expect(features!.contacts?.authorized, 'contacts should be authorized by the accumulated grant').toBe(true);
    expect(features!.contacts?.missingScopes).toEqual([]);
    expect(features!.diagnostics.connection?.identity).toBe('dragonk93@outlook.com');
  });

  it('does not fork the identity when a consent arrives under another alias of the same account', async () => {
    // The same subject signing in with a different address must resolve to the same connection: the address is
    // a convenience, the subject is the identity.
    const sameConnection = await consent({ purpose: 'calendar_enable', providerUserId: 'kamil.maciag@outlook.com' });
    expect(sameConnection).toBe(connectionId);
    const connections = await query<{ id: string }>(
      "SELECT id FROM provider_connections WHERE user_id = $1 AND provider = 'microsoft'",
      [userId],
    );
    expect(connections.rows).toHaveLength(1);
  });
});

describeOrSkip('a mailbox connection identity can be read back and compared', () => {
  it('reports the mailbox identity and refuses a different subject, tenant or provider', async () => {
    // AUTH-02: the OAuth callback validates the identity the provider returned against the identity the mailbox
    // is already bound to before it rebinds `provider_connection_id`. That comparison reads the mailbox's current
    // connection through this helper, so it is exercised here against real rows.
    const current = await inTransaction(client => loadAccountConnectionIdentity(client, { userId, accountId }));
    expect(current).toEqual({
      provider: 'microsoft',
      issuer: MICROSOFT_ISSUER,
      subject: 'graph-subject-stable',
      tenantId: 'common',
    });

    // The same identity — including a re-authorization that only changed the address — still matches.
    expect(connectionIdentityMatches(current!, {
      provider: 'microsoft', issuer: MICROSOFT_ISSUER, subject: 'graph-subject-stable', tenantId: 'common',
    })).toBe(true);

    // A different account, a different tenant or a different provider must not be accepted as the same mailbox.
    expect(connectionIdentityMatches(current!, {
      provider: 'microsoft', issuer: MICROSOFT_ISSUER, subject: 'another-subject', tenantId: 'common',
    })).toBe(false);
    expect(connectionIdentityMatches(current!, {
      provider: 'microsoft', issuer: MICROSOFT_ISSUER, subject: 'graph-subject-stable', tenantId: 'organizations',
    })).toBe(false);
    expect(connectionIdentityMatches(current!, {
      provider: 'google', issuer: MICROSOFT_ISSUER, subject: 'graph-subject-stable', tenantId: 'common',
    })).toBe(false);
  });

  it('returns null for a mailbox that has no connection yet', async () => {
    const unbound = randomUUID();
    await query(
      `INSERT INTO email_accounts (id, user_id, name, email_address, protocol)
       VALUES ($1, $2, 'Unbound', 'unbound@outlook.com', 'imap')`,
      [unbound, userId],
    );
    const identity = await inTransaction(client => loadAccountConnectionIdentity(client, { userId, accountId: unbound }));
    expect(identity).toBeNull();
    await query('DELETE FROM email_accounts WHERE id = $1', [unbound]);
  });
});
