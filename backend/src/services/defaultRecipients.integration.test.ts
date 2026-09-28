import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { pool } from './db.js';

// Ordinary unit runs have no PostgreSQL; the dedicated CI integration job requires it.
const hasPg = !!(process.env.DB_HOST && process.env.DB_NAME);
if (!hasPg && process.env.REQUIRE_DEFAULT_RECIPIENTS_POSTGRES === '1') {
  throw new Error('Default recipients integration requires DB_HOST and DB_NAME');
}
const suite = hasPg ? describe : describe.skip;
suite('account default recipients migration (PostgreSQL)', () => {
  let client: PoolClient | undefined;
  beforeEach(async () => {
    client = await pool.connect();
    await client.query('BEGIN');
    const schema = `default_recipients_${randomUUID().replaceAll('-', '')}`;
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema}`);
    // Minimal pre-0150 account schema; exercise both consecutive real migrations.
    await client.query(`CREATE TABLE email_accounts (id UUID PRIMARY KEY);
      CREATE TABLE account_aliases (id UUID PRIMARY KEY, account_id UUID REFERENCES email_accounts(id));
      INSERT INTO email_accounts (id) VALUES ('11111111-1111-4111-8111-111111111111')`);
    for (const name of ['0150_account_default_sender.sql', '0151_account_default_recipients.sql']) {
      await client.query(readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8'));
    }
  });
  afterEach(async () => {
    if (client) {
      try { await client.query('ROLLBACK'); } finally { client.release(); client = undefined; }
    }
  });
  /** Require the transaction-scoped PostgreSQL client rather than silently bypassing database assertions. */
  function db(): PoolClient {
    if (!client) throw new Error('PostgreSQL fixture not initialized');
    return client;
  }
  const id = '11111111-1111-4111-8111-111111111111';
  it('backfills existing accounts and defaults new accounts to non-null empty arrays', async () => {
    await db().query('INSERT INTO email_accounts (id) VALUES ($1)', [randomUUID()]);
    const rows = await db().query('SELECT default_cc, default_bcc FROM email_accounts');
    expect(rows.rows).toEqual([{ default_cc: [], default_bcc: [] }, { default_cc: [], default_bcc: [] }]);
  });
  it('persists multiple values and overlaps, preserves omission and clears explicitly', async () => {
    const cc = ['a@example.com', 'shared@example.com'];
    const bcc = ['shared@example.com', 'private@example.com'];
    await db().query('UPDATE email_accounts SET default_cc = $1, default_bcc = $2 WHERE id = $3', [cc, bcc, id]);
    expect((await db().query('SELECT default_cc, default_bcc FROM email_accounts WHERE id = $1', [id])).rows)
      .toEqual([{ default_cc: cc, default_bcc: bcc }]);
    await db().query('UPDATE email_accounts SET default_cc = $1 WHERE id = $2', [[], id]);
    expect((await db().query('SELECT default_cc, default_bcc FROM email_accounts WHERE id = $1', [id])).rows)
      .toEqual([{ default_cc: [], default_bcc: bcc }]);
    await db().query('UPDATE email_accounts SET default_bcc = $1 WHERE id = $2', [[], id]);
    expect((await db().query('SELECT default_bcc FROM email_accounts WHERE id = $1', [id])).rows).toEqual([{ default_bcc: [] }]);
  });
  for (const field of ['default_cc', 'default_bcc']) {
    it(`${field} allows the exact count and length boundaries`, async () => {
      const longest = 'a'.repeat(64) + '@' + ['b'.repeat(63), 'c'.repeat(63), 'd'.repeat(61)].join('.');
      expect(longest.length).toBe(254);
      const values = Array.from({ length: 50 }, (_, i) => i === 0 ? longest : `a${i}@example.com`);
      await db().query(`UPDATE email_accounts SET ${field} = $1 WHERE id = $2`, [values, id]);
      expect((await db().query(`SELECT ${field} FROM email_accounts WHERE id = $1`, [id])).rows).toEqual([{ [field]: values }]);
    });
    const invalid = [null, [null], [''], ['a'.repeat(255)], Array(51).fill('a@example.com'),
      [['a@example.com', 'b@example.com']], ['a@example.com\nBcc: b@example.com'], ['a\t@example.com']];
    it.each(invalid.map(value => ({ value })))(`${field} rejects invalid bounded arrays atomically: $value`, async ({ value }) => {
      await db().query('SAVEPOINT invalid_update');
      const other = field === 'default_cc' ? 'default_bcc' : 'default_cc';
      await expect(db().query(`UPDATE email_accounts SET ${other} = ARRAY['valid@example.com'], ${field} = $1 WHERE id = $2`, [value, id]))
        .rejects.toMatchObject({ code: value === null ? '23502' : '23514' });
      await db().query('ROLLBACK TO SAVEPOINT invalid_update');
      expect((await db().query('SELECT default_cc, default_bcc FROM email_accounts WHERE id = $1', [id])).rows)
        .toEqual([{ default_cc: [], default_bcc: [] }]);
    });
    it(`${field} rejects nonstandard array lower bounds`, async () => {
      await expect(db().query(`UPDATE email_accounts SET ${field} = '[0:0]={a@example.com}'::text[] WHERE id = $1`, [id]))
        .rejects.toMatchObject({ code: '23514' });
    });
  }
});
