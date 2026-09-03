// CardDAV sync orchestration + scheduler. Pulls contacts from a user's connected
// CardDAV server (provider='carddav' in user_integrations) into per-remote-book,
// read-only local address books. One-way / read-only. Duplicate handling across
// books is chosen by the user: 'separate' | 'merge' | 'skip'.

import crypto from 'crypto';
import { query } from './db.js';
import { decrypt } from './encryption.js';
import { parseVCard } from '../utils/vcard.js';
import { getConnectionPolicy } from './connectionPolicy.js';
import { discoverAddressBooks, fetchAddressBookCards } from './carddavClient.js';

const DEFAULT_INTERVAL_MIN = 60;
const timers = new Map();   // userId -> interval id
const syncing = new Set();  // userIds with a sync in flight (prevents overlap)

export async function getCardavConfig(userId) {
  const r = await query(
    "SELECT config FROM user_integrations WHERE user_id = $1 AND provider = 'carddav'",
    [userId],
  );
  return r.rows[0]?.config || null;
}

// Shallow-merge a patch into the stored JSONB config.
export async function saveCardavConfig(userId, patch) {
  await query(
    `UPDATE user_integrations SET config = config || $2::jsonb, updated_at = NOW()
     WHERE user_id = $1 AND provider = 'carddav'`,
    [userId, JSON.stringify(patch)],
  );
}

// Find or create the local read-only address book mirroring a remote collection,
// keyed by external_url. Address-book names are unique per user, so on a name
// clash we disambiguate with a suffix.
async function ensureCardavBook(userId, book) {
  const existing = await query(
    "SELECT id FROM address_books WHERE user_id = $1 AND external_url = $2",
    [userId, book.url],
  );
  if (existing.rows.length) return existing.rows[0].id;

  for (let attempt = 0; attempt < 20; attempt++) {
    const name = attempt === 0 ? book.displayName : `${book.displayName} (${attempt + 1})`;
    try {
      const r = await query(
        `INSERT INTO address_books (user_id, name, source, external_url)
         VALUES ($1, $2, 'carddav', $3) RETURNING id`,
        [userId, name, book.url],
      );
      return r.rows[0].id;
    } catch (err) {
      if (err.code === '23505') continue; // name taken — try next suffix
      throw err;
    }
  }
  throw new Error(`Could not create a local address book for "${book.displayName}"`);
}

function contactFromVCard(vcard, href) {
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
    invalidDateLabels: c.invalidDateLabels,
    vcard,
  };
}

