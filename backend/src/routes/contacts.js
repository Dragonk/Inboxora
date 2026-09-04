import { Router } from 'express';
import { query, withTransaction } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { generateVCard, mergeVCard, normalizeContactDateLabel } from '../utils/vcard.js';
import { chooseDefined, normalizeRichContactFields } from '../utils/contactFields.js';
import { safeFetch } from '../services/safeFetch.js';
import { contactsToGoogleCsv, contactsToOutlookCsv, contactsToVCard, parseGoogleCsv } from '../utils/contactTransfer.js';
import crypto from 'crypto';

const router = Router();
router.use(requireAuth);

function normalizeContactDate(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? value : undefined;
}

function normalizeContactDates(value) {
  if (!Array.isArray(value)) return undefined;
  const dates = [];
  const seen = new Set();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || typeof entry.label !== 'string') return undefined;
    const label = normalizeContactDateLabel(entry.label);
    const date = normalizeContactDate(entry.value);
    if (!label || !date) return undefined;
    const key = `${label.toLocaleLowerCase()}\\u0000${date}`;
    if (!seen.has(key)) { seen.add(key); dates.push({ label, value: date }); }
  }
  return dates;
}

function contactDatesWithLegacy(contactDates, birthday, anniversary, authoritative = false) {
  const dates = (Array.isArray(contactDates) ? contactDates : [])
    .filter(({ label }) => authoritative || !['birthday', 'anniversary'].includes(label.toLocaleLowerCase()))
    .map(({ label, value }) => ({ label, value }));
  if (authoritative) return dates;
  const seen = new Set(dates.map(({ label, value }) => `${label.toLocaleLowerCase()}\\u0000${value}`));
  for (const [label, value] of [['Birthday', birthday], ['Anniversary', anniversary]]) {
    if (value && !seen.has(`${label.toLocaleLowerCase()}\\u0000${value}`)) dates.push({ label, value });
  }
  return dates;
}

function legacyDatesFromContactDates(contactDates) {
  const values = { birthday: null, anniversary: null };
  for (const { label, value } of contactDates) {
    const field = label.toLocaleLowerCase();
    if (field === 'birthday' && values.birthday === null) values.birthday = value;
    if (field === 'anniversary' && values.anniversary === null) values.anniversary = value;
  }
  return values;
}

// In-memory cache for Gravatar lookups (hash -> { buf, type } hit or { miss:true }).
// Bounded + TTL'd so we don't re-hit Gravatar for every list render and so the number of
// third-party requests stays minimal (a privacy consideration — see the /gravatar route).
const gravatarCache = new Map();
const GRAVATAR_TTL_MS      = 24 * 60 * 60 * 1000; // hits: 24h
const GRAVATAR_MISS_TTL_MS =  6 * 60 * 60 * 1000; // 404s: 6h
const GRAVATAR_MAX_ENTRIES = 2000;
function gravatarCacheSet(hash, entry) {
  if (gravatarCache.size >= GRAVATAR_MAX_ENTRIES) {
    const oldest = gravatarCache.keys().next().value;
    if (oldest !== undefined) gravatarCache.delete(oldest);
  }
  gravatarCache.set(hash, entry);
}

// Resolve the user's default address book id, creating it if needed.
async function defaultAddressBook(userId) {
  const r = await query(
    `INSERT INTO address_books (user_id, name)
     VALUES ($1, 'Personal')
     ON CONFLICT (user_id, name) DO UPDATE SET updated_at = NOW()
     RETURNING id`,
    [userId]
  );
  return r.rows[0].id;
}

// Bump the address book sync_token so CardDAV clients re-sync.
async function bumpSyncToken(addressBookId) {
  await query(
    `UPDATE address_books SET sync_token = gen_random_uuid()::text, updated_at = NOW()
     WHERE id = $1`,
    [addressBookId]
  );
}

function localBookName(value) {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  return name.length >= 1 && name.length <= 120 ? name : null;
}

async function requireLocalAddressBook(userId, addressBookId) {
  const result = await query('SELECT id, name, source, visible FROM address_books WHERE id = $1 AND user_id = $2', [addressBookId, userId]);
  const book = result.rows[0];
  if (!book) return { error: 'Address book not found', status: 404 };
  if (book.source !== 'local') return { error: 'This address book is read-only', status: 403 };
  return { book };
}

