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
  for (let i = 1; i <= 12; i++) {
    const accountId = i % 2 ? accountA : accountB;
    const id = `00000000-0000-0000-0000-0000000002${String(10 + i).padStart(2, '0')}`;
    const messageId = `<legacy-test-${i}@fixture.test>`;
    await client.query(`INSERT INTO messages (id,account_id,uid,folder,message_id,subject,from_email,to_addresses,date,in_reply_to,thread_references,thread_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,NULL,$5)`, [id, accountId, i, i % 5 === 0 ? 'Sent' : 'INBOX', messageId, i % 3 === 0 ? 'Re: Test' : 'Test', `sender-${i}@fixture.test`, JSON.stringify([{ email: `recipient-${i}@fixture.test` }]), `${2014 + (i % 4) * 5}-01-01T12:00:00Z`]);
  }
  return { userId, accounts: 2, messages: 12 };
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
  const fixture = await insertLegacyFixture(client);
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(255) PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())');
  for (const name of files) await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [name.replace(/\.sql$/, '')]);
  console.log(JSON.stringify({ legacyMigrationCount: files.length, fixturePath, fixture }));
} finally {
  await client.end();
}
