// CardDAV sync orchestration + scheduler. Pulls contacts from a user's connected
// CardDAV server (provider='carddav' in user_integrations) into per-remote-book,
// read-only local address books. One-way / read-only. Duplicate handling across
// books is chosen by the user: 'separate' | 'merge' | 'skip'.

import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { query, withTransaction } from './db.js';
import { decrypt } from './encryption.js';
import { parseVCard } from '../utils/vcard.js';
import { getConnectionPolicy } from './connectionPolicy.js';
import { discoverAddressBooks, fetchAddressBookCards } from './carddavClient.js';
import { ensureExternalCollectionLink } from './providers/externalCollectionLinks.js';
import { toAppError } from '../utils/errors.js';

const DEFAULT_INTERVAL_MIN = 60;
const timers = new Map();   // userId -> interval id
const syncing = new Set();  // userIds with a sync in flight (prevents overlap)

export async function getCardavConfig(userId: string): Promise<{ serverUrl?: string | null; username?: string | null; password?: string | null; dupMode?: string | null; intervalMin?: number | null; [key: string]: unknown } | null> {
  const r = await query<{ config?: { serverUrl?: string | null; username?: string | null; password?: string | null; dupMode?: string | null; intervalMin?: number | null; [key: string]: unknown } | null }>(
    "SELECT config FROM user_integrations WHERE user_id = $1 AND provider = 'carddav'",
    [userId],
  );
  return r.rows[0]?.config || null;
}

// Shallow-merge a patch into the stored JSONB config.
export async function saveCardavConfig(userId: string, patch: Record<string, unknown>) {
  await query(
    `UPDATE user_integrations SET config = config || $2::jsonb, updated_at = NOW()
     WHERE user_id = $1 AND provider = 'carddav'`,
    [userId, JSON.stringify(patch)],
  );
}

// Find or create the local read-only address book mirroring a remote collection,
// keyed by external_url. Address-book names are unique per user, so on a name
// clash we disambiguate with a suffix.
async function ensureCardavBook(userId: string, book: { url: string; displayName: string }) {
  const existing = await query<{ id: string }>(
    "SELECT id FROM address_books WHERE user_id = $1 AND external_url = $2",
    [userId, book.url],
  );
  if (existing.rows.length) return existing.rows[0].id;

  for (let attempt = 0; attempt < 20; attempt++) {
    const name = attempt === 0 ? book.displayName : `${book.displayName} (${attempt + 1})`;
    try {
      const r = await query<{ id: string }>(
        // A newly connected external address book is not published to DAV devices
        // until the user explicitly enables it (plan §17.1).
        `INSERT INTO address_books (user_id, name, source, external_url, dav_mode)
         VALUES ($1, $2, 'carddav', $3, 'off') RETURNING id`,
        [userId, name, book.url],
      );
      return r.rows[0].id;
    } catch (caught) {
      const err = toAppError(caught);
      if (err.code === '23505') continue; // name taken — try next suffix
      throw err;
    }
  }
  throw new Error(`Could not create a local address book for "${book.displayName}"`);
}

function contactFromVCard(vcard: string, href: string) {
  const c = parseVCard(vcard);
  const uid = c.uid || crypto.createHash('md5').update(href).digest('hex');
  const primaryEmail = c.emails.find(e => e.primary)?.value || c.emails[0]?.value || null;
  return {
    uid,
    displayName: c.displayName || primaryEmail || null,
    firstName: c.firstName, lastName: c.lastName,
    primaryEmail: primaryEmail ? primaryEmail.toLowerCase().trim() : null,
    emails: c.emails, phones: c.phones,
    organization: c.organization, notes: c.notes, birthday: c.birthday, anniversary: c.anniversary, contactDates: c.contactDates, photoData: c.photoData,
    title: c.title, role: c.role, nickname: c.nickname, urls: c.urls,
    instantMessages: c.instantMessages, categories: c.categories, addresses: c.addresses,
    invalidDates: c.invalidDates, invalidDateLabels: c.invalidDateLabels,
    vcard,
  };
}

type CardavContact = ReturnType<typeof contactFromVCard>;
type CardavBook = Awaited<ReturnType<typeof discoverAddressBooks>>[number];
type CardavCredentials = { username: string; password: string; allowPrivate: boolean };

