import { readFile, readdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const { Client } = pg;
const dir = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');
const client = new Client();
await client.connect();
try {
  const files = (await readdir(dir)).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort().slice(0, 46);
  await client.query('DROP SCHEMA public CASCADE');
  await client.query('CREATE SCHEMA public');
  for (const name of files) {
    const sql = await readFile(join(dir, name), 'utf8');
    const statements = sql.replace(/^--\s*no-transaction\s*$/gim, '').split(/;\s*\n(?=(?:ALTER|CREATE|DROP|INSERT|UPDATE|DELETE|DO)\b)/i).map(s => s.trim()).filter(Boolean);
    await client.query('BEGIN');
    try {
      for (const statement of statements) await client.query(statement);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(255) PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())');
  for (const name of files) await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [name.replace(/\.sql$/, '')]);
  console.log(JSON.stringify({ legacyMigrationCount: files.length }));
} finally {
  await client.end();
}
