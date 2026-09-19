// Does the v4 provider schema survive an upgrade over existing data?
//
// P02's acceptance criterion is "upgrade + fresh DB, preserved IDs". The fresh half is exercised
// constantly — the gated suite runs against an empty migrated database — while the upgrade half was not
// tested anywhere. This applies the chain up to the provider migrations, seeds rows of the shape a pre-v4
// installation holds, applies 0101–0106, and asserts that the rows and their identities survive.
//
// It creates and drops its own database, so it does not depend on whatever state the shared one is in.
// Migrations are applied by file rather than through the runner, because `runMigrations()` takes no
// arguments and staging an upgrade would mean changing the most sensitive code in the repository; the
// `-- no-transaction` marker is honoured the way the runner honours it, statement by statement, since
// `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block.
//
// It creates and drops a database of its own, so the role it connects as needs `CREATEDB` — the
// `postgres` service user in the gate recipe has it — and it leaves nothing behind, dropping the
// database in `afterAll` even when the assertions fail.
//
//   DB_HOST=localhost DB_PORT=5432 DB_NAME=mailflow_test DB_USER=… DB_PASSWORD=… \
//     npx vitest run src/services/providerSchemaUpgrade.integration.test.ts

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { pool } from './db.js';

const hasPg = process.env.DB_HOST && process.env.DB_NAME;
const describeOrSkip = hasPg ? describe : describe.skip;

const MIGRATIONS_DIR = join(process.cwd(), 'migrations');
const USER_ID = '00000000-0000-0000-0000-00000000e1a1';
const CALENDAR_ID = '11111111-1111-1111-1111-111111111111';
const BOOK_ID = '22222222-2222-2222-2222-222222222222';
const CONTACT_ID = '33333333-3333-3333-3333-333333333333';
const PROVIDER_MIGRATIONS = /^010[1-6]_/;
const UPGRADE_DB = `inboxora_upgrade_${process.pid}_${Date.now()}`.toLowerCase();

const migrationFiles = () => readdirSync(MIGRATIONS_DIR).filter(name => name.endsWith('.sql')).sort();

/** Mirrors how the runner executes a file: one query, unless the file opts out of a transaction. */
async function applyFile(client: { query: (sql: string) => Promise<unknown> }, name: string) {
  const sql = readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
  if (/^--\s*no-transaction\b/im.test(sql)) {
    for (const statement of sql.replace(/^--[^\n]*$/gm, '').split(';').map(s => s.trim()).filter(Boolean)) {
      await client.query(statement);
    }
    return;
  }
  await client.query(sql);
}

describeOrSkip('the v4 provider schema upgrades over existing data', () => {
  let upgradePool: Pool | null = null;

  beforeAll(async () => {
    await pool.query(`CREATE DATABASE "${UPGRADE_DB}"`);
    upgradePool = new Pool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT ?? 5432),
      database: UPGRADE_DB,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      max: 2,
    });
    for (const file of migrationFiles()) {
      if (!PROVIDER_MIGRATIONS.test(file)) await applyFile(upgradePool, file);
    }

    await upgradePool.query('INSERT INTO users (id, username) VALUES ($1, $2)', [USER_ID, 'p02-upgrade']);
    await upgradePool.query(
      `INSERT INTO calendars (id, user_id, owner_user_id, name, source) VALUES ($1, $2, $2, 'Existing calendar', 'local')`,
      [CALENDAR_ID, USER_ID],
    );
    await upgradePool.query(
      `INSERT INTO address_books (id, user_id, name, source) VALUES ($1, $2, 'Existing book', 'local')`,
      [BOOK_ID, USER_ID],
    );
    // `uid` is NOT NULL with no default in 0017; the rest of the row comes from defaults.
    await upgradePool.query(
      `INSERT INTO contacts (id, user_id, address_book_id, uid, display_name)
       VALUES ($1, $2, $3, 'seed-contact-1', 'Ada Lovelace')`,
      [CONTACT_ID, USER_ID, BOOK_ID],
    );

    for (const file of migrationFiles()) {
      if (PROVIDER_MIGRATIONS.test(file)) await applyFile(upgradePool, file);
    }
  }, 120_000);

  afterAll(async () => {
    if (upgradePool) {
      await upgradePool.end().catch(() => {});
      upgradePool = null;
    }
    await pool.query(`DROP DATABASE IF EXISTS "${UPGRADE_DB}" WITH (FORCE)`).catch(() => {});
  });

  it('keeps the rows that existed before the provider migrations, with their IDs', async () => {
    if (!upgradePool) throw new Error('no upgrade database');
    const calendar = await upgradePool.query<{ id: string; name: string }>('SELECT id, name FROM calendars WHERE user_id = $1', [USER_ID]);
    expect(calendar.rows).toHaveLength(1);
    expect(calendar.rows[0]).toMatchObject({ id: CALENDAR_ID, name: 'Existing calendar' });

    const book = await upgradePool.query<{ id: string; name: string }>('SELECT id, name FROM address_books WHERE user_id = $1', [USER_ID]);
    expect(book.rows).toHaveLength(1);
    expect(book.rows[0]).toMatchObject({ id: BOOK_ID, name: 'Existing book' });

    const contact = await upgradePool.query<{ id: string; uid: string; display_name: string; address_book_id: string }>(
      'SELECT id, uid, display_name, address_book_id FROM contacts WHERE user_id = $1', [USER_ID],
    );
    expect(contact.rows).toHaveLength(1);
    expect(contact.rows[0]).toMatchObject({
      id: CONTACT_ID, uid: 'seed-contact-1', display_name: 'Ada Lovelace', address_book_id: BOOK_ID,
    });
  });

  it('brings the provider tables up, still describing nothing because nothing was backfilled', async () => {
    if (!upgradePool) throw new Error('no upgrade database');
    const collections = await upgradePool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM integration_collections');
    expect(collections.rows[0]?.count).toBe('0');
    const tables = await upgradePool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('provider_connections','source_connections','remote_object_links','integration_collections')
        ORDER BY table_name`,
    );
    expect(tables.rows.map(row => row.table_name)).toEqual([
      'integration_collections', 'provider_connections', 'remote_object_links', 'source_connections',
    ]);
  });
});
