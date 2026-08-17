import { readFile, readdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const { Client } = pg;
const dir = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');

function splitStatements(sql) {
  const statements = [];
  let start = 0;
  let quote = null;
  let dollarTag = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) {
        i += dollarTag.length - 1;
        dollarTag = null;
      }
      continue;
    }
    if (quote) {
      if (ch === quote) {
        if (sql[i + 1] === quote) i++;
        else quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '$') {
      const match = sql.slice(i).match(/^\$[A-Za-z_0-9]*\$/);
      if (match) {
        dollarTag = match[0];
        i += dollarTag.length - 1;
        continue;
      }
    }
    if (ch === ';') {
      const statement = sql.slice(start, i).trim();
      if (statement) statements.push(statement);
      start = i + 1;
    }
  }
  const tail = sql.slice(start).trim();
  if (tail) statements.push(tail);
  return statements;
}

const client = new Client();
await client.connect();
try {
  const files = (await readdir(dir)).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort().slice(0, 46);
  await client.query('DROP SCHEMA public CASCADE');
  await client.query('CREATE SCHEMA public');
  for (const name of files) {
    const sql = await readFile(join(dir, name), 'utf8');
    const noTransaction = /^--\s*no-transaction\b/im.test(sql);
    if (noTransaction) {
      for (const statement of splitStatements(sql.replace(/^--\s*no-transaction\s*$/gim, ''))) await client.query(statement);
    } else {
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  }
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(255) PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())');
  for (const name of files) await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [name.replace(/\.sql$/, '')]);
  console.log(JSON.stringify({ legacyMigrationCount: files.length }));
} finally {
  await client.end();
}
