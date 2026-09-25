// Real PostgreSQL test for disconnecting a provider account. The route test asserts the SQL it
// issues; this one asserts the consequences, which is what the scheduler and the grant service
// actually depend on.
//
//   DB_HOST=localhost DB_PORT=5432 DB_NAME=mailflow_test DB_USER=… DB_PASSWORD=… \
//     npx vitest run src/services/providerConnectionService.integration.test.ts

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
import { disconnectProviderConnection } from './providerConnectionService.js';
import { listProviderSyncTargets } from './providerSyncScheduler.js';

const hasPg = process.env.DB_HOST && process.env.DB_NAME;
const describeOrSkip = hasPg ? describe : describe.skip;

const USER_ID = '00000000-0000-0000-0000-000000000e01';
const OTHER_USER_ID = '00000000-0000-0000-0000-000000000e02';
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

/** A connection with a grant and one linked, enabled collection. */
async function seedConnection(userId: string, subject: string): Promise<string> {
  return inTransaction(async client => {
    const connectionId = await upsertProviderConnection(client, {
      userId, provider: 'google', issuer: GOOGLE_ISSUER, subject,
    });
    await storeOAuthGrant(client, {
      connectionId,
      audience: GOOGLE_GRANT_AUDIENCE,
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      expiresAt: new Date(Date.now() + 3600_000),
      scopes: ['openid'],
      clientIdAtIssue: 'client-1',
    });
    const calendar = await client.query<{ id: string }>(
      `INSERT INTO calendars (user_id, owner_user_id, name, source, read_only, dav_mode)
       VALUES ($1, $1, $2, 'google', true, 'off') RETURNING id`,
      [userId, `Imported ${subject}`],
    );
    await client.query(
      `INSERT INTO integration_collections (user_id, connection_id, kind, remote_id, local_calendar_id, enabled, source_access, user_access, dav_mode)
       VALUES ($1, $2, 'calendar', 'primary', $3, true, 'read_only', 'source', 'off')`,
      [userId, connectionId, calendar.rows[0]?.id],
    );
    return connectionId;
  });
}

describeOrSkip('disconnectProviderConnection (PostgreSQL)', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    await autocommit(async client => {
      for (const [id, username] of [[USER_ID, 'p76-user'], [OTHER_USER_ID, 'p76-other']] as const) {
        await client.query('INSERT INTO users (id, username) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [id, username]);
      }
    });
  });

  afterAll(async () => {
    await autocommit(client => client.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[USER_ID, OTHER_USER_ID]]));
    if (originalKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = originalKey;
  });

  beforeEach(async () => {
    await autocommit(async client => {
      await client.query('DELETE FROM provider_connections WHERE user_id = ANY($1::uuid[])', [[USER_ID, OTHER_USER_ID]]);
      await client.query('DELETE FROM calendars WHERE user_id = ANY($1::uuid[])', [[USER_ID, OTHER_USER_ID]]);
    });
  });

  it('revokes the grant, clears its tokens, and takes the connection out of the schedule', async () => {
    const connectionId = await seedConnection(USER_ID, 'sub-disconnect');
    const kept = await seedConnection(USER_ID, 'sub-kept');
    expect((await listProviderSyncTargets()).filter(target => target.connectionId === connectionId)).toHaveLength(1);

    const result = await disconnectProviderConnection(USER_ID, connectionId);
    expect(result).toEqual({ connectionId, collectionsDisabled: 1 });

    const grant = await autocommit(client => client.query<{
      status: string; access_token_encrypted: string | null; refresh_token_encrypted: string | null;
    }>('SELECT status, access_token_encrypted, refresh_token_encrypted FROM oauth_grants WHERE connection_id = $1', [connectionId]));
    expect(grant.rows[0]?.status).toBe('revoked');
    // The tokens are gone, not merely marked revoked: nothing encrypted is left at rest.
    expect(grant.rows[0]?.access_token_encrypted).toBeNull();
    expect(grant.rows[0]?.refresh_token_encrypted).toBeNull();

    // The scheduler reads `enabled` collections of active connections, so this is the effect
    // that matters, and it is asserted through the real query rather than a SQL fragment.
    const targets = await listProviderSyncTargets();
    expect(targets.filter(target => target.connectionId === connectionId)).toHaveLength(0);
    expect(targets.filter(target => target.connectionId === kept)).toHaveLength(1);

    // Nothing imported is deleted: the calendar and its collection row remain.
    const keptData = await autocommit(client => client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM calendar_events e
         JOIN calendars c ON c.id = e.calendar_id WHERE c.user_id = $1`, [USER_ID],
    ));
    expect(keptData.rows[0]?.count).toBe('0'); // no events were seeded, but the calendar remains
    const calendars = await autocommit(client => client.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM calendars WHERE user_id = $1', [USER_ID],
    ));
    expect(calendars.rows[0]?.count).toBe('2');
  });

  it('comes back into service when the account is authorized again', async () => {
    // The pair matters: a disconnect takes the connection out of service and disables its
    // collections, so re-authorization must undo both or the new grant belongs to a connection
    // that the status routes and the schedule both ignore — indistinguishable from a connector
    // that never worked.
    const connectionId = await seedConnection(USER_ID, 'sub-reconnect');
    await disconnectProviderConnection(USER_ID, connectionId);
    expect((await listProviderSyncTargets()).filter(target => target.connectionId === connectionId)).toHaveLength(0);

    // Re-authorizing the same identity is what the callback does.
    await inTransaction(client => upsertProviderConnection(client, {
      userId: USER_ID, provider: 'google', issuer: GOOGLE_ISSUER, subject: 'sub-reconnect',
    }));

    const connection = await autocommit(client => client.query<{ status: string }>(
      'SELECT status FROM provider_connections WHERE id = $1', [connectionId],
    ));
    expect(connection.rows[0]?.status).toBe('active');
    const collections = await autocommit(client => client.query<{ enabled: boolean }>(
      'SELECT enabled FROM integration_collections WHERE connection_id = $1', [connectionId],
    ));
    expect(collections.rows[0]?.enabled).toBe(true);
    expect((await listProviderSyncTargets()).filter(target => target.connectionId === connectionId)).toHaveLength(1);
  });

  it('refuses a connection that belongs to another user, changing nothing', async () => {
    const mine = await seedConnection(USER_ID, 'sub-mine');
    const theirs = await seedConnection(OTHER_USER_ID, 'sub-theirs');

    expect(await disconnectProviderConnection(USER_ID, theirs)).toBeNull();

    const untouched = await autocommit(client => client.query<{ status: string }>(
      'SELECT status FROM oauth_grants WHERE connection_id = $1', [theirs],
    ));
    expect(untouched.rows[0]?.status).toBe('active');
    // The caller's own connection is not collateral damage either.
    const own = await autocommit(client => client.query<{ status: string }>(
      'SELECT status FROM oauth_grants WHERE connection_id = $1', [mine],
    ));
    expect(own.rows[0]?.status).toBe('active');
  });
});