async function upsertCardavContact(client: PoolClient, bookId: string, userId: string, c: CardavContact) {
  const etag = crypto.createHash('md5').update(c.vcard).digest('hex');
  await client.query(`
    INSERT INTO contacts (
      address_book_id, user_id, uid, vcard, etag,
      display_name, first_name, last_name, primary_email,
      emails, phones, organization, notes, birthday, anniversary, contact_dates, photo_data,
      title, role, nickname, urls, instant_messages, categories, addresses, is_auto
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16::jsonb,$17,$18,$19,$20,$21::jsonb,$22::jsonb,$23::jsonb,$24::jsonb,false)
    ON CONFLICT (address_book_id, uid) DO UPDATE SET
      vcard = EXCLUDED.vcard, etag = EXCLUDED.etag,
      display_name = EXCLUDED.display_name, first_name = EXCLUDED.first_name,
      last_name = EXCLUDED.last_name, primary_email = EXCLUDED.primary_email,
      emails = EXCLUDED.emails, phones = EXCLUDED.phones,
      organization = EXCLUDED.organization, notes = EXCLUDED.notes,
      birthday = EXCLUDED.birthday, anniversary = EXCLUDED.anniversary,
      contact_dates = EXCLUDED.contact_dates,
      title = EXCLUDED.title, role = EXCLUDED.role, nickname = EXCLUDED.nickname,
      urls = EXCLUDED.urls, instant_messages = EXCLUDED.instant_messages,
      categories = EXCLUDED.categories, addresses = EXCLUDED.addresses,
      photo_data = EXCLUDED.photo_data, updated_at = NOW()
  `, [
    bookId, userId, c.uid, c.vcard, etag,
    c.displayName, c.firstName, c.lastName, c.primaryEmail,
    JSON.stringify(c.emails), JSON.stringify(c.phones),
    c.organization, c.notes, c.birthday, c.anniversary, JSON.stringify(c.contactDates), c.photoData,
    c.title, c.role, c.nickname, JSON.stringify(c.urls), JSON.stringify(c.instantMessages), JSON.stringify(c.categories), JSON.stringify(c.addresses),
  ]);
}

// Enrich an existing contact (in another book) with the vCard's descriptive
// fields. We deliberately leave primary_email/emails untouched to avoid churning
// that book's per-book email-uniqueness index.
async function mergeIntoExisting(client: PoolClient, id: string, c: CardavContact) {
  const etag = crypto.createHash('md5').update(c.vcard).digest('hex');
  await client.query(`
    UPDATE contacts SET
      display_name = $2, first_name = $3, last_name = $4,
      phones = $5::jsonb, organization = $6, notes = $7, birthday = $8, anniversary = $9,
      contact_dates = $10::jsonb, photo_data = COALESCE($11, photo_data), title = $12, role = $13, nickname = $14,
      urls = $15::jsonb, instant_messages = $16::jsonb, categories = $17::jsonb, addresses = $18::jsonb,
      vcard = $19, etag = $20, updated_at = NOW()
    WHERE id = $1
  `, [id, c.displayName, c.firstName, c.lastName, JSON.stringify(c.phones),
      c.organization, c.notes, c.birthday, c.anniversary, JSON.stringify(c.contactDates), c.photoData, c.title, c.role, c.nickname,
      JSON.stringify(c.urls), JSON.stringify(c.instantMessages), JSON.stringify(c.categories), JSON.stringify(c.addresses), c.vcard, etag]);
}

async function syncBook(userId: string, book: CardavBook, dupMode: string, creds: CardavCredentials) {
  const rawCards = await fetchAddressBookCards({ ...book, ...creds });
  const cards = rawCards.map(rc => contactFromVCard(rc.vcard, rc.href));
  if (cards.some(card => card.invalidDates.length || card.invalidDateLabels.length)) {
    throw new Error('Remote CardDAV vCard contains an invalid contact date');
  }
  const bookId = await ensureCardavBook(userId, book);
  // Link the collection to its source connection so the per-collection write-back switch has something to
  // enable (P02's backfill, P10's reachability). Not this sync's purpose: a failure is reported and the
  // contacts still import, because losing them would be worse than a link that is retried next pass.
  try {
    await ensureExternalCollectionLink({
      userId,
      kind: 'carddav',
      url: book.url,
      remoteId: book.url,
      label: book.displayName ?? null,
      localAddressBookId: bookId,
    });
  } catch (caught) {
    console.warn('Linking an external address book to its source connection failed:', toAppError(caught).message);
  }

  // Emails present in the user's OTHER books, for cross-book duplicate handling.
  const otherEmail = new Map<string, string>(); // email -> existing contact id
  if (dupMode !== 'separate') {
    const rows = await query<{ primary_email: string; id: string }>(
      `SELECT id, primary_email FROM contacts
       WHERE user_id = $1 AND address_book_id <> $2 AND primary_email IS NOT NULL`,
      [userId, bookId],
    );
    for (const r of rows.rows) otherEmail.set(r.primary_email.toLowerCase(), r.id);
  }

  // Classify first (no writes) so we know the final set before touching the DB.
  const seenInBook = new Set<string>();
  const toUpsert: CardavContact[] = [];
  const toMerge: Array<{ id: string; contact: CardavContact }> = []; // { id, contact }
  for (const c of cards) {
    // Avoid violating this book's (address_book_id, primary_email) uniqueness when
    // two cards in the same book share an email — keep the email on the first only.
    if (c.primaryEmail && seenInBook.has(c.primaryEmail)) c.primaryEmail = null;
    else if (c.primaryEmail) seenInBook.add(c.primaryEmail);

    if (c.primaryEmail && dupMode !== 'separate' && otherEmail.has(c.primaryEmail)) {
      if (dupMode === 'skip') continue;
      if (dupMode === 'merge') {
        const existingId = otherEmail.get(c.primaryEmail);
        if (existingId) { toMerge.push({ id: existingId, contact: c }); continue; }
      }
    }
    toUpsert.push(c);
  }

  const presentUids = toUpsert.map(c => c.uid);
  // DAV-04: the whole pull is applied in **one transaction**. The delete of rows the snapshot no longer lists
  // must happen before the upserts (a uid or email freed this round cannot then collide with an incoming card),
  // but it must not be visible without them either: a failure halfway used to leave the book missing rows until
  // the next successful pass. Delete, upsert, merge and the token now commit together or not at all.
  await withTransaction(async client => {
    await client.query(
      `DELETE FROM contacts WHERE address_book_id = $1 AND uid <> ALL($2::text[])`,
      [bookId, presentUids.length ? presentUids : ['']],
    );
    for (const c of toUpsert) await upsertCardavContact(client, bookId, userId, c);
    for (const m of toMerge) await mergeIntoExisting(client, m.id, m.contact);

    await client.query(
      "UPDATE address_books SET sync_token = gen_random_uuid()::text, updated_at = NOW() WHERE id = $1",
      [bookId],
    );
  });
  return { bookId, count: presentUids.length };
}

