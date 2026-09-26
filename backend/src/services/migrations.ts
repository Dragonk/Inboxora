import { createHash } from 'crypto';
import { readFile, readdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pool } from './db.js';
import { backfillRichContactFields } from './contactRichBackfill.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');
const ACCEPTED_REPLACED_MIGRATION_CHECKSUMS = new Map([
  // An unreleased dev build applied this exact 0141 variant; 0143 repairs index state.
  ['0141_message_list_hot_path_indexes', new Set(['ea9970699ba04a4dd16616e0a63470a944d5c2e008c8c34905ffa3642b90922b'])],
  ['0072_calendar_source_url_secrets', new Set(['5ca9454166b08d0af82935dd4032510e07b1836c61fec61223c305b6608f17a4'])],
  // 0098 shipped in the unreleased 4.0.3 dev cycle with a content fallback
  // that hashed raw values and preferred the physical copy triple over
  // content — wrong for MOVE stability. It was corrected before release; a
  // database that already ran the first revision must not hard-fail startup
  // on the checksum. Migration 0099 re-derives those rows with the shipped
  // rule, so accepting the old checksum leaves such a database correct.
  ['0098_spam_training_identity', new Set(['82716d8414acd5f2a26fad940165827df0e48cc676a38ac20fd1a96ccb5b0ded'])],
  // 0108 shipped in the unreleased 4.1.0 dev cycle without clearing the legacy
  // Conversation Engine provider ids first, so it could not create its unique index on a
  // real 4.0.4 Gmail mailbox (the same X-GM-MSGID exists once per folder/label copy) and
  // the installation stopped at that migration. The corrected revision clears those
  // values for legacy transports before creating the index; a database that already ran
  // the first revision has the index and therefore the constraint, so accepting the old
  // checksum leaves it correct and lets it boot.
  ['0108_message_provider_identity', new Set(['77f2c82c41e14ebb8a79e6f6a3d726e33b9217c6921cf5743c2088afbbae1ba2'])],
]);

async function migrationHashes() {
  const files = (await readdir(MIGRATIONS_DIR)).filter(f => /^\d{4}_.+\.sql$/.test(f)).sort();
  return Promise.all(files.map(async filename => {
    const sql = await readFile(join(MIGRATIONS_DIR, filename), 'utf8');
    return { version: filename.replace(/\.sql$/, ''), sha256: createHash('sha256').update(sql).digest('hex'), sql };
  }));
}

/**
 * Apply the pending migrations, in order.
 *
 * `upTo` stops after the named version (inclusive). The upgrade gate uses it to reproduce the exact state an
 * older release left behind — the historical schema plus real data — and then runs the production runner
 * again for the remaining migrations, so both halves of an upgrade are exercised by the same code that runs
 * in production rather than by a test-local copy of it.
 */
export async function runMigrations(options: { upTo?: string } = {}) {
  const upToVersion = options.upTo ? Number(options.upTo.slice(0, 4)) : null;
  if (options.upTo && !Number.isFinite(upToVersion)) throw new Error(`runMigrations: '${options.upTo}' is not a migration version`);
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(7418291834)');
    await client.query('SET statement_timeout = 0');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(255) PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);
    await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS sha256 TEXT');

    const migrations = (await migrationHashes())
      .filter(migration => upToVersion === null || Number(migration.version.slice(0, 4)) <= upToVersion);
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
