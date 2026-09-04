import { createHash } from 'crypto';
import { readFile, readdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pool } from './db.js';
import { backfillRichContactFields } from './contactRichBackfill.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');
const ACCEPTED_REPLACED_MIGRATION_CHECKSUMS = new Map([
  ['0072_calendar_source_url_secrets', new Set(['5ca9454166b08d0af82935dd4032510e07b1836c61fec61223c305b6608f17a4'])],
]);

async function migrationHashes() {
  const files = (await readdir(MIGRATIONS_DIR)).filter(f => /^\d{4}_.+\.sql$/.test(f)).sort();
  return Promise.all(files.map(async filename => {
    const sql = await readFile(join(MIGRATIONS_DIR, filename), 'utf8');
    return { version: filename.replace(/\.sql$/, ''), sha256: createHash('sha256').update(sql).digest('hex'), sql };
  }));
}

export async function runMigrations() {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(7418291834)');
    await client.query('SET statement_timeout = 0');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(255) PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);
    await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS sha256 TEXT');

    const migrations = await migrationHashes();
    const appliedRows = await client.query('SELECT version, sha256 FROM schema_migrations');
    const applied = new Map(appliedRows.rows.map(row => [row.version, row]));
    for (const migration of migrations) {
      const previous = applied.get(migration.version);
      const acceptedReplacedChecksum = ACCEPTED_REPLACED_MIGRATION_CHECKSUMS.get(migration.version)?.has(previous?.sha256);
      if (previous?.sha256 && previous.sha256 !== migration.sha256 && !acceptedReplacedChecksum) throw new Error(`Migration checksum mismatch: ${migration.version}`);
      if (previous) {
        if (!previous.sha256) await client.query('UPDATE schema_migrations SET sha256 = $1 WHERE version = $2', [migration.sha256, migration.version]);
        continue;
      }
      const noTransaction = /^--\s*no-transaction\b/im.test(migration.sql);
      if (noTransaction) {
        for (const statement of migration.sql.replace(/^--[^\n]*$/gm, '').split(';').map(s => s.trim()).filter(Boolean)) await client.query(statement);
        await client.query('INSERT INTO schema_migrations (version, sha256) VALUES ($1, $2)', [migration.version, migration.sha256]);
      } else {
        await client.query('BEGIN');
        try {
          await client.query(migration.sql);
          await client.query('INSERT INTO schema_migrations (version, sha256) VALUES ($1, $2)', [migration.version, migration.sha256]);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        }
      }
    }
    const richContactBackfillCount = await backfillRichContactFields(client);
    if (richContactBackfillCount > 0) console.log(`Backfilled rich fields for ${richContactBackfillCount} contact(s)`);
  } finally {
    await client.query('SELECT pg_advisory_unlock(7418291834)').catch(() => {});
    client.release();
  }
}