router.get('/address-books', async (req, res) => {
  try {
    const result = await query(`SELECT ab.id, ab.name, ab.source, ab.visible, COUNT(c.id)::int AS contact_count FROM address_books ab LEFT JOIN contacts c ON c.address_book_id = ab.id WHERE ab.user_id = $1 GROUP BY ab.id ORDER BY ab.created_at ASC`, [req.session.userId]);
    res.json({ addressBooks: result.rows });
  } catch (err) { console.error('Address book list error:', err); res.status(500).json({ error: 'Failed to fetch address books' }); }
});

router.post('/address-books', async (req, res) => {
  const name = localBookName(req.body?.name);
  if (!name) return res.status(400).json({ error: 'Address book name must be 1 to 120 characters' });
  try {
    const result = await query(`INSERT INTO address_books (user_id, name, source, visible) VALUES ($1, $2, 'local', true) RETURNING id, name, source, visible`, [req.session.userId, name]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'An address book with that name already exists' });
    console.error('Address book create error:', err); res.status(500).json({ error: 'Failed to create address book' });
  }
});

router.patch('/address-books/:id', async (req, res) => {
  const { name: rawName, visible } = req.body || {};
  if (rawName !== undefined && !localBookName(rawName)) return res.status(400).json({ error: 'Address book name must be 1 to 120 characters' });
  if (visible !== undefined && typeof visible !== 'boolean') return res.status(400).json({ error: 'visible must be a boolean' });
  if (rawName === undefined && visible === undefined) return res.status(400).json({ error: 'No address book changes supplied' });
  try {
    const local = await requireLocalAddressBook(req.session.userId, req.params.id);
    if (local.error) return res.status(local.status).json({ error: local.error });
    const result = await query(`UPDATE address_books SET name = COALESCE($1, name), visible = COALESCE($2, visible), updated_at = NOW() WHERE id = $3 AND user_id = $4 RETURNING id, name, source, visible`, [rawName === undefined ? null : localBookName(rawName), visible === undefined ? null : visible, req.params.id, req.session.userId]);
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'An address book with that name already exists' });
    console.error('Address book update error:', err); res.status(500).json({ error: 'Failed to update address book' });
  }
});

