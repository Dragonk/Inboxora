import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import { query } from './db.js';
import { encrypt } from './encryption.js';

/**
 * Real PostgreSQL evidence that an unedited contact from another source is not overwritten by a CardDAV merge
 * (DAV-03 / the contact-data safety requirement).
 *
 * CardDAV's HTTP boundary is faked — no user server is called — but the source address book, the foreign contact,
 * the pull, the duplicate policy and both resulting books are real database operations. The assertion is the data
 * safety property: the foreign row's vCard/display name/email stay byte-for-byte as they were, and the incoming
 * CardDAV card gets its own row instead of an UPDATE to the Google book.
 */

const hasPg = process.env.DB_HOST && process.env.DB_NAME;
const describeOrSkip = hasPg ? describe : describe.skip;
const calls = vi.hoisted(() => ({
  discover: vi.fn<() => Promise<Array<{ url: string; displayName: string }>>>(),
  cards: vi.fn<() => Promise<Array<{ href: string; etag: string | null; vcard: string }>>>(),
}));
vi.mock('./carddavClient.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./carddavClient.js')>()),
  discoverAddressBooks: calls.discover,
  fetchAddressBookCards: calls.cards,
}));

const userId = crypto.randomUUID();
const originalKey = process.env.ENCRYPTION_KEY;
const GOOGLE_VCARD = 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:google-1\r\nFN:Original Google\r\nEMAIL:duplicate@example.test\r\nEND:VCARD\r\n';
const DAV_VCARD = 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:dav-1\r\nFN:Incoming CardDAV\r\nEMAIL:duplicate@example.test\r\nEND:VCARD\r\n';

beforeAll(async () => {
  if (!hasPg) return;
  process.env.ENCRYPTION_KEY ||= 'f'.repeat(64);
  await query("INSERT INTO users(id, username, password_hash) VALUES($1, 'dav-foreign-data', 'unused')", [userId]);
  await query(
    `INSERT INTO user_integrations (user_id, provider, config)
     VALUES ($1, 'carddav', $2::jsonb)`,
    [userId, JSON.stringify({ serverUrl: 'https://dav.example', username: 'dav-user', password: encrypt('dav-password'), dupMode: 'merge' })],
  );
  const googleBook = await query<{ id: string }>(
    `INSERT INTO address_books (user_id, name, source, dav_mode) VALUES ($1, 'Google', 'google', 'off') RETURNING id`, [userId],
  );
  await query(
    `INSERT INTO contacts (user_id, address_book_id, display_name, uid, primary_email, emails, vcard, etag)
     VALUES ($1, $2, 'Original Google', 'google-1', 'duplicate@example.test', $3::jsonb, $4, 'google-etag')`,
    [userId, googleBook.rows[0]!.id, JSON.stringify([{ address: 'duplicate@example.test', primary: true }]), GOOGLE_VCARD],
  );
  calls.discover.mockResolvedValue([{ url: 'https://dav.example/contacts', displayName: 'DAV Contacts' }]);
  calls.cards.mockResolvedValue([{ href: '/dav-1.vcf', etag: 'dav-etag', vcard: DAV_VCARD }]);
});

afterAll(async () => {
  if (!hasPg) return;
  await query('DELETE FROM users WHERE id = $1', [userId]);
  if (originalKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = originalKey;
});

describeOrSkip('unedited contact data remains unchanged', () => {
  it('does not overwrite a Google contact when CardDAV merge sees the same email', async () => {
    const { syncUser } = await import('./carddavSync.js');
    const result = await syncUser(userId);
    expect(result).toMatchObject({ ok: true, contactCount: 1 });

    const original = await query<{ display_name: string; primary_email: string; vcard: string; etag: string }>(
      `SELECT c.display_name, c.primary_email, c.vcard, c.etag
         FROM contacts c JOIN address_books b ON b.id = c.address_book_id
        WHERE c.user_id = $1 AND b.source = 'google'`, [userId],
    );
    expect(original.rows).toEqual([{ display_name: 'Original Google', primary_email: 'duplicate@example.test', vcard: GOOGLE_VCARD, etag: 'google-etag' }]);

    const books = await query<{ source: string; name: string; count: string }>(
      `SELECT b.source, b.name, COUNT(c.id)::text AS count
         FROM address_books b LEFT JOIN contacts c ON c.address_book_id = b.id
        WHERE b.user_id = $1 GROUP BY b.id ORDER BY b.source`, [userId],
    );
    expect(books.rows).toContainEqual({ source: 'carddav', name: 'DAV Contacts', count: '1' });
  });
});