export async function syncUser(userId: string) {
  const config = await getCardavConfig(userId);
  if (!config?.serverUrl) return { ok: false, error: 'not connected' };
  if (syncing.has(userId)) return { ok: false, error: 'A sync is already in progress' };
  syncing.add(userId);
  try {
    const policy = await getConnectionPolicy();
    if (typeof config.username !== 'string') throw new Error('CardDAV username is missing');
    const decryptedPassword: unknown = decrypt(config.password);
    if (typeof decryptedPassword !== 'string') throw new Error('CardDAV password could not be decrypted');
    const creds: CardavCredentials = { username: config.username, password: decryptedPassword, allowPrivate: policy.allowPrivateHosts };
    const books = await discoverAddressBooks({ serverUrl: config.serverUrl, ...creds });
    let contactCount = 0;
    const seenUrls = [];
    for (const book of books) {
      const { count } = await syncBook(userId, book, config.dupMode || 'separate', creds);
      contactCount += count;
      seenUrls.push(book.url);
    }
    // Prune local CardDAV books whose remote collection disappeared (cascades to contacts).
    await query(
      `DELETE FROM address_books
       WHERE user_id = $1 AND source = 'carddav' AND external_url <> ALL($2::text[])`,
      [userId, seenUrls.length ? seenUrls : ['']],
    );
    await saveCardavConfig(userId, {
      lastSyncAt: new Date().toISOString(),
      lastError: null, bookCount: books.length, contactCount,
    });
    return { ok: true, bookCount: books.length, contactCount };
  } catch (caught) {
    const err = toAppError(caught);
    await saveCardavConfig(userId, { lastError: err.message, lastSyncAt: new Date().toISOString() });
    return { ok: false, error: err.message };
  } finally {
    syncing.delete(userId);
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

export function scheduleCardavUser(userId: string, intervalMin: string | number | null | undefined) {
  stopCardavUser(userId);
  const min = Math.max(15, Math.min(1440, parseInt(String(intervalMin ?? ''), 10) || DEFAULT_INTERVAL_MIN));
  const id = setInterval(() => {
    syncUser(userId).catch(e => console.warn(`CardDAV sync failed for ${userId}:`, e.message));
  }, min * 60 * 1000);
  timers.set(userId, id);
}

export function stopCardavUser(userId: string) {
  const id = timers.get(userId);
  if (id) { clearInterval(id); timers.delete(userId); }
}

export async function startCardavScheduler() {
  try {
    const rows = await query<{ user_id: string; config?: { serverUrl?: string | null; intervalMin?: number | null } | null }>("SELECT user_id, config FROM user_integrations WHERE provider = 'carddav'");
    for (const row of rows.rows) {
      if (row.config?.serverUrl) scheduleCardavUser(row.user_id, row.config?.intervalMin);
    }
    if (rows.rows.length) console.log(`CardDAV: scheduled sync for ${rows.rows.length} account(s)`);
  } catch (caught) {
    const err = toAppError(caught);
    console.warn('CardDAV scheduler start failed:', err.message);
  }
}
