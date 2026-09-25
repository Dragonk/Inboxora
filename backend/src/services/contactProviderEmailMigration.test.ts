import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

const migrationName = '0135_contact_provider_email_uniqueness.sql';
const migration = (name: string) => readFileSync(join(process.cwd(), 'migrations', name), 'utf8');
const repairSql = migration(migrationName);

// Always run the migration contract; PostgreSQL behavior follows the integration
// suite's explicit DB_HOST/DB_NAME opt-in. No application database pool is imported.
describe('provider contact email uniqueness migration contract', () => {
  it('follows the local-key migration and only removes the remaining legacy index', () => {
    const files = readdirSync(join(process.cwd(), 'migrations')).filter(name => name.endsWith('.sql')).sort();
    expect(files.filter(name => name.startsWith('0135_'))).toEqual([migrationName]);
    expect(files[files.indexOf(migrationName) - 1]).toBe('0134_contact_local_email_keys.sql');
    const statements = repairSql.replace(/^--.*$/gm, '').split(';').map(sql => sql.trim().replace(/\s+/g, ' ')).filter(Boolean);
    expect(statements).toEqual([
      'DROP INDEX IF EXISTS contacts_address_book_primary_email_idx',
      'CREATE INDEX IF NOT EXISTS contacts_book_primary_email_lookup_idx ON contacts (address_book_id, primary_email) WHERE primary_email IS NOT NULL',
    ]);
  });
});

const describePg = process.env.DB_HOST && process.env.DB_NAME ? describe : describe.skip;
describePg('provider contact email migration on PostgreSQL', () => {
  it('repairs the actual 0075/0134 upgrade, preserves identities and local keys, and replays safely', async () => {
    const client = new Client({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT ?? 5432),
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    });
    await client.connect();
    try {
      await client.query('BEGIN');
      // A private, rollback-only schema prevents collisions with other suites.
      const schema = `contact_email_${randomUUID().replaceAll('-', '')}`;
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      // Minimal pre-0075 tables: execute the released migrations themselves, not
      // a hand-written approximation of the conflicting indexes or local keys.
      await client.query(`
        CREATE TABLE users (id UUID PRIMARY KEY);
        CREATE TABLE address_books (id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id), source TEXT NOT NULL);
        CREATE TABLE contacts (
          id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id),
          address_book_id UUID NOT NULL REFERENCES address_books(id), primary_email TEXT, uid TEXT NOT NULL,
          UNIQUE (address_book_id, uid)
        );
        CREATE UNIQUE INDEX contacts_book_primary_email_idx ON contacts (address_book_id, primary_email)
          WHERE primary_email IS NOT NULL;
      `);
      const user = randomUUID();
      const localBook = randomUUID();
      const providerBook = randomUUID();
      const localContact = randomUUID();
      const providerContact = randomUUID();
      const secondProviderContact = randomUUID();
      await client.query('INSERT INTO users VALUES ($1)', [user]);
      await client.query("INSERT INTO address_books VALUES ($1, $3, 'local'), ($2, $3, 'microsoft')", [localBook, providerBook, user]);
      const insertContact = (id: string, book: string, uid: string, email: string) => client.query(
        'INSERT INTO contacts (id, user_id, address_book_id, uid, primary_email) VALUES ($1, $2, $3, $4, $5)',
        [id, user, book, uid, email],
      );
      await insertContact(localContact, localBook, 'local-1', 'Shared@Example.test');
      await insertContact(providerContact, providerBook, 'graph-object-1', 'shared@example.test');
      await client.query(migration('0075_address_book_visibility.sql'));
      await client.query(migration('0134_contact_local_email_keys.sql'));
      const beforeContacts = (await client.query('SELECT * FROM contacts ORDER BY id')).rows;
      const beforeKeys = (await client.query('SELECT * FROM contact_local_email_keys')).rows;
      expect(beforeKeys).toEqual([expect.objectContaining({
        user_id: user, address_book_id: localBook, contact_id: localContact, normalized_email: 'shared@example.test',
      })]);

      // Prove the released upgrade still rejects a distinct provider object.
      await client.query('SAVEPOINT duplicate_before_repair');
      await expect(insertContact(secondProviderContact, providerBook, 'graph-object-2', 'shared@example.test'))
        .rejects.toMatchObject({ code: '23505', constraint: 'contacts_address_book_primary_email_idx' });
      await client.query('ROLLBACK TO SAVEPOINT duplicate_before_repair');

      await client.query(repairSql);
      expect((await client.query('SELECT * FROM contacts ORDER BY id')).rows).toEqual(beforeContacts);
      expect((await client.query('SELECT * FROM contact_local_email_keys')).rows).toEqual(beforeKeys);
      await insertContact(secondProviderContact, providerBook, 'graph-object-2', 'shared@example.test');
      expect((await client.query('SELECT id, uid FROM contacts WHERE address_book_id = $1 ORDER BY uid', [providerBook])).rows).toEqual([
        { id: providerContact, uid: 'graph-object-1' },
        { id: secondProviderContact, uid: 'graph-object-2' },
      ]);

      // Reapplying must work with duplicate provider emails already stored.
      await client.query(repairSql);
      const indexes = (await client.query<{ indexname: string; indexdef: string }>(
        'SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2', [schema, 'contacts'],
      )).rows;
      expect(indexes.map(index => index.indexname)).not.toContain('contacts_address_book_primary_email_idx');
      expect(indexes.map(index => index.indexname)).not.toContain('contacts_book_primary_email_idx');
      const lookup = indexes.find(index => index.indexname === 'contacts_book_primary_email_lookup_idx');
      expect(lookup?.indexdef).toContain('USING btree (address_book_id, primary_email) WHERE (primary_email IS NOT NULL)');
      expect(lookup?.indexdef).not.toContain('UNIQUE');

      // Local deduplication remains keyed separately; shared emails must not
      // weaken either its conflict target or its existing contact ownership.
      const anotherLocal = randomUUID();
      await insertContact(anotherLocal, localBook, 'local-2', 'Shared@Example.test');
      await client.query('SAVEPOINT duplicate_local_key');
      await expect(client.query(
        'INSERT INTO contact_local_email_keys (user_id, address_book_id, normalized_email, contact_id) VALUES ($1, $2, $3, $4)',
        [user, localBook, 'shared@example.test', anotherLocal],
      )).rejects.toMatchObject({ code: '23505', constraint: 'contact_local_email_keys_pkey' });
      await client.query('ROLLBACK TO SAVEPOINT duplicate_local_key');
      const dedup = await client.query(
        `INSERT INTO contact_local_email_keys (user_id, address_book_id, normalized_email, contact_id)
         VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, address_book_id, normalized_email) DO NOTHING RETURNING contact_id`,
        [user, localBook, 'shared@example.test', anotherLocal],
      );
      expect(dedup.rows).toEqual([]);
      expect((await client.query('SELECT * FROM contact_local_email_keys')).rows).toEqual(beforeKeys);
      await client.query('SAVEPOINT duplicate_contact_key');
      await expect(client.query(
        'INSERT INTO contact_local_email_keys (user_id, address_book_id, normalized_email, contact_id) VALUES ($1, $2, $3, $4)',
        [user, localBook, 'other@example.test', localContact],
      )).rejects.toMatchObject({ code: '23505', constraint: 'contact_local_email_keys_contact_id_key' });
      await client.query('ROLLBACK TO SAVEPOINT duplicate_contact_key');
    } finally {
      try { await client.query('ROLLBACK'); } finally { await client.end(); }
    }
  });
});
