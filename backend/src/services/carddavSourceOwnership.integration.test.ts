// Real PostgreSQL regression coverage for FV-01/FV-02 schema invariants.
// Run against a fully migrated scratch database:
//   REQUIRE_DAV_POSTGRES=1 npx vitest run src/services/carddavSourceOwnership.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { pool, query } from './db.js';

const enabled = process.env.REQUIRE_DAV_POSTGRES === '1';

describe.skipIf(!enabled)('CardDAV source ownership and lease fencing (PostgreSQL)', () => {
  const userId = randomUUID();
  const sourceA = randomUUID();
  const sourceB = randomUUID();
  const connectionA = randomUUID();
  const connectionB = randomUUID();
  const sharedUrl = 'https://dav.example.test/addressbooks/shared/';

  beforeAll(async () => {
    await query('INSERT INTO users(id, username, password_hash) VALUES($1,$2,$3)', [userId, `carddav-owner-${userId}`, 'unused']);
    await query(
      `INSERT INTO user_integrations(id, user_id, provider, label, config)
       VALUES ($1,$3,'carddav','A','{}'), ($2,$3,'carddav','B','{}')`,
      [sourceA, sourceB, userId],
    );
    await query(
      `INSERT INTO source_connections(id, user_id, kind, url_encrypted, url_fingerprint, integration_id)
       VALUES ($1,$3,'carddav','enc:v1:a','same-url-a',$4), ($2,$3,'carddav','enc:v1:b','same-url-b',$5)`,
      [connectionA, connectionB, userId, sourceA, sourceB],
    );
  });

  afterAll(async () => {
    await query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
    await pool.end();
  });

  it('permits the same remote URL only when the source connection differs', async () => {
    await query(
      `INSERT INTO address_books(user_id, name, source, external_url, source_connection_id, dav_mode)
       VALUES ($1,'A contacts','carddav',$2,$3,'off'), ($1,'B contacts','carddav',$2,$4,'off')`,
      [userId, sharedUrl, connectionA, connectionB],
    );
    const books = await query<{ source_connection_id: string }>(
      `SELECT source_connection_id FROM address_books
        WHERE user_id = $1 AND external_url = $2 ORDER BY source_connection_id`,
      [userId, sharedUrl],
    );
    expect(books.rows.map(row => row.source_connection_id).sort()).toEqual([connectionA, connectionB].sort());
  });

  it('allows only one live cross-process lease claim for a source', async () => {
    const claim = (owner: string) => query<{ generation: number }>(
      `INSERT INTO carddav_source_sync_leases(integration_id, owner, generation, lease_expires_at)
       VALUES ($1,$2,1,NOW() + interval '10 minutes')
       ON CONFLICT (integration_id) DO UPDATE SET owner = EXCLUDED.owner
       WHERE carddav_source_sync_leases.lease_expires_at <= NOW()
       RETURNING generation`,
      [sourceA, owner],
    );
    const [first, second] = await Promise.all([claim('worker-a'), claim('worker-b')]);
    expect([first.rows.length, second.rows.length].sort()).toEqual([0, 1]);
  });
});
