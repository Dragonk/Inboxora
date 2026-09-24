import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

const enabled = process.env.DB_HOST && process.env.DB_NAME;
const suite = enabled ? describe : describe.skip;

suite('Gmail legacy charset cache refresh migration (PostgreSQL)', () => {
  it('invalidates only cached Gmail reader bodies and permits on-demand completion', async () => {
    const client = new Client({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432), database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
    await client.connect();
    const schema = `gmail_cache_${randomUUID().replaceAll('-', '')}`;
    try {
      await client.query('BEGIN');
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      await client.query(`
        CREATE TABLE email_accounts (id uuid PRIMARY KEY, mail_transport text);
        CREATE TABLE messages (id uuid PRIMARY KEY, account_id uuid NOT NULL, body_html text, body_text text, gmail_reader_body_complete boolean NOT NULL DEFAULT false);
      `);
      const gmail = randomUUID(); const imap = randomUUID();
      await client.query('INSERT INTO email_accounts VALUES ($1, $2), ($3, $4)', [gmail, 'gmail_api', imap, 'imap_smtp']);
      await client.query('INSERT INTO messages VALUES ($1, $2, NULL, $3, true), ($4, $2, NULL, NULL, true), ($5, $6, NULL, $3, true)', [randomUUID(), gmail, 'legacy body', randomUUID(), randomUUID(), imap]);
      const migration = await readFile(new URL('../../migrations/0140_gmail_legacy_charset_cache_refresh.sql', import.meta.url), 'utf8');
      await client.query(migration);
      const rows = await client.query('SELECT gmail_reader_body_complete FROM messages ORDER BY id');
      expect(rows.rows.filter(row => row.gmail_reader_body_complete === false)).toHaveLength(1);
      expect(rows.rows.filter(row => row.gmail_reader_body_complete === true)).toHaveLength(2);
      await client.query('UPDATE messages SET gmail_reader_body_complete = true WHERE account_id = $1', [gmail]);
      expect((await client.query('SELECT COUNT(*)::int AS count FROM messages WHERE account_id = $1 AND gmail_reader_body_complete = true', [gmail])).rows[0].count).toBe(2);
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
  });
});
