import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { ADDRESS_BOOK_PRESENTATION_SQL } from './addressBookPresentation.js';

const suite = process.env.DB_HOST && process.env.DB_NAME ? describe : describe.skip;
suite('account-scoped address book presentation (PostgreSQL)', () => {
  it('keeps counts and books stable, refuses ambiguous accounts, and preserves source identities', async () => {
    const client = new Client({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432), database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
    await client.connect();
    try {
      await client.query('BEGIN');
      const schema = `book_scope_${randomUUID().replaceAll('-', '')}`;
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      await client.query(`
        CREATE TABLE address_books (id uuid PRIMARY KEY, user_id uuid, name text, source text, visible boolean DEFAULT true, dav_mode text DEFAULT 'off', created_at timestamptz DEFAULT now());
        CREATE TABLE contacts (id uuid PRIMARY KEY, user_id uuid, address_book_id uuid);
        CREATE TABLE integration_collections (id uuid PRIMARY KEY, user_id uuid, local_address_book_id uuid, kind text, connection_id uuid, source_connection_id uuid, account_id uuid, source_access text, user_access text);
        CREATE TABLE provider_connections (id uuid PRIMARY KEY, user_id uuid, provider text);
        CREATE TABLE user_integrations (id uuid PRIMARY KEY, user_id uuid, provider text, label text, config jsonb DEFAULT '{}'::jsonb);
        CREATE TABLE source_connections (id uuid PRIMARY KEY, user_id uuid, integration_id uuid);
        CREATE TABLE email_accounts (id uuid PRIMARY KEY, user_id uuid, provider_connection_id uuid, email_address text, name text);
      `);
      const owner = randomUUID(); const other = randomUUID(); const connection = randomUUID();
      const book = randomUUID(); const collection = randomUUID(); const accountA = randomUUID(); const accountB = randomUUID();
      await client.query("INSERT INTO provider_connections VALUES ($1, $2, 'google')", [connection, owner]);
      await client.query("INSERT INTO address_books (id,user_id,name,source) VALUES ($1,$2,'Contacts','google')", [book, owner]);
      await client.query("INSERT INTO integration_collections (id,user_id,local_address_book_id,kind,connection_id) VALUES ($1,$2,$3,'address_book',$4)", [collection, owner, book, connection]);
      await client.query("INSERT INTO email_accounts (id,user_id,provider_connection_id,email_address) VALUES ($1,$2,$3,'same@example.test')", [accountA, owner, connection]);
      await client.query('INSERT INTO contacts VALUES ($1,$3,$4),($2,$3,$4)', [randomUUID(), randomUUID(), owner, book]);
      // A foreign tenant's mailbox must never resolve as this book's action target.
      await client.query("INSERT INTO email_accounts VALUES ($1,$2,$3,'foreign@example.test')", [randomUUID(), other, connection]);
      const list = () => client.query(ADDRESS_BOOK_PRESENTATION_SQL, [owner]);
      expect((await list()).rows).toEqual([expect.objectContaining({ id: book, contact_count: 2, connection_id: connection, account_id: accountA, account_email: 'same@example.test' })]);
      await client.query("INSERT INTO email_accounts (id,user_id,provider_connection_id,email_address) VALUES ($1,$2,$3,'same@example.test')", [accountB, owner, connection]);
      expect((await list()).rows).toEqual([expect.objectContaining({ id: book, contact_count: 2, account_id: null, account_email: null })]);
      // An explicit owner, when recorded, is authoritative even with duplicate mailbox labels.
      await client.query('UPDATE integration_collections SET account_id=$1 WHERE id=$2', [accountB, collection]);
      expect((await list()).rows[0]).toMatchObject({ account_id: accountB, contact_count: 2 });
      const unrelatedAccount = randomUUID();
      await client.query("INSERT INTO email_accounts (id,user_id,provider_connection_id,email_address) VALUES ($1,$2,$3,'same@example.test')", [unrelatedAccount, owner, randomUUID()]);
      await client.query('UPDATE integration_collections SET account_id=$1 WHERE id=$2', [unrelatedAccount, collection]);
      expect((await list()).rows[0]).toMatchObject({ account_id: null, account_email: null });
      await client.query('UPDATE integration_collections SET account_id=$1 WHERE id=$2', [randomUUID(), collection]);
      expect((await list()).rows[0]).toMatchObject({ account_id: null, account_email: null });
      const davBook = randomUUID(); const source = randomUUID(); const integration = randomUUID();
      await client.query("INSERT INTO user_integrations VALUES ($1,$2,'carddav','Test DAV','{}')", [integration, owner]);
       await client.query("INSERT INTO source_connections VALUES ($1,$2,$3)", [source, owner, integration]);
       await client.query("INSERT INTO address_books (id,user_id,name,source) VALUES ($1,$2,'Contacts','carddav')", [davBook, owner]);
      await client.query("INSERT INTO integration_collections (id,user_id,local_address_book_id,kind,source_connection_id) VALUES ($1,$2,$3,'address_book',$4)", [randomUUID(), owner, davBook, source]);
      expect((await list()).rows.find(row => row.id === davBook)).toMatchObject({ source_connection_id: source, connection_id: null, account_id: null, contact_count: 0 });
      expect((await client.query(ADDRESS_BOOK_PRESENTATION_SQL, [other])).rows).toEqual([]);
    } finally {
      try { await client.query('ROLLBACK'); } finally { await client.end(); }
    }
  });
});
