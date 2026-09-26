// Real PostgreSQL route coverage, including the production ownership FKs.
// Requires a migrated scratch database and REQUIRE_DAV_POSTGRES=1.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import express from 'express';
import 'express-async-errors';
import { pool, query } from '../services/db.js';
import { listeningPort } from '../test/net.js';
import carddavAccountRouter from './carddavAccount.js';

const enabled = process.env.REQUIRE_DAV_POSTGRES === '1';

describe.skipIf(!enabled)('legacy CardDAV cleanup (PostgreSQL)', () => {
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const legacyId = randomUUID();
  const currentId = randomUUID();
  const otherLegacyId = randomUUID();
  const integrationId = randomUUID();
  const triggerName = `legacy_cleanup_${userId.replaceAll('-', '')}`;
  let server: Server | undefined;
  let base = '';

  async function cleanupTrigger() {
    await query(`DROP TRIGGER IF EXISTS ${triggerName} ON source_connections`);
    await query(`DROP FUNCTION IF EXISTS ${triggerName}()`);
  }

  beforeAll(async () => {
    const app = express();
    app.use((req, _res, next) => {
      req.session = { userId } as express.Request['session'];
      next();
    });
    app.use('/api/carddav', carddavAccountRouter);
    app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: error.message });
    });
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, () => resolve());
      server.once('error', reject);
    });
    if (!server) throw new Error('Test server failed to start');
    base = `http://127.0.0.1:${listeningPort(server)}`;
  });

  beforeEach(async () => {
    await query('INSERT INTO users (id, username) VALUES ($1, $3), ($2, $4)', [userId, otherUserId, userId, otherUserId]);
    await query(`INSERT INTO user_integrations (id, user_id, provider, config)
      VALUES ($1, $2, 'carddav', '{}')`, [integrationId, userId]);
    await query(`INSERT INTO source_connections (id, user_id, kind, integration_id)
      VALUES ($1, $4, 'carddav', NULL), ($2, $4, 'carddav', $5), ($3, $4, 'carddav', NULL)`,
    [legacyId, currentId, otherLegacyId, userId, integrationId]);
  });

  afterEach(async () => {
    await cleanupTrigger();
    await query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[userId, otherUserId]]);
  });

  afterAll(async () => {
    if (server) await new Promise<void>(resolve => server?.close(() => resolve()));
    await pool.end();
  });

  async function book(owner: string | null, ownerUser = userId, source = 'carddav') {
    const id = randomUUID();
    await query(`INSERT INTO address_books (id, user_id, name, source, source_connection_id)
      VALUES ($1, $2, $5, $3, $4)`, [id, ownerUser, source, owner, `Cleanup fixture ${id}`]);
    return id;
  }

  async function link(bookId: string, connectionId: string) {
    const id = randomUUID();
    await query(`INSERT INTO integration_collections (id, user_id, kind, source_connection_id, local_address_book_id, remote_id)
      VALUES ($1, $2, 'address_book', $3, $4, $5)`, [id, userId, connectionId, bookId, id]);
    return id;
  }

  function forget() {
    return fetch(`${base}/api/carddav/legacy/${encodeURIComponent(`carddav:connection:${legacyId}`)}`, { method: 'DELETE' });
  }

  async function remainingBooks() {
    const result = await query<{ id: string }>('SELECT id FROM address_books WHERE user_id = ANY($1::uuid[])', [[userId, otherUserId]]);
    return result.rows.map(row => row.id).sort();
  }

  it('preserves books with an active direct owner or collection owner, including through cascading source deletion', async () => {
    const directlyOwned = await book(currentId);
    await link(directlyOwned, legacyId);
    const collectionOwned = await book(legacyId);
    const activeLink = await link(collectionOwned, currentId);
    const ownerless = await book(null);
    await link(ownerless, legacyId);
    await link(ownerless, currentId);

    const response = await forget();

    expect(response.status).toBe(204);
    expect(await remainingBooks()).toEqual([directlyOwned, collectionOwned, ownerless].sort());
    expect((await query('SELECT id FROM integration_collections WHERE id = $1 AND local_address_book_id = $2', [activeLink, collectionOwned])).rows).toHaveLength(1);
    // This retained direct reference must prevent ON DELETE CASCADE from undoing the ownership guard.
    expect((await query('SELECT id FROM source_connections WHERE id = $1', [legacyId])).rows).toHaveLength(1);
  });

  it('deletes true orphans by either matching path and isolates other users, sources, and book types', async () => {
    await book(legacyId);
    const linkedOrphan = await book(null);
    await link(linkedOrphan, legacyId);
    const otherSource = await book(otherLegacyId);
    const otherUser = await book(null, otherUserId);
    const localBook = await book(null, userId, 'local');
    await link(localBook, legacyId);

    const response = await forget();

    expect(response.status).toBe(204);
    expect(await remainingBooks()).toEqual([otherSource, otherUser, localBook].sort());
    expect((await query('SELECT id FROM source_connections WHERE id = $1', [legacyId])).rows).toHaveLength(0);
    expect((await query('SELECT id FROM source_connections WHERE id = ANY($1::uuid[])', [[currentId, otherLegacyId]])).rows).toHaveLength(2);
  });

  it('rolls back address-book and collection changes when the source-connection delete fails', async () => {
    const directOrphan = await book(legacyId);
    const linkedOrphan = await book(null);
    const legacyLink = await link(linkedOrphan, legacyId);
    await query(`CREATE FUNCTION ${triggerName}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected legacy source delete failure'; END $$`);
    await query(`CREATE TRIGGER ${triggerName} BEFORE DELETE ON source_connections
      FOR EACH ROW WHEN (OLD.id = '${legacyId}'::uuid) EXECUTE FUNCTION ${triggerName}()`);

    const response = await forget();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'injected legacy source delete failure' });
    expect(await remainingBooks()).toEqual([directOrphan, linkedOrphan].sort());
    expect((await query('SELECT id FROM source_connections WHERE id = $1', [legacyId])).rows).toHaveLength(1);
    expect((await query('SELECT local_address_book_id FROM integration_collections WHERE id = $1', [legacyLink])).rows)
      .toEqual([{ local_address_book_id: linkedOrphan }]);
  });
});
