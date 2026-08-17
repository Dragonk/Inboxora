import { readFile, readdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const { Client } = pg;
const dir = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');
const fixturePath = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/legacy_conversation_upgrade.sql');

function splitStatements(sql) {
  const statements = [];
  let start = 0;
  let quote = null;
  let dollarTag = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) { i += dollarTag.length - 1; dollarTag = null; }
      continue;
    }
    if (quote) {
      if (ch === quote) { if (sql[i + 1] === quote) i++; else quote = null; }
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '$') {
      const match = sql.slice(i).match(/^\$[A-Za-z_0-9]*\$/);
      if (match) { dollarTag = match[0]; i += dollarTag.length - 1; continue; }
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

async function insertLegacyFixture(client) {
  const userId = '00000000-0000-0000-0000-000000000201';
  const accountA = '00000000-0000-0000-0000-000000000202';
  const accountB = '00000000-0000-0000-0000-000000000203';
  await client.query('DELETE FROM users WHERE id = $1', [userId]);
  await client.query('INSERT INTO users (id, username) VALUES ($1,$2)', [userId, `legacy-fixture-${Date.now()}`]);
  await client.query('INSERT INTO email_accounts (id,user_id,name,email_address) VALUES ($1,$3,$4,$5),($2,$3,$6,$7)', [accountA, accountB, userId, 'Legacy A', 'legacy-a@example.test', 'Legacy B', 'legacy-b@example.test']);
  const fixture = await client.query('SELECT * FROM legacy_conversation_fixture ORDER BY fixture_key');
  const accounts = { 'account-a': accountA, 'account-b': accountB };
  for (const row of fixture.rows) {
    const id = `00000000-0000-0000-0000-${String(200 + fixture.rows.indexOf(row)).padStart(12, '0')}`;
    await client.query(`INSERT INTO messages (id,account_id,uid,folder,message_id,subject,from_email,to_addresses,date,in_reply_to,thread_references,thread_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$5)`, [id, accounts[row.account_key], fixture.rows.indexOf(row) + 1, row.sent_copy ? 'Sent' : 'INBOX', row.message_id, row.subject, row.sender, JSON.stringify([{ email: row.recipient }]), row.message_date, row.in_reply_to, row.references_header]);
  }
  return { userId, accounts: 2, messages: fixture.rows.length };
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
      try { await client.query(sql); await client.query('COMMIT'); }
      catch (error) { await client.query('ROLLBACK'); throw error; }
    }
  }
  const fixtureSql = await readFile(fixturePath, 'utf8');
  for (const statement of splitStatements(fixtureSql)) await client.query(statement);
  const fixture = await insertLegacyFixture(client);
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(255) PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())');
  for (const name of files) await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [name.replace(/\.sql$/, '')]);
  console.log(JSON.stringify({ legacyMigrationCount: files.length, fixturePath, fixture }));
} finally {
  await client.end();
}