router.delete('/address-books/:id', async (req, res) => {
  try {
    const local = await requireLocalAddressBook(req.session.userId, req.params.id);
    if (local.error) return res.status(local.status).json({ error: local.error });
    const count = await query(`SELECT COUNT(*)::int AS count FROM address_books WHERE user_id = $1 AND source = 'local'`, [req.session.userId]);
    if (count.rows[0].count <= 1) return res.status(409).json({ error: 'At least one local address book is required' });
    await query('DELETE FROM address_books WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
    res.status(204).end();
  } catch (err) { console.error('Address book delete error:', err); res.status(500).json({ error: 'Failed to delete address book' }); }
});

// GET /api/contacts
// Query params: q (search), limit, offset, is_auto (true|false|'')
router.get('/', async (req, res) => {
  const { q, limit = 50, offset = 0, is_auto, addressBookId } = req.query;
  const userId = req.session.userId;
  const cap = Math.min(parseInt(limit) || 50, 500);
  const off = Math.max(0, parseInt(offset) || 0);

  const conditions = ['c.user_id = $1'];
  const params = [userId];
  let p = 2;

  if (q && q.trim()) {
    params.push(`%${q.trim()}%`);
    conditions.push(`(
      c.display_name ILIKE $${p}
      OR c.primary_email ILIKE $${p}
      OR c.organization ILIKE $${p}
      OR (jsonb_typeof(c.emails) = 'array' AND EXISTS (SELECT 1 FROM jsonb_array_elements(c.emails) ae WHERE ae->>'value' ILIKE $${p}))
      OR (jsonb_typeof(c.phones) = 'array' AND EXISTS (SELECT 1 FROM jsonb_array_elements(c.phones) ap WHERE ap->>'value' ILIKE $${p}))
    )`);
    p++;
  }

  if (is_auto === 'true') {
    conditions.push('c.is_auto = true');
  } else if (is_auto === 'false') {
    conditions.push('c.is_auto = false');
  }

  if (addressBookId) {
    params.push(addressBookId);
    conditions.push(`c.address_book_id = $${p++}`);
  } else {
    conditions.push('ab.visible = true');
  }

  try {
    const result = await query(`
      SELECT
        c.id, c.uid, c.display_name, c.first_name, c.last_name,
        c.primary_email, c.emails, c.phones, c.organization,
        c.notes, c.birthday, c.anniversary, c.contact_dates AS "contactDates", c.title, c.role, c.nickname,
        c.urls, c.addresses, c.instant_messages AS "instantMessages", c.categories,
        c.address_book_id, ab.name AS address_book_name, c.is_auto, c.send_count, c.last_sent,
        c.etag, c.created_at, c.updated_at,
        (c.photo_data IS NOT NULL) AS has_contact_photo,
        (ab.source = 'carddav') AS read_only
      FROM contacts c
      JOIN address_books ab ON ab.id = c.address_book_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY
        c.is_auto ASC,
        c.send_count DESC,
        lower(coalesce(c.display_name, c.primary_email, '')) ASC
      LIMIT $${p} OFFSET $${p + 1}
    `, [...params, cap, off]);

    const total = await query(
      `SELECT COUNT(*) FROM contacts c JOIN address_books ab ON ab.id = c.address_book_id WHERE ${conditions.join(' AND ')}`,
      params
    );

    res.json({ contacts: result.rows, total: parseInt(total.rows[0].count) });
  } catch (err) {
    console.error('Contacts list error:', err);
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
});

// GET /api/contacts/photo?email=:email
// Returns the contact photo for the given sender email as image bytes.
// This route must remain ABOVE /:id to prevent Express matching "photo" as an id.
router.get('/photo', async (req, res) => {
  const { email } = req.query;
  const userId = req.session.userId;

  if (!email || typeof email !== 'string') return res.status(400).end();

  try {
    const result = await query(
      `SELECT photo_data FROM contacts
       WHERE user_id = $1 AND primary_email = lower($2) AND photo_data IS NOT NULL
       LIMIT 1`,
      [userId, email.trim()]
    );

    if (!result.rows.length) return res.status(404).end();

    const photoData = result.rows[0].photo_data;
    res.set('Cache-Control', 'private, max-age=86400');

    if (photoData.startsWith('data:')) {
      const commaIdx = photoData.indexOf(',');
      if (commaIdx < 0) return res.status(404).end();
      const mimeMatch = photoData.slice(0, commaIdx).match(/data:([^;]+)/);
      const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
      res.set('Content-Type', mimeType);
      return res.send(Buffer.from(photoData.slice(commaIdx + 1), 'base64'));
    }

    // Fallback: treat as raw base64 JPEG (shouldn't occur after vcard.js fix).
    res.set('Content-Type', 'image/jpeg');
    return res.send(Buffer.from(photoData, 'base64'));
  } catch (err) {
    console.error('Contact photo error:', err);
    res.status(500).end();
  }
});

// GET /api/contacts/gravatar?email=:email
// Server-side proxy for Gravatar sender avatars (#213). OPT-IN only — the frontend never
// calls this unless the user turns on the "Gravatar avatars" preference. Proxied (rather
// than hit directly from the browser) so the user's IP is never exposed to Gravatar, and
// cached so repeated list renders don't fan out third-party requests. Privacy note: even so,
// this server reveals the hashed sender address to Gravatar (Automattic) for each miss —
// that is inherent to the feature and disclosed in the settings toggle.
// Must remain ABOVE /:id (like /photo) so Express doesn't match "gravatar" as an id.
router.get('/gravatar', async (req, res) => {
  const email = typeof req.query.email === 'string' ? req.query.email.trim().toLowerCase() : '';
  // Basic RFC-ish shape check; also bounds the input before hashing / logging.
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).end();
  }
  const hash = crypto.createHash('sha256').update(email).digest('hex');
  const now = Date.now();

  const cached = gravatarCache.get(hash);
  if (cached && cached.expires > now) {
    if (cached.miss) return res.status(404).end();
    res.set('Cache-Control', 'private, max-age=86400');
    res.set('Content-Type', cached.type);
    return res.send(cached.buf);
  }

  try {
    // Host is fixed (only the hex hash varies) so there is no SSRF surface; safeFetch still
    // pins to the resolved public IP and blocks private ranges. d=404 → Gravatar returns 404
    // when the address has no avatar, so the client falls back to initials.
    const url = `https://www.gravatar.com/avatar/${hash}?d=404&s=80&r=g`;
    const resp = await safeFetch(url, {
      signal: AbortSignal.timeout(6000),
      headers: { 'User-Agent': 'Inboxora/3.4.0' },
    });
    if (resp.status === 404) {
      gravatarCacheSet(hash, { miss: true, expires: now + GRAVATAR_MISS_TTL_MS });
      return res.status(404).end();
    }
    const type = resp.headers.get('content-type') || '';
    if (!resp.ok || !type.startsWith('image/')) return res.status(502).end();
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length === 0 || buf.length > 512 * 1024) return res.status(502).end();
    gravatarCacheSet(hash, { buf, type, expires: now + GRAVATAR_TTL_MS });
    res.set('Cache-Control', 'private, max-age=86400');
    res.set('Content-Type', type);
    return res.send(buf);
  } catch {
    return res.status(502).end();
  }
});

