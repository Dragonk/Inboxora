import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { pool } from './db.js';

const hasPg = !!(process.env.DB_HOST && process.env.DB_NAME);
const suite = hasPg ? describe : describe.skip;

suite('account default sender constraints (PostgreSQL)', () => {
  let client: PoolClient;
  let userId: string;
  let accountId: string;
  let otherAccountId: string;
  let aliasId: string;
  let foreignAliasId: string;
  beforeEach(async () => {
    client = await pool.connect();
    await client.query('BEGIN');
    userId = randomUUID();
    accountId = randomUUID(); otherAccountId = randomUUID();
    aliasId = randomUUID(); foreignAliasId = randomUUID();
    await client.query('INSERT INTO users (id, username) VALUES ($1, $2)', [userId, `sender-${userId}`]);
    await client.query(`INSERT INTO email_accounts (id, user_id, name, email_address)
      VALUES ($1, $3, 'Primary', 'main@example.test'), ($2, $3, 'Other', 'other@example.test')`, [accountId, otherAccountId, userId]);
    await client.query(`INSERT INTO account_aliases (id, account_id, name, email)
      VALUES ($1, $2, 'Work', 'work@example.test'), ($3, $4, 'Foreign', 'foreign@example.test')`, [aliasId, accountId, foreignAliasId, otherAccountId]);
  });
  afterEach(async () => {
    if (client) { try { await client.query('ROLLBACK'); } finally { client.release(); } }
  });
  const defaultOf = async (id: string) => (await client.query<{ default_alias_id: string | null }>(
    'SELECT default_alias_id FROM email_accounts WHERE id = $1', [id])).rows[0]?.default_alias_id;

  it('defaults existing/new accounts to primary and keeps preferences independent', async () => {
    expect(await defaultOf(accountId)).toBeNull();
    await client.query('UPDATE email_accounts SET default_alias_id = $1 WHERE id = $2', [aliasId, accountId]);
    expect(await defaultOf(accountId)).toBe(aliasId);
    expect(await defaultOf(otherAccountId)).toBeNull();
    await client.query('UPDATE email_accounts SET default_alias_id = NULL WHERE id = $1', [accountId]);
    expect(await defaultOf(accountId)).toBeNull();
  });

  it('rejects even a same-user alias belonging to another account', async () => {
    await client.query('SAVEPOINT foreign_alias');
    await expect(client.query('UPDATE email_accounts SET default_alias_id = $1 WHERE id = $2', [foreignAliasId, accountId])).rejects.toMatchObject({ code: '23503' });
    await client.query('ROLLBACK TO SAVEPOINT foreign_alias');
    expect(await defaultOf(accountId)).toBeNull();
  });

  it('clears only the selected alias on deletion, preserving the primary account row', async () => {
    await client.query('UPDATE email_accounts SET default_alias_id = $1 WHERE id = $2', [aliasId, accountId]);
    await client.query('DELETE FROM account_aliases WHERE id = $1', [foreignAliasId]);
    expect(await defaultOf(accountId)).toBe(aliasId);
    await client.query('DELETE FROM account_aliases WHERE id = $1', [aliasId]);
    expect(await defaultOf(accountId)).toBeNull();
    const account = await client.query('SELECT id, email_address FROM email_accounts WHERE id = $1', [accountId]);
    expect(account.rows).toEqual([{ id: accountId, email_address: 'main@example.test' }]);
  });

  it('retains the selection across alias edits and permits account cascade deletion', async () => {
    await client.query('UPDATE email_accounts SET default_alias_id = $1 WHERE id = $2', [aliasId, accountId]);
    await client.query("UPDATE account_aliases SET email = 'new@example.test' WHERE id = $1", [aliasId]);
    expect(await defaultOf(accountId)).toBe(aliasId);
    await client.query('DELETE FROM email_accounts WHERE id = $1', [accountId]);
    expect(await defaultOf(accountId)).toBeUndefined();
    expect((await client.query('SELECT id FROM account_aliases WHERE id = $1', [aliasId])).rows).toEqual([]);
  });
});
