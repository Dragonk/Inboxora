import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { pool } from './db.js';

const suite = process.env.DB_HOST && process.env.DB_NAME ? describe : describe.skip;

suite('fresh durable mail flag migration (isolated PostgreSQL schema)', () => {
  it('imports only uncertain flag observations, preserves history, and enforces owner constraints', async () => {
    const client = await pool.connect();
    const schema = `mail_flags_migration_${randomUUID().replaceAll('-', '')}`;
    const userId = randomUUID();
    const otherUserId = randomUUID();
    const accountId = randomUUID();
    try {
      await client.query('BEGIN');
      // LIKE excludes foreign keys: these fixtures cannot mutate or delete the
      // application tables. The entire schema is rolled back after assertions.
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET LOCAL search_path TO "${schema}", public`);
      for (const table of ['users', 'email_accounts', 'messages', 'provider_operations']) {
        await client.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
      }
      await client.query('ALTER TABLE messages DROP COLUMN provider_visibility_checked_at');
      await client.query('INSERT INTO users(id,username) VALUES($1,$2),($3,$4)', [userId, `owner-${userId}`, otherUserId, `other-${otherUserId}`]);
      await client.query(`INSERT INTO email_accounts(id,user_id,name,email_address,protocol,mail_transport)
        VALUES($1,$2,'Synthetic migration mailbox','migration@example.test','imap','gmail_api')`, [accountId, userId]);
      const samples = [
        { key: null, payload: null, status: 'outcome_unknown', operation: 'update', readback: true },
        { key: 'graph-mail-flag:unknown', payload: { flag: '\\Seen', value: true }, status: 'outcome_unknown', operation: 'update', readback: true },
        { key: 'gmail-mail-flag:pending', payload: { flag: '\\Flagged', value: true }, status: 'pending', operation: 'update', readback: true },
        { key: 'graph-mail-move:pending', payload: { destinationFolderId: 'remote-trash' }, status: 'pending', operation: 'update', readback: false },
        { key: 'gmail-mail-delete:unknown', payload: { providerMessageId: 'remote-delete' }, status: 'outcome_unknown', operation: 'delete', readback: false },
        { key: 'graph-mail-flag:confirmed', payload: { flag: '\\Seen', value: true }, status: 'committed', operation: 'update', readback: false },
      ];
      const expectedReadbacks: string[] = [];
      for (const [index, sample] of samples.entries()) {
        const messageId = randomUUID();
        if (sample.readback) expectedReadbacks.push(messageId);
        await client.query(`INSERT INTO messages(id,account_id,uid,folder,is_read,is_starred)
          VALUES($1,$2,$3,'INBOX',false,false)`, [messageId, accountId, index + 1]);
        await client.query(`INSERT INTO provider_operations(user_id,account_id,resource_id,resource_type,operation,status,idempotency_key,payload)
          VALUES($1,$2,$3,'message',$4,$5,$6,$7::jsonb)`,
        [userId, accountId, messageId, sample.operation, sample.status, sample.key, sample.payload === null ? null : JSON.stringify(sample.payload)]);
      }
      const operationsBefore = (await client.query('SELECT id,status,payload FROM provider_operations ORDER BY id')).rows;
      const messagesBefore = (await client.query('SELECT id,is_read,is_starred FROM messages ORDER BY id')).rows;
      await client.query(await readFile(new URL('../../migrations/0156_mail_flag_state.sql', import.meta.url), 'utf8'));
      const obligations = await client.query<{ message_id: string; identity: unknown }>('SELECT message_id,identity FROM mail_flag_readbacks ORDER BY message_id');
      expect(obligations.rows.map(row => row.message_id)).toEqual(expectedReadbacks.sort());
      expect(obligations.rows.every(row => row.identity === null)).toBe(true);
      expect((await client.query('SELECT * FROM mail_flag_intents')).rows).toEqual([]);
      expect((await client.query('SELECT id,status,payload FROM provider_operations ORDER BY id')).rows).toEqual(operationsBefore);
      expect((await client.query('SELECT id,is_read,is_starred FROM messages ORDER BY id')).rows).toEqual(messagesBefore);
      const indexes = await client.query<{ indexname: string; indexdef: string }>('SELECT indexname,indexdef FROM pg_indexes WHERE schemaname=$1', [schema]);
      expect(indexes.rows.find(row => row.indexname === 'mail_flag_intents_due')?.indexdef).toContain('next_attempt_at');
      expect(indexes.rows.find(row => row.indexname === 'mail_flag_readbacks_due')?.indexdef).toContain('next_attempt_at');

      const trigger = await client.query<{ trigger_name: string }>(
        `SELECT t.tgname AS trigger_name FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
          JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND NOT t.tgisinternal`, [schema],
      );
      expect(trigger.rows).toEqual([{ trigger_name: 'provider_operations_mail_visibility_fence' }]);
      const version = async () => (await client.query<{ version: string }>('SELECT ctid::text AS version FROM messages WHERE id=$1', [expectedReadbacks[0]])).rows[0].version;
      const beforeFence = await version();
      // Flags and a different owner's intent cannot touch this message tuple.
      await client.query(`INSERT INTO provider_operations(user_id,account_id,resource_id,resource_type,operation,status,payload)
        VALUES($1,$2,$3,'message','update','in_flight',$4::jsonb)`,
      [userId, accountId, expectedReadbacks[0], JSON.stringify({ flag: '\\Seen', value: true })]);
      expect(await version()).toBe(beforeFence);
      await client.query(`INSERT INTO provider_operations(user_id,account_id,resource_id,resource_type,operation,status)
        VALUES($1,$2,$3,'message','delete','in_flight')`, [otherUserId, accountId, expectedReadbacks[0]]);
      expect(await version()).toBe(beforeFence);
      await client.query(`INSERT INTO provider_operations(user_id,account_id,resource_id,resource_type,operation,status,payload)
        VALUES($1,$2,$3,'message','update','in_flight',$4::jsonb)`,
      [userId, accountId, expectedReadbacks[0], JSON.stringify({ destinationFolderId: 'remote-trash' })]);
      expect(await version()).not.toBe(beforeFence);
      expect((await client.query('SELECT id,is_read,is_starred FROM messages ORDER BY id')).rows).toEqual(messagesBefore);
      await client.query('SAVEPOINT owner_check');
      await expect(client.query(`INSERT INTO mail_flag_intents(message_id,flag,user_id,account_id,value,identity)
        VALUES($1,$2,$3,$4,true,'{}'::jsonb)`, [expectedReadbacks[0], '\\Seen', otherUserId, accountId])).rejects.toMatchObject({ code: '23503' });
      await client.query('ROLLBACK TO SAVEPOINT owner_check');
      await client.query(`INSERT INTO mail_flag_intents(message_id,flag,user_id,account_id,value,identity)
        VALUES($1,$2,$3,$4,true,'{}'::jsonb)`, [expectedReadbacks[0], '\\Seen', userId, accountId]);
      await client.query('DELETE FROM messages WHERE id=$1', [expectedReadbacks[0]]);
      expect((await client.query('SELECT * FROM mail_flag_readbacks WHERE message_id=$1', [expectedReadbacks[0]])).rows).toEqual([]);
      expect((await client.query('SELECT * FROM mail_flag_intents WHERE message_id=$1', [expectedReadbacks[0]])).rows).toEqual([]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