router.get('/address-books/:id/export', async (req, res) => {
  const format = req.query.format;
  if (!['google-csv', 'outlook-csv', 'vcard'].includes(format)) return res.status(400).json({ error: 'Unsupported export format' });
  try {
    const book = await query('SELECT id, name FROM address_books WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
    if (!book.rows.length) return res.status(404).json({ error: 'Address book not found' });
    const contacts = await query(`SELECT uid, display_name, first_name, last_name, emails, phones, organization, title, notes FROM contacts WHERE address_book_id = $1 ORDER BY lower(coalesce(display_name, primary_email, ''))`, [book.rows[0].id]);
    const filename = `${book.rows[0].name.replace(/[^a-z0-9_-]+/gi, '-') || 'contacts'}`;
    if (format === 'vcard') {
      res.type('text/vcard').attachment(`${filename}.vcf`).send(contactsToVCard(contacts.rows));
    } else {
      const content = format === 'google-csv' ? contactsToGoogleCsv(contacts.rows) : contactsToOutlookCsv(contacts.rows);
      res.type('text/csv').attachment(`${filename}-${format}.csv`).send(content);
    }
  } catch (err) { console.error('Address book export error:', err); res.status(500).json({ error: 'Failed to export address book' }); }
});

router.post('/address-books/:id/import/google-csv', async (req, res) => {
  const csv = typeof req.body?.csv === 'string' ? req.body.csv : '';
  if (!csv || csv.length > 900_000) return res.status(400).json({ error: 'Google CSV must be a non-empty file smaller than 900 KB' });
  try {
    const local = await requireLocalAddressBook(req.session.userId, req.params.id);
    if (local.error) return res.status(local.status).json({ error: local.error });
    const contacts = parseGoogleCsv(csv);
    if (!contacts.length) return res.status(400).json({ error: 'No contacts found in Google CSV' });
    await withTransaction(async client => {
      for (const contact of contacts) {
        const uid = crypto.randomUUID();
        const vcard = generateVCard({ uid, ...contact });
        const etag = crypto.createHash('md5').update(vcard).digest('hex');
        await client.query(`INSERT INTO contacts (address_book_id, user_id, uid, vcard, etag, display_name, first_name, last_name, primary_email, emails, phones, organization, notes, birthday, anniversary, contact_dates, title, role, nickname, urls, categories, addresses, google_fields, is_auto) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,$19,$20::jsonb,$21::jsonb,$22::jsonb,$23::jsonb,false) ON CONFLICT (address_book_id, primary_email) WHERE primary_email IS NOT NULL DO UPDATE SET vcard = EXCLUDED.vcard, etag = EXCLUDED.etag, display_name = EXCLUDED.display_name, first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name, emails = EXCLUDED.emails, phones = EXCLUDED.phones, organization = EXCLUDED.organization, notes = EXCLUDED.notes, birthday = EXCLUDED.birthday, anniversary = EXCLUDED.anniversary, contact_dates = EXCLUDED.contact_dates, title = EXCLUDED.title, role = EXCLUDED.role, nickname = EXCLUDED.nickname, urls = EXCLUDED.urls, categories = EXCLUDED.categories, addresses = EXCLUDED.addresses, google_fields = EXCLUDED.google_fields, is_auto = false, updated_at = NOW()`, [local.book.id, req.session.userId, uid, vcard, etag, contact.displayName || null, contact.firstName || null, contact.lastName || null, contact.emails[0]?.value || null, JSON.stringify(contact.emails), JSON.stringify(contact.phones), contact.organization || null, contact.notes || null, contact.birthday || null, contact.anniversary || null, JSON.stringify(contact.contactDates || []), contact.title || null, contact.role || null, contact.nickname || null, JSON.stringify(contact.urls || []), JSON.stringify(contact.categories || []), JSON.stringify(contact.addresses || []), JSON.stringify(contact.sourceFields || {})]);
      }
    });
    await bumpSyncToken(local.book.id);
    res.status(201).json({ imported: contacts.length });
  } catch (err) { console.error('Google CSV import error:', err); res.status(500).json({ error: 'Failed to import Google CSV' }); }
});

// GET /api/contacts/:id
router.get('/:id', async (req, res) => {
  const userId = req.session.userId;
  try {
    const result = await query(
      `SELECT c.id, c.uid, c.display_name, c.first_name, c.last_name,
              c.primary_email, c.emails, c.phones, c.organization,
              c.notes, c.birthday, c.anniversary, c.contact_dates AS "contactDates", c.title, c.role, c.nickname,
              c.urls, c.addresses, c.instant_messages AS "instantMessages", c.categories,
              c.google_fields AS "googleFields",
              c.photo_data, c.is_auto, c.send_count, c.last_sent,
              c.etag, c.vcard, c.created_at, c.updated_at,
              (ab.source = 'carddav') AS read_only
       FROM contacts c
       JOIN address_books ab ON ab.id = c.address_book_id
       WHERE c.id = $1 AND c.user_id = $2`,
      [req.params.id, userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Contact not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Contact get error:', err);
    res.status(500).json({ error: 'Failed to fetch contact' });
  }
});

// POST /api/contacts
router.post('/', async (req, res) => {
  const userId = req.session.userId;
  const {
    displayName, firstName, lastName,
    emails = [], phones = [],
    organization, notes, birthday, anniversary, contactDates,
    title, role, nickname, urls = [], instantMessages = [], categories = [], addresses = [], addressBookId: requestedAddressBookId,
  } = req.body || {};

  if (!Array.isArray(emails)) return res.status(400).json({ error: 'emails must be an array' });
  if (!Array.isArray(phones)) return res.status(400).json({ error: 'phones must be an array' });
  const rich = normalizeRichContactFields({ title, role, nickname, urls, instantMessages, categories, addresses });
  if (!rich) return res.status(400).json({ error: 'Rich contact fields are malformed' });
  const normalizedBirthday = normalizeContactDate(birthday); const normalizedAnniversary = normalizeContactDate(anniversary);
  if (normalizedBirthday === undefined || normalizedAnniversary === undefined) return res.status(400).json({ error: 'Contact dates must use YYYY-MM-DD' });
  const normalizedContactDates = normalizeContactDates(contactDates ?? []);
  if (normalizedContactDates === undefined) return res.status(400).json({ error: 'contactDates must be an array of safe labelled YYYY-MM-DD dates' });
  const storedContactDates = contactDatesWithLegacy(
    normalizedContactDates, normalizedBirthday, normalizedAnniversary, contactDates !== undefined
  );
  const authoritativeLegacyDates = contactDates === undefined ? null : legacyDatesFromContactDates(storedContactDates);
  const storedBirthday = authoritativeLegacyDates?.birthday ?? (contactDates === undefined ? normalizedBirthday : null);
  const storedAnniversary = authoritativeLegacyDates?.anniversary ?? (contactDates === undefined ? normalizedAnniversary : null);

  const primaryEmail = emails[0]?.value
    ? emails[0].value.toLowerCase().trim()
    : null;

  if (!displayName && !primaryEmail) {
    return res.status(400).json({ error: 'A name or email address is required' });
  }

  try {
    const addressBookId = requestedAddressBookId || await defaultAddressBook(userId);
    if (requestedAddressBookId) {
      const local = await requireLocalAddressBook(userId, requestedAddressBookId);
      if (local.error) return res.status(local.status).json({ error: local.error });
    }
    const uid = crypto.randomUUID();
    const vcard = generateVCard({ uid, displayName, firstName, lastName, emails, phones, organization, notes, birthday: storedBirthday, anniversary: storedAnniversary, contactDates: storedContactDates, ...rich });
    const etag = crypto.createHash('md5').update(vcard).digest('hex');

    const result = await query(`
      INSERT INTO contacts (
        address_book_id, user_id, uid, vcard, etag,
        display_name, first_name, last_name, primary_email,
        emails, phones, organization, notes, birthday, anniversary, contact_dates,
        title, role, nickname, urls, instant_messages, categories, addresses, is_auto
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19,$20,$21,$22,$23, false)
      RETURNING id, uid, display_name, first_name, last_name,
                primary_email, emails, phones, organization, notes, birthday, anniversary, contact_dates AS "contactDates",
                title, role, nickname, urls, addresses, instant_messages AS "instantMessages", categories,
                is_auto, send_count, last_sent, etag, created_at, updated_at
    `, [
      addressBookId, userId, uid, vcard, etag,
      displayName || null, firstName || null, lastName || null, primaryEmail,
      JSON.stringify(emails), JSON.stringify(phones),
      organization || null, notes || null, storedBirthday, storedAnniversary, JSON.stringify(storedContactDates),
      rich.title, rich.role, rich.nickname, JSON.stringify(rich.urls), JSON.stringify(rich.instantMessages), JSON.stringify(rich.categories), JSON.stringify(rich.addresses),
    ]);

    await bumpSyncToken(addressBookId);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A contact with that email already exists' });
    console.error('Contact create error:', err);
    res.status(500).json({ error: 'Failed to create contact' });
  }
});

// PATCH /api/contacts/:id
router.patch('/:id', async (req, res) => {
  const userId = req.session.userId;
  const {
    displayName, firstName, lastName,
    emails, phones, organization, notes, birthday, anniversary, contactDates,
    title, role, nickname, urls, instantMessages, categories, addresses,
  } = req.body || {};

  if (emails !== undefined && !Array.isArray(emails)) return res.status(400).json({ error: 'emails must be an array' });
  if (phones !== undefined && !Array.isArray(phones)) return res.status(400).json({ error: 'phones must be an array' });
  const normalizedBirthday = normalizeContactDate(birthday); const normalizedAnniversary = normalizeContactDate(anniversary);
  if (normalizedBirthday === undefined || normalizedAnniversary === undefined) return res.status(400).json({ error: 'Contact dates must use YYYY-MM-DD' });
  if (contactDates !== undefined && normalizeContactDates(contactDates) === undefined) return res.status(400).json({ error: 'contactDates must be an array of safe labelled YYYY-MM-DD dates' });

  try {
    // Load current contact (with its book source to block edits to synced contacts)
    const cur = await query(
      `SELECT c.*, ab.source AS book_source FROM contacts c
       JOIN address_books ab ON ab.id = c.address_book_id
       WHERE c.id = $1 AND c.user_id = $2`,
      [req.params.id, userId]
    );
    if (!cur.rows.length) return res.status(404).json({ error: 'Contact not found' });
    const c = cur.rows[0];
    if (c.book_source === 'carddav') {
      return res.status(403).json({ error: 'This contact is synced from CardDAV and is read-only' });
    }

    const hasRichFields = [title, role, nickname, urls, instantMessages, categories, addresses].some(value => value !== undefined);
    const rich = hasRichFields ? normalizeRichContactFields({
      title: chooseDefined(title, c.title),
      role: chooseDefined(role, c.role),
      nickname: chooseDefined(nickname, c.nickname),
      urls: chooseDefined(urls, c.urls),
      instantMessages: chooseDefined(instantMessages, c.instant_messages),
      categories: chooseDefined(categories, c.categories),
      addresses: chooseDefined(addresses, c.addresses),
    }) : {
      title: c.title, role: c.role, nickname: c.nickname,
      urls: c.urls, instantMessages: c.instant_messages, categories: c.categories, addresses: c.addresses,
    };
    if (!rich) return res.status(400).json({ error: 'Rich contact fields are malformed' });

    const newEmails    = emails    !== undefined ? emails    : c.emails;
    const newPhones    = phones    !== undefined ? phones    : c.phones;
    const newDisplay   = displayName  !== undefined ? displayName  : c.display_name;
    const newFirst     = firstName    !== undefined ? firstName    : c.first_name;
    const newLast      = lastName     !== undefined ? lastName     : c.last_name;
    const newOrg       = organization !== undefined ? organization : c.organization;
    const newNotes     = notes        !== undefined ? notes        : c.notes;
    const newBirthday = birthday !== undefined ? normalizedBirthday : c.birthday;
    const newAnniversary = anniversary !== undefined ? normalizedAnniversary : c.anniversary;
    const normalizedContactDates = normalizeContactDates(contactDates === undefined ? (c.contact_dates || []) : contactDates);
    if (normalizedContactDates === undefined) return res.status(400).json({ error: 'Stored contactDates contain unsafe labels' });
    const newContactDates = contactDatesWithLegacy(
      normalizedContactDates, newBirthday, newAnniversary, contactDates !== undefined
    );
    const authoritativeLegacyDates = contactDates === undefined ? null : legacyDatesFromContactDates(newContactDates);
    const storedBirthday = authoritativeLegacyDates?.birthday ?? (contactDates === undefined ? newBirthday : null);
    const storedAnniversary = authoritativeLegacyDates?.anniversary ?? (contactDates === undefined ? newAnniversary : null);
    const newPrimary   = emails === undefined
      ? c.primary_email
      : (newEmails[0]?.value ? newEmails[0].value.toLowerCase().trim() : null);

    const contactVCard = {
      uid: c.uid,
      displayName: newDisplay,
      firstName: newFirst,
      lastName: newLast,
      emails: newEmails,
      phones: newPhones,
      organization: newOrg,
      notes: newNotes,
      birthday: storedBirthday,
      anniversary: storedAnniversary,
      contactDates: newContactDates,
      ...rich,
    };
    const vcard = c.vcard ? mergeVCard(c.vcard, contactVCard) : generateVCard(contactVCard);
    const etag = crypto.createHash('md5').update(vcard).digest('hex');

    const result = await query(`
      UPDATE contacts SET
        display_name = $1, first_name = $2, last_name = $3,
        primary_email = $4, emails = $5, phones = $6,
        organization = $7, notes = $8, birthday = $9, anniversary = $10, contact_dates = $11::jsonb,
        title = $12, role = $13, nickname = $14, urls = $15, instant_messages = $16, categories = $17, addresses = $18,
        vcard = $19, etag = $20, updated_at = NOW(),
        is_auto = false
      WHERE id = $21 AND user_id = $22
      RETURNING id, uid, display_name, first_name, last_name,
                primary_email, emails, phones, organization, notes, birthday, anniversary, contact_dates AS "contactDates",
                title, role, nickname, urls, addresses, instant_messages AS "instantMessages", categories,
                is_auto, send_count, last_sent, etag, created_at, updated_at
    `, [
      newDisplay || null, newFirst || null, newLast || null,
      newPrimary,
      JSON.stringify(newEmails), JSON.stringify(newPhones),
      newOrg || null, newNotes || null, storedBirthday, storedAnniversary, JSON.stringify(newContactDates),
      rich.title, rich.role, rich.nickname, JSON.stringify(rich.urls), JSON.stringify(rich.instantMessages), JSON.stringify(rich.categories), JSON.stringify(rich.addresses),
      vcard, etag,
      req.params.id, userId,
    ]);

    await bumpSyncToken(c.address_book_id);
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A contact with that email already exists' });
    console.error('Contact update error:', err);
    res.status(500).json({ error: 'Failed to update contact' });
  }
});

// DELETE /api/contacts/:id
router.delete('/:id', async (req, res) => {
  const userId = req.session.userId;
  try {
    // Block deletion of CardDAV-synced (read-only) contacts; they reappear on next sync anyway.
    const owner = await query(
      `SELECT ab.source FROM contacts c JOIN address_books ab ON ab.id = c.address_book_id
       WHERE c.id = $1 AND c.user_id = $2`,
      [req.params.id, userId]
    );
    if (!owner.rows.length) return res.status(404).json({ error: 'Contact not found' });
    if (owner.rows[0].source === 'carddav') {
      return res.status(403).json({ error: 'This contact is synced from CardDAV and is read-only' });
    }
    const result = await query(
      'DELETE FROM contacts WHERE id = $1 AND user_id = $2 RETURNING address_book_id',
      [req.params.id, userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Contact not found' });
    await bumpSyncToken(result.rows[0].address_book_id);
    res.json({ ok: true });
  } catch (err) {
    console.error('Contact delete error:', err);
    res.status(500).json({ error: 'Failed to delete contact' });
  }
});

export default router;