async function upsertCardavContact(bookId, userId, c) {
  const etag = crypto.createHash('md5').update(c.vcard).digest('hex');
  await query(`
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
async function mergeIntoExisting(id, c) {
  const etag = crypto.createHash('md5').update(c.vcard).digest('hex');
  await query(`
    UPDATE contacts SET
      display_name = $2, first_name = $3, last_name = $4,
      phones = $5::jsonb, organization = $6, notes = $7, birthday = $8, anniversary = $9,
      photo_data = COALESCE($10, photo_data), title = $11, role = $12, nickname = $13,
      urls = $14::jsonb, instant_messages = $15::jsonb, categories = $16::jsonb, addresses = $17::jsonb,
      vcard = $18, etag = $19, updated_at = NOW()
    WHERE id = $1
  `, [id, c.displayName, c.firstName, c.lastName, JSON.stringify(c.phones),
      c.organization, c.notes, c.birthday, c.anniversary, c.photoData, c.title, c.role, c.nickname,
      JSON.stringify(c.urls), JSON.stringify(c.instantMessages), JSON.stringify(c.categories), JSON.stringify(c.addresses), c.vcard, etag]);
}

async function syncBook(userId, book, dupMode, creds) {
  const rawCards = await fetchAddressBookCards({ ...book, ...creds });
  const cards = rawCards.map(rc => contactFromVCard(rc.vcard, rc.href));
  if (cards.some(card => card.invalidDateLabels.length)) {
    throw new Error('Remote CardDAV vCard contains an unsafe contact-date label');
  }
  const bookId = await ensureCardavBook(userId, book);

  // Emails present in the user's OTHER books, for cross-book duplicate handling.
  const otherEmail = new Map(); // email -> existing contact id
  if (dupMode !== 'separate') {
    const rows = await query(
      `SELECT id, primary_email FROM contacts
       WHERE user_id = $1 AND address_book_id <> $2 AND primary_email IS NOT NULL`,
      [userId, bookId],
    );
    for (const r of rows.rows) otherEmail.set(r.primary_email.toLowerCase(), r.id);
  }

  // Classify first (no writes) so we know the final set before touching the DB.
  const seenInBook = new Set();
  const toUpsert = [];
  const toMerge = []; // { id, contact }
  for (const c of cards) {
    // Avoid violating this book's (address_book_id, primary_email) uniqueness when
    // two cards in the same book share an email — keep the email on the first only.
    if (c.primaryEmail && seenInBook.has(c.primaryEmail)) c.primaryEmail = null;
    else if (c.primaryEmail) seenInBook.add(c.primaryEmail);

    if (c.primaryEmail && dupMode !== 'separate' && otherEmail.has(c.primaryEmail)) {
      if (dupMode === 'skip') continue;
      if (dupMode === 'merge') { toMerge.push({ id: otherEmail.get(c.primaryEmail), contact: c }); continue; }
    }
    toUpsert.push(c);
  }

  const presentUids = toUpsert.map(c => c.uid);
  // Delete stale rows BEFORE upserting so a uid/email freed this round can't collide
  // with an incoming card (e.g. an email moving to a newly-created contact).
  await query(
    `DELETE FROM contacts WHERE address_book_id = $1 AND uid <> ALL($2::text[])`,
    [bookId, presentUids.length ? presentUids : ['']],
  );
  for (const c of toUpsert) await upsertCardavContact(bookId, userId, c);
  for (const m of toMerge) await mergeIntoExisting(m.id, m.contact);

  await query(
    "UPDATE address_books SET sync_token = gen_random_uuid()::text, updated_at = NOW() WHERE id = $1",
    [bookId],
  );
  return { bookId, count: presentUids.length };
}

export async function syncUser(userId) {
  const config = await getCardavConfig(userId);
  if (!config?.serverUrl) return { ok: false, error: 'not connected' };
  if (syncing.has(userId)) return { ok: false, error: 'A sync is already in progress' };
  syncing.add(userId);
  const policy = await getConnectionPolicy();
  const allowPrivate = policy.allowPrivateHosts;
  const creds = { username: config.username, password: decrypt(config.password), allowPrivate };

  try {
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
  } catch (err) {
    await saveCardavConfig(userId, { lastError: err.message, lastSyncAt: new Date().toISOString() });
    return { ok: false, error: err.message };
  } finally {
    syncing.delete(userId);
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

export function scheduleCardavUser(userId, intervalMin) {
  stopCardavUser(userId);
  const min = Math.max(15, Math.min(1440, parseInt(intervalMin) || DEFAULT_INTERVAL_MIN));
  const id = setInterval(() => {
    syncUser(userId).catch(e => console.warn(`CardDAV sync failed for ${userId}:`, e.message));
  }, min * 60 * 1000);
  timers.set(userId, id);
}

export function stopCardavUser(userId) {
  const id = timers.get(userId);
  if (id) { clearInterval(id); timers.delete(userId); }
}

export async function startCardavScheduler() {
  try {
    const rows = await query("SELECT user_id, config FROM user_integrations WHERE provider = 'carddav'");
    for (const row of rows.rows) {
      if (row.config?.serverUrl) scheduleCardavUser(row.user_id, row.config?.intervalMin);
    }
    if (rows.rows.length) console.log(`CardDAV: scheduled sync for ${rows.rows.length} account(s)`);
  } catch (err) {
    console.warn('CardDAV scheduler start failed:', err.message);
  }
}
