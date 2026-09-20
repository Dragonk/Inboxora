import { Router } from 'express';
import type { Response } from 'express';
import type { VCardContact } from '../utils/vcard.ts';
import { query, withTransaction } from '../services/db.js';
import { collectionIsWritable } from '../services/providerAccess.js';
import { providerIntegrationsEnabled } from '../services/providerSwitches.js';
import { requireAuth } from '../middleware/auth.js';
import { generateVCard, mergeVCard, normalizeContactDateLabel, normalizeVCardDate, parseVCard, splitVCards } from '../utils/vcard.js';
import { chooseDefined, normalizeRichContactFields } from '../utils/contactFields.js';
import { safeFetch } from '../services/safeFetch.js';
import { contactsToGoogleCsv, contactsToOutlookCsv, contactsToVCard, parseGoogleCsv } from '../utils/contactTransfer.js';
import crypto from 'crypto';
import { queryInt, queryString, queryStringOr, routeParam, sessionUserId } from '../utils/query.js';
import { toAppError } from '../utils/errors.js';
import { googleConfigFromEnv, isGoogleConfigured, isMicrosoftBrowserFlowReady, isMicrosoftConfigured, microsoftConfigFromEnv } from '../services/providerAuthService.js';
import { syncGoogleContacts } from '../services/providers/google/googleContactsSync.js';
import { GoogleApiError } from '../services/providers/google/googleApiClient.js';
import { syncGraphContacts } from '../services/providers/microsoft/graphContactsSync.js';
import {
  graphContactIdForLocalRow,
  localUidForGraphContact,
  recordGraphContactLink,
  removeGraphContactLink,
  resolveContactWriteTarget,
  writeGraphContact,
} from '../services/providerContactWrites.js';
import {
  googlePersonLinkForLocalRow,
  localUidForGoogleContact,
  recordGoogleContactLink,
  removeGoogleContactLink,
  resolveGoogleContactWriteTarget,
  writeGoogleContact,
} from '../services/providerGoogleWrites.js';
import type { GoogleContactWriteTarget } from '../services/providerGoogleWrites.js';
import { GraphApiError } from '../services/providers/microsoft/graphApiClient.js';

const router = Router();
router.use(requireAuth);

function normalizeContactDate(value: unknown): string | null | undefined {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? value : undefined;
}

function normalizeContactDates(value: unknown): Array<{ label: string; value: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const dates = [];
  const seen = new Set();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || typeof entry.label !== 'string') return undefined;
    const label = normalizeContactDateLabel(entry.label);
    const date = normalizeVCardDate(entry.value);
    if (!label || !date) return undefined;
    const key = `${label.toLocaleLowerCase()}\\u0000${date}`;
    if (!seen.has(key)) { seen.add(key); dates.push({ label, value: date }); }
  }
  return dates;
}

/** A single labelled contact date as the API accepts it. */
interface ContactDateEntry { label: string; value: string }

function isContactDateEntry(value: unknown): value is ContactDateEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as { label?: unknown; value?: unknown };
  return typeof entry.label === 'string' && typeof entry.value === 'string';
}

function contactDatesWithLegacy(contactDates: unknown, birthday: unknown, anniversary: unknown, authoritative = false) {
  const dates = (Array.isArray(contactDates) ? contactDates : [])
    .filter(isContactDateEntry)
    .filter(({ label }) => authoritative || !['birthday', 'anniversary'].includes(label.toLocaleLowerCase()))
    .map(({ label, value }) => ({ label, value }));
  if (authoritative) return dates;
  const seen = new Set(dates.map(({ label, value }) => `${label.toLocaleLowerCase()}\\u0000${value}`));
  const legacyPairs: Array<[string, unknown]> = [["Birthday", birthday], ["Anniversary", anniversary]];
  for (const [label, value] of legacyPairs) {
    if (typeof value === 'string' && value && !seen.has(`${label.toLocaleLowerCase()}\\u0000${value}`)) dates.push({ label, value });
  }
  return dates;
}

function legacyDatesFromContactDates(contactDates: ContactDateEntry[]) {
  const values: { birthday: string | null; anniversary: string | null } = { birthday: null, anniversary: null };
  for (const { label, value } of contactDates) {
    if (value.startsWith('--')) continue;
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
function gravatarCacheSet(hash: string, entry: { miss?: boolean; buf?: Buffer; type?: string; expires: number }): void {
  if (gravatarCache.size >= GRAVATAR_MAX_ENTRIES) {
    const oldest = gravatarCache.keys().next().value;
    if (oldest !== undefined) gravatarCache.delete(oldest);
  }
  gravatarCache.set(hash, entry);
}

// Resolve the user's default address book id, creating it if needed.
async function defaultAddressBook(userId: string) {
  const r = await query(
    `INSERT INTO address_books (user_id, name)
     VALUES ($1, 'Personal')
     ON CONFLICT (user_id, name) DO UPDATE SET updated_at = NOW()
     RETURNING id`,
    [userId]
  );
  return r.rows[0].id;
}

/**
 * Refresh the address book's `sync_token`, which CardDAV serves as the `getctag`.
 *
 * This does **not** notify collection-sync clients on its own: they compare the token the
 * server advertises, `urn:inboxora:carddav:<book>:<version>`, and `sync_version` is bumped
 * by the trigger on `contacts`. Both were verified against a real database — inserting a
 * contact (what an import does per card) advances `sync_version` — so a reader should not
 * rely on this call for change notification, nor remove the trigger believing this covers
 * it. Kept because the getctag is what older clients poll.
 */
async function bumpSyncToken(addressBookId: string): Promise<void> {
  await query(
    `UPDATE address_books SET sync_token = gen_random_uuid()::text, updated_at = NOW()
     WHERE id = $1`,
    [addressBookId]
  );
}

function localBookName(value: unknown): string | null {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  return name.length >= 1 && name.length <= 120 ? name : null;
}

type AddressBookLookup = { book: { id: string; name?: string | null; source?: string | null; visible?: boolean | null; source_access?: string | null; user_access?: string | null } } | { error: string; status: number };

async function requireLocalAddressBook(userId: string, addressBookId: string): Promise<AddressBookLookup> {
  // The collection row carries whether the origin permits writes and whether the user enabled them, so
  // the guard is the capability model's answer rather than a comparison against the book's source.
  const result = await query<{ id: string; name?: string | null; source?: string | null; visible?: boolean | null; source_access?: string | null; user_access?: string | null }>(
    `SELECT ab.id, ab.name, ab.source, ab.visible, ic.source_access, ic.user_access
       FROM address_books ab
       LEFT JOIN integration_collections ic
              ON ic.local_address_book_id = ab.id AND ic.kind = 'address_book' AND ic.user_id = ab.user_id
      WHERE ab.id = $1 AND ab.user_id = $2`,
    [addressBookId, userId],
  );
  const book = result.rows[0];
  if (!book) return { error: 'Address book not found', status: 404 };
  // A book has no `read_only` column: whether it accepts a write is a property of
  // the adapter that owns its `source`, which is what the capability model answers.
  if (!collectionIsWritable(book, 'contacts')) return { error: 'This address book is read-only', status: 403 };
  return { book };
}

/**
 * Resolve which writer owns an address book, including the Google one.
 *
 * `resolveContactWriteTarget` owns the local and Microsoft branches. Google's contact write path lives
 * in `providerGoogleWrites.ts`, so it is asked only when the shared resolver refused: it answers
 * `google` for a write-enabled Google book and `not_google` for anything else, which keeps every other
 * refusal (missing, read-only, an origin with no writer) exactly as the capability model produced it.
 */
type WritableContactBook =
  | { ok: false; status: number; error: string }
  | { ok: true; target: (ReturnType<typeof resolveContactWriteTarget> extends Promise<infer T> ? Exclude<T, { kind: 'refused' }> : never) | GoogleContactWriteTarget };

async function writableContactBook(userId: string, addressBookId: string): Promise<WritableContactBook> {
  const target = await resolveContactWriteTarget(userId, addressBookId);
  if (target.kind !== 'refused') return { ok: true, target };
  const google = await resolveGoogleContactWriteTarget(userId, addressBookId);
  if (google.kind === 'google') return { ok: true, target: google };
  if (google.kind === 'refused') return { ok: false, status: google.status, error: google.error };
  return { ok: false, status: target.status, error: target.error };
}

/** Report a provider contact write refusal with the shared vocabulary, as the calendar routes do. */
function contactWriteRefusal(res: Response, failure: { status: number; error: string; code?: string }): void {
  res.status(failure.status).json({
    ...(failure.code ? { code: failure.code } : {}),
    error: failure.error,
  });
}

router.get('/address-books', async (req, res) => {
  try {
    // `collection_id` is what the write-back opt-in is addressed by, and `read_only` is the capability
    // model's answer for the book as it stands — the same pair the calendar list exposes, so a pulled book
    // can be switched the same way a pulled calendar can. Without them the switch had nothing to address
    // and the write-back was unreachable for every address book.
    const result = await query<{ id: string; source?: string | null; source_access?: string | null; user_access?: string | null; [key: string]: unknown }>(
      `SELECT ab.id, ab.name, ab.source, ab.visible, ab.dav_mode, COUNT(c.id)::int AS contact_count,
              ic.id AS collection_id, ic.source_access, ic.user_access
         FROM address_books ab
         LEFT JOIN contacts c ON c.address_book_id = ab.id
         LEFT JOIN integration_collections ic
                ON ic.local_address_book_id = ab.id AND ic.kind = 'address_book' AND ic.user_id = ab.user_id
        WHERE ab.user_id = $1
        GROUP BY ab.id, ic.id
        ORDER BY ab.created_at ASC`,
      [req.session.userId],
    );
    const addressBooks = result.rows.map(row => ({
      ...row,
      read_only: !collectionIsWritable({
        source: typeof row.source === 'string' ? row.source : null,
        source_access: typeof row.source_access === 'string' ? row.source_access : null,
        user_access: typeof row.user_access === 'string' ? row.user_access : null,
      }, 'contacts'),
    }));
    res.json({ addressBooks });
  } catch (err) { console.error('Address book list error:', err); res.status(500).json({ error: 'Failed to fetch address books' }); }
});

router.post('/address-books', async (req, res) => {
  const name = localBookName(req.body?.name);
  if (!name) return res.status(400).json({ error: 'Address book name must be 1 to 120 characters' });
  try {
    const result = await query(`INSERT INTO address_books (user_id, name, source, visible) VALUES ($1, $2, 'local', true) RETURNING id, name, source, visible, dav_mode`, [req.session.userId, name]);
    res.status(201).json(result.rows[0]);
  } catch (caught) {
    const err = toAppError(caught);
    if (err.code === '23505') return res.status(409).json({ error: 'An address book with that name already exists' });
    console.error('Address book create error:', err); res.status(500).json({ error: 'Failed to create address book' });
  }
});

router.patch('/address-books/:id', async (req, res) => {
  const { name: rawName, visible, davMode } = req.body || {};
  if (rawName !== undefined && !localBookName(rawName)) return res.status(400).json({ error: 'Address book name must be 1 to 120 characters' });
  if (visible !== undefined && typeof visible !== 'boolean') return res.status(400).json({ error: 'visible must be a boolean' });
  if (davMode !== undefined && davMode !== null && davMode !== 'off' && davMode !== 'read_only' && davMode !== 'read_write') {
    return res.status(400).json({ error: 'davMode must be off, read_only or read_write' });
  }
  if (rawName === undefined && visible === undefined && (davMode === undefined || davMode === null)) return res.status(400).json({ error: 'No address book changes supplied' });
  try {
    const local = await requireLocalAddressBook(sessionUserId(req), req.params.id);
    if ('error' in local) return res.status(local.status).json({ error: local.error });
    const result = await query(`UPDATE address_books SET name = COALESCE($1, name), visible = COALESCE($2, visible), dav_mode = COALESCE($3, dav_mode), updated_at = NOW() WHERE id = $4 AND user_id = $5 RETURNING id, name, source, visible, dav_mode`, [rawName === undefined ? null : localBookName(rawName), visible === undefined ? null : visible, davMode ?? null, req.params.id, req.session.userId]);
    res.json(result.rows[0]);
  } catch (caught) {
    const err = toAppError(caught);
    if (err.code === '23505') return res.status(409).json({ error: 'An address book with that name already exists' });
    console.error('Address book update error:', err); res.status(500).json({ error: 'Failed to update address book' });
  }
});

router.delete('/address-books/:id', async (req, res) => {
  try {
    const local = await requireLocalAddressBook(sessionUserId(req), req.params.id);
    if ('error' in local) return res.status(local.status).json({ error: local.error });
    const count = await query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM address_books WHERE user_id = $1 AND source = 'local'`, [req.session.userId]);
    if (count.rows[0].count <= 1) return res.status(409).json({ error: 'At least one local address book is required' });
    await query('DELETE FROM address_books WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
    res.status(204).end();
  } catch (err) { console.error('Address book delete error:', err); res.status(500).json({ error: 'Failed to delete address book' }); }
});

// Whether Google contacts can be pulled, and what has been pulled so far. Safe for
// any authenticated user: it exposes no credential, only counts and timestamps.
router.get('/providers/google/status', async (req, res) => {
  const userId = sessionUserId(req);
  const [connections, books] = await Promise.all([
    query<{ id: string }>(
      "SELECT id FROM provider_connections WHERE user_id = $1 AND provider = 'google' AND status = 'active'",
      [userId],
    ),
    query<{
      connection_id: string; address_book_id: string; name: string | null;
      contact_count: number; last_success_at: string | Date | null; last_error_code: string | null; last_error_at: string | Date | null;
    }>(
      `SELECT ic.connection_id, ab.id AS address_book_id, ab.name,
              (SELECT COUNT(*)::int FROM contacts c WHERE c.address_book_id = ab.id) AS contact_count,
              s.last_success_at, s.last_error_code, s.last_error_at
         FROM integration_collections ic
         JOIN address_books ab ON ab.id = ic.local_address_book_id
         JOIN provider_connections pc ON pc.id = ic.connection_id AND pc.provider = 'google'
         LEFT JOIN sync_states s ON s.collection_id = ic.id AND s.user_id = ic.user_id
        WHERE ic.user_id = $1 AND ic.kind = 'address_book'
        ORDER BY ab.created_at ASC`,
      [userId],
    ),
  ]);
  res.json({
    configured: isGoogleConfigured(googleConfigFromEnv()),
    connected: connections.rows.length > 0,
    connections: connections.rows.length,
    books: books.rows.map(row => ({
      connectionId: row.connection_id,
      addressBookId: row.address_book_id,
      name: row.name,
      contactCount: row.contact_count,
      lastSyncedAt: row.last_success_at,
      lastErrorCode: row.last_error_code,
      lastErrorAt: row.last_error_at,
    })),
  });
});

// The same status and pull for the Microsoft Graph connector. Kept as its own pair
// of routes because the two providers are configured, authorized and reported
// independently — one being unconfigured must never hide the other.
router.get('/providers/microsoft/status', async (req, res) => {
  const userId = sessionUserId(req);
  const [connections, books] = await Promise.all([
    query<{ id: string }>(
      "SELECT id FROM provider_connections WHERE user_id = $1 AND provider = 'microsoft' AND status = 'active'",
      [userId],
    ),
    query<{
      connection_id: string; address_book_id: string; name: string | null;
      contact_count: number; last_success_at: string | Date | null; last_error_code: string | null; last_error_at: string | Date | null;
    }>(
      `SELECT ic.connection_id, ab.id AS address_book_id, ab.name,
              (SELECT COUNT(*)::int FROM contacts c WHERE c.address_book_id = ab.id) AS contact_count,
              s.last_success_at, s.last_error_code, s.last_error_at
         FROM integration_collections ic
         JOIN address_books ab ON ab.id = ic.local_address_book_id
         JOIN provider_connections pc ON pc.id = ic.connection_id AND pc.provider = 'microsoft'
         LEFT JOIN sync_states s ON s.collection_id = ic.id AND s.user_id = ic.user_id
        WHERE ic.user_id = $1 AND ic.kind = 'address_book'
        ORDER BY ab.created_at ASC`,
      [userId],
    ),
  ]);
  res.json({
    // The flag gates a "connect an account" hint, so it must mean the browser flow is
    // ready — not merely that a client id exists.
    configured: isMicrosoftBrowserFlowReady(microsoftConfigFromEnv()),
    connected: connections.rows.length > 0,
    connections: connections.rows.length,
    books: books.rows.map(row => ({
      connectionId: row.connection_id,
      addressBookId: row.address_book_id,
      name: row.name,
      contactCount: row.contact_count,
      lastSyncedAt: row.last_success_at,
      lastErrorCode: row.last_error_code,
      lastErrorAt: row.last_error_at,
    })),
  });
});

router.post('/providers/microsoft/sync', async (req, res) => {
  // An installation that switched the provider layer off must not reach a provider from here either:
  // the readiness report stops offering it, and this stops an existing collection from syncing.
  if (!providerIntegrationsEnabled()) {
    return res.status(403).json({ error: 'Provider integrations are disabled on this installation' });
  }
  const userId = sessionUserId(req);
  const connections = await query<{ id: string }>(
    "SELECT id FROM provider_connections WHERE user_id = $1 AND provider = 'microsoft' AND status = 'active' ORDER BY created_at ASC",
    [userId],
  );
  if (!connections.rows.length) {
    return res.status(409).json({ error: 'Connect a Microsoft account before syncing contacts' });
  }
  const config = microsoftConfigFromEnv();
  if (!isMicrosoftConfigured(config)) {
    return res.status(409).json({ error: 'Microsoft API is not configured by the administrator' });
  }

  const results: Array<Record<string, unknown>> = [];
  for (const connection of connections.rows) {
    try {
      results.push({ connectionId: connection.id, ...(await syncGraphContacts({ userId, connectionId: connection.id, config })) });
    } catch (caught) {
      const error = caught instanceof GraphApiError ? caught : null;
      results.push({
        connectionId: connection.id,
        error: error
          ? { code: error.code, message: error.message, retryable: error.retryable }
          : { code: 'INTERNAL_ERROR', message: toAppError(caught).message, retryable: false },
      });
    }
  }
  res.json({ results });
});

// Pull the signed-in user's Google personal contacts for every connected Google
// provider connection. The source stays the writer: the synced books are read-only
// and are not published to DAV devices until the user enables them.
router.post('/providers/google/sync', async (req, res) => {
  // An installation that switched the provider layer off must not reach a provider from here either:
  // the readiness report stops offering it, and this stops an existing collection from syncing.
  if (!providerIntegrationsEnabled()) {
    return res.status(403).json({ error: 'Provider integrations are disabled on this installation' });
  }
  const userId = sessionUserId(req);
  const connections = await query<{ id: string }>(
    "SELECT id FROM provider_connections WHERE user_id = $1 AND provider = 'google' AND status = 'active' ORDER BY created_at ASC",
    [userId],
  );
  if (!connections.rows.length) {
    return res.status(409).json({ error: 'Connect a Google account before syncing contacts' });
  }
  const config = googleConfigFromEnv();
  if (!isGoogleConfigured(config)) {
    return res.status(409).json({ error: 'Google API is not configured by the administrator' });
  }

  const results: Array<Record<string, unknown>> = [];
  for (const connection of connections.rows) {
    try {
      results.push({ connectionId: connection.id, ...(await syncGoogleContacts({ userId, connectionId: connection.id, config })) });
    } catch (caught) {
      const error = caught instanceof GoogleApiError ? caught : null;
      // One failing connection must not hide the others' results.
      results.push({
        connectionId: connection.id,
        error: error
          ? { code: error.code, message: error.message, retryable: error.retryable }
          : { code: 'INTERNAL_ERROR', message: toAppError(caught).message, retryable: false },
      });
    }
  }
  res.json({ results });
});

// GET /api/contacts
// Query params: q (search), limit, offset, is_auto (true|false|'')
router.get('/', async (req, res) => {
  const q = queryString(req.query.q) ?? '';
  const limit = queryInt(req.query.limit, 50);
  const offset = queryInt(req.query.offset, 0);
  const is_auto = queryString(req.query.is_auto);
  const addressBookId = queryString(req.query.addressBookId);
  const userId = sessionUserId(req);
  const cap = Math.min(limit, 500);
  const off = Math.max(0, offset);

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
        ab.source AS book_source, ic.source_access AS book_source_access, ic.user_access AS book_user_access
      FROM contacts c
      JOIN address_books ab ON ab.id = c.address_book_id
      LEFT JOIN integration_collections ic
             ON ic.local_address_book_id = c.address_book_id AND ic.kind = 'address_book' AND ic.user_id = c.user_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY
        c.is_auto ASC,
        c.send_count DESC,
        lower(coalesce(c.display_name, c.primary_email, '')) ASC
      LIMIT $${p} OFFSET $${p + 1}
    `, [...params, cap, off]);

    const total = await query<{ count: string }>(
      `SELECT COUNT(*) FROM contacts c JOIN address_books ab ON ab.id = c.address_book_id WHERE ${conditions.join(' AND ')}`,
      params
    );

    // Read-only is the capability model's answer for the book that owns each row,
    // not a comparison against one adapter's source value — which is why a Google
    // or Microsoft book is now reported read-only too instead of looking editable
    // until the server refuses the write.
    const contacts = result.rows.map(row => ({
      ...row,
      read_only: !collectionIsWritable({
        source: typeof row.book_source === 'string' ? row.book_source : null,
        source_access: typeof row.book_source_access === 'string' ? row.book_source_access : null,
        user_access: typeof row.book_user_access === 'string' ? row.book_user_access : null,
      }, 'contacts'),
    }));

    res.json({ contacts, total: parseInt(total.rows[0].count) });
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
  const userId = sessionUserId(req);

  if (!email || typeof email !== 'string') return res.status(400).end();

  try {
    const result = await query<{ photo_data: string }>(
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
      headers: { 'User-Agent': 'Inboxora/4.0.0' },
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
  const format = queryStringOr(req.query.format, '');
  if (!['google-csv', 'outlook-csv', 'vcard'].includes(format)) return res.status(400).json({ error: 'Unsupported export format' });
  try {
    const book = await query<{ id: string; name: string }>('SELECT id, name FROM address_books WHERE id = $1 AND user_id = $2', [routeParam(req.params.id), sessionUserId(req)]);
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
    const local = await requireLocalAddressBook(sessionUserId(req), req.params.id);
    if ('error' in local) return res.status(local.status).json({ error: local.error });
    const contacts = parseGoogleCsv(csv);
    if (!contacts.length) return res.status(400).json({ error: 'No contacts found in Google CSV' });
    await withTransaction(async client => {
      for (const contact of contacts) {
        const uid = crypto.randomUUID();
        const vcard = generateVCard({ uid, ...contact });
        const etag = crypto.createHash('md5').update(vcard).digest('hex');
        await client.query<{ vcard?: string | null }>(`INSERT INTO contacts (address_book_id, user_id, uid, vcard, etag, display_name, first_name, last_name, primary_email, emails, phones, organization, notes, birthday, anniversary, contact_dates, title, role, nickname, urls, instant_messages, categories, addresses, google_fields, is_auto) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,$19,$20::jsonb,$21::jsonb,$22::jsonb,$23::jsonb,$24::jsonb,false) ON CONFLICT (address_book_id, primary_email) WHERE primary_email IS NOT NULL DO UPDATE SET vcard = EXCLUDED.vcard, etag = EXCLUDED.etag, display_name = EXCLUDED.display_name, first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name, emails = EXCLUDED.emails, phones = EXCLUDED.phones, organization = EXCLUDED.organization, notes = EXCLUDED.notes, birthday = EXCLUDED.birthday, anniversary = EXCLUDED.anniversary, contact_dates = EXCLUDED.contact_dates, title = EXCLUDED.title, role = EXCLUDED.role, nickname = EXCLUDED.nickname, urls = EXCLUDED.urls, instant_messages = EXCLUDED.instant_messages, categories = EXCLUDED.categories, addresses = EXCLUDED.addresses, google_fields = EXCLUDED.google_fields, is_auto = false, updated_at = NOW()`, [local.book.id, sessionUserId(req), uid, vcard, etag, contact.displayName || null, contact.firstName || null, contact.lastName || null, contact.emails[0]?.value || null, JSON.stringify(contact.emails), JSON.stringify(contact.phones), contact.organization || null, contact.notes || null, contact.birthday || null, contact.anniversary || null, JSON.stringify(contact.contactDates || []), contact.title || null, contact.role || null, contact.nickname || null, JSON.stringify(contact.urls || []), JSON.stringify(contact.instantMessages || []), JSON.stringify(contact.categories || []), JSON.stringify(contact.addresses || []), JSON.stringify(contact.sourceFields || {})]);
      }
    });
    await bumpSyncToken(local.book.id);
    res.status(201).json({ imported: contacts.length });
  } catch (err) { console.error('Google CSV import error:', err); res.status(500).json({ error: 'Failed to import Google CSV' }); }
});

// Import a `.vcf` file. Unlike the CSV import, which dedupes by e-mail address
// (a CSV has no stable identity), a vCard carries a UID, and that UID is also what
// DAV clients use — so the import keys on it and a re-import updates in place
// instead of creating a second copy of every contact.
router.post('/address-books/:id/import/vcard', async (req, res) => {
  const vcardFile = typeof req.body?.vcard === 'string' ? req.body.vcard : '';
  if (!vcardFile || vcardFile.length > 900_000) return res.status(400).json({ error: 'vCard file must be a non-empty file smaller than 900 KB' });
  try {
    const local = await requireLocalAddressBook(sessionUserId(req), req.params.id);
    if ('error' in local) return res.status(local.status).json({ error: local.error });
    const cards = splitVCards(vcardFile);
    if (!cards.length) return res.status(400).json({ error: 'No contacts found in the vCard file' });

    const userId = sessionUserId(req);
    let imported = 0;
    await withTransaction(async client => {
      for (const raw of cards) {
        const parsed = parseVCard(raw);
        // A card with no recognisable property at all is skipped rather than stored blank.
        if (!parsed.displayName && !parsed.emails.length && !parsed.phones.length) continue;
        // A card without a UID gets one, so it still has a stable identity afterwards.
        const uid = parsed.uid?.trim() || crypto.randomUUID();
        const text = generateVCard({ ...parsed, uid });
        const etag = crypto.createHash('md5').update(text).digest('hex');
        const primaryEmail = (parsed.emails.find(email => email.primary) || parsed.emails[0])?.value?.toLowerCase() || null;
        await client.query(
          `INSERT INTO contacts (
             address_book_id, user_id, uid, vcard, etag, display_name, first_name, last_name, primary_email,
             emails, phones, organization, notes, birthday, anniversary, contact_dates, photo_data,
             title, role, nickname, urls, instant_messages, categories, addresses, google_fields, is_auto
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16::jsonb,$17,$18,$19,$20,$21::jsonb,$22::jsonb,$23::jsonb,$24::jsonb,'{}'::jsonb,false)
           ON CONFLICT (address_book_id, uid) DO UPDATE SET
             vcard = EXCLUDED.vcard, etag = EXCLUDED.etag, display_name = EXCLUDED.display_name,
             first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name, primary_email = EXCLUDED.primary_email,
             emails = EXCLUDED.emails, phones = EXCLUDED.phones, organization = EXCLUDED.organization,
             notes = EXCLUDED.notes, birthday = EXCLUDED.birthday, anniversary = EXCLUDED.anniversary,
             contact_dates = EXCLUDED.contact_dates, photo_data = EXCLUDED.photo_data, title = EXCLUDED.title,
             role = EXCLUDED.role, nickname = EXCLUDED.nickname, urls = EXCLUDED.urls,
             instant_messages = EXCLUDED.instant_messages, categories = EXCLUDED.categories,
             addresses = EXCLUDED.addresses, is_auto = false, updated_at = NOW()`,
          [
            local.book.id, userId, uid, text, etag,
            parsed.displayName, parsed.firstName, parsed.lastName, primaryEmail,
            JSON.stringify(parsed.emails), JSON.stringify(parsed.phones), parsed.organization, parsed.notes,
            parsed.birthday, parsed.anniversary, JSON.stringify(parsed.contactDates), parsed.photoData,
            parsed.title, parsed.role, parsed.nickname, JSON.stringify(parsed.urls), JSON.stringify(parsed.instantMessages),
            JSON.stringify(parsed.categories), JSON.stringify(parsed.addresses),
          ],
        );
        imported += 1;
      }
    });
    if (!imported) return res.status(400).json({ error: 'No contacts found in the vCard file' });
    await bumpSyncToken(local.book.id);
    res.status(201).json({ imported });
  } catch (err) {
    console.error('vCard import error:', err);
    res.status(500).json({ error: 'Failed to import the vCard file' });
  }
});

// GET /api/contacts/:id
router.get('/:id', async (req, res) => {
  const userId = sessionUserId(req);
  try {
    const result = await query<{ id: string; uid: string; display_name?: string | null; first_name?: string | null; last_name?: string | null; primary_email?: string | null; emails?: unknown; phones?: unknown; organization?: string | null; notes?: string | null; birthday?: string | null; anniversary?: string | null; contactDates?: unknown; title?: string | null; role?: string | null; nickname?: string | null; urls?: unknown; addresses?: unknown; instantMessages?: unknown; categories?: string[]; googleFields?: unknown; photo_data?: string | null; vcard?: string | null; is_auto?: boolean | null; send_count?: number | null; last_sent?: string | Date | null; book_source?: string | null; book_source_access?: string | null; book_user_access?: string | null; read_only?: boolean }>(
      `SELECT c.id, c.uid, c.display_name, c.first_name, c.last_name,
              c.primary_email, c.emails, c.phones, c.organization,
              c.notes, c.birthday, c.anniversary, c.contact_dates AS "contactDates", c.title, c.role, c.nickname,
              c.urls, c.addresses, c.instant_messages AS "instantMessages", c.categories,
              c.google_fields AS "googleFields",
              c.photo_data, c.is_auto, c.send_count, c.last_sent,
              c.etag, c.vcard, c.created_at, c.updated_at,
              ab.source AS book_source, ic.source_access AS book_source_access, ic.user_access AS book_user_access
       FROM contacts c
       JOIN address_books ab ON ab.id = c.address_book_id
       LEFT JOIN integration_collections ic
              ON ic.local_address_book_id = c.address_book_id AND ic.kind = 'address_book' AND ic.user_id = c.user_id
       WHERE c.id = $1 AND c.user_id = $2`,
      [req.params.id, userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Contact not found' });
    const contact = result.rows[0];
    contact.read_only = !collectionIsWritable({
      source: contact.book_source ?? null,
      source_access: contact.book_source_access ?? null,
      user_access: contact.book_user_access ?? null,
    }, 'contacts');
    if (contact.vcard) {
      const parsed = parseVCard(contact.vcard);
      const scalarFields: ReadonlyArray<'title' | 'role' | 'nickname'> = ['title', 'role', 'nickname'];
      for (const field of scalarFields) {
        if (contact[field] == null || (Array.isArray(contact[field]) && !contact[field].length)) contact[field] = parsed[field];
      }
      const unknownFields: ReadonlyArray<'urls' | 'addresses' | 'instantMessages'> = ['urls', 'addresses', 'instantMessages'];
      for (const field of unknownFields) {
        if (contact[field] == null || (Array.isArray(contact[field]) && !contact[field].length)) contact[field] = parsed[field];
      }
      if (contact.categories == null || !contact.categories.length) contact.categories = parsed.categories;
    }
    res.json(contact);
  } catch (err) {
    console.error('Contact get error:', err);
    res.status(500).json({ error: 'Failed to fetch contact' });
  }
});

// POST /api/contacts
router.post('/', async (req, res) => {
  const userId = sessionUserId(req);
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
  if (normalizedContactDates === undefined) return res.status(400).json({ error: 'contactDates must be an array of safe labelled YYYY-MM-DD or --MM-DD dates' });
  const storedContactDates = contactDatesWithLegacy(
    normalizedContactDates, normalizedBirthday, normalizedAnniversary, contactDates !== undefined
  );
  const authoritativeLegacyDates = contactDates === undefined ? null : legacyDatesFromContactDates(storedContactDates);
  const storedBirthday: string | null | undefined = authoritativeLegacyDates?.birthday ?? (contactDates === undefined ? normalizedBirthday : null);
  const storedAnniversary: string | null | undefined = authoritativeLegacyDates?.anniversary ?? (contactDates === undefined ? normalizedAnniversary : null);

  const primaryEmail = emails[0]?.value
    ? emails[0].value.toLowerCase().trim()
    : null;

  if (!displayName && !primaryEmail) {
    return res.status(400).json({ error: 'A name or email address is required' });
  }

  try {
    const addressBookId = requestedAddressBookId || await defaultAddressBook(userId);
    if (!addressBookId) return res.status(404).json({ error: 'No address book available' });
    const requestedId = requestedAddressBookId;
    if (requestedId) {
      const local = await requireLocalAddressBook(userId, requestedId);
      if ('error' in local) return res.status(local.status).json({ error: local.error });
    }
    // A provider-backed book writes to its origin first: the provider is the source of truth, and a local
    // row that claims a contact the provider never accepted is worse than a slower create.
    const access = await writableContactBook(userId, addressBookId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    const writeTarget = access.target;
    let providerContactId: string | null = null;
    let providerEtag: string | null = null;
    let uid: string = crypto.randomUUID();
    if (writeTarget.kind === 'graph' || writeTarget.kind === 'google') {
      // The local book enforces one row per address; writing to the provider first and then failing the
      // local insert would leave a contact the interface cannot see, so the duplicate is refused here.
      if (primaryEmail) {
        const duplicate = await query(
          'SELECT 1 FROM contacts WHERE address_book_id = $1 AND lower(primary_email) = $2 LIMIT 1',
          [addressBookId, primaryEmail],
        );
        if (duplicate.rows.length) return res.status(409).json({ error: 'A contact with that email already exists' });
      }
      const contact = { displayName, firstName, lastName, emails, phones, organization, notes, birthday: storedBirthday, anniversary: storedAnniversary, contactDates: storedContactDates, ...rich };
      if (writeTarget.kind === 'graph') {
        const attempt = await writeGraphContact({ userId, target: writeTarget, operation: 'create', contact });
        if (attempt.status === 'failed') return contactWriteRefusal(res, attempt.failure);
        providerContactId = attempt.providerContactId;
        uid = localUidForGraphContact(providerContactId);
      } else {
        const attempt = await writeGoogleContact({ userId, target: writeTarget, operation: 'create', contact });
        if (attempt.status === 'failed') return contactWriteRefusal(res, attempt.failure);
        providerContactId = attempt.providerContactId;
        // The version the create returned is what a later update must present back to People.
        providerEtag = attempt.person?.etag ?? null;
        uid = localUidForGoogleContact(providerContactId);
      }
    }
    const vcard = generateVCard({ uid, displayName, firstName, lastName, emails, phones, organization, notes, birthday: storedBirthday, anniversary: storedAnniversary, contactDates: storedContactDates, ...rich });
    const etag = crypto.createHash('md5').update(vcard).digest('hex');

    const result = await query<{ id: string }>(`
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

    if (providerContactId && writeTarget.kind === 'graph') {
      await recordGraphContactLink({ userId, target: writeTarget, providerContactId, localId: result.rows[0].id });
    } else if (providerContactId && writeTarget.kind === 'google') {
      await recordGoogleContactLink({
        userId, target: writeTarget, providerContactId, localId: result.rows[0].id, etag: providerEtag,
      });
    }
    await bumpSyncToken(addressBookId);
    res.status(201).json(providerContactId ? { ...result.rows[0], providerContactId } : result.rows[0]);
  } catch (caught) {
    const err = toAppError(caught);
    if (err.code === '23505') return res.status(409).json({ error: 'A contact with that email already exists' });
    console.error('Contact create error:', err);
    res.status(500).json({ error: 'Failed to create contact' });
  }
});

// PATCH /api/contacts/:id
router.patch('/:id', async (req, res) => {
  const userId = sessionUserId(req);
  const {
    displayName, firstName, lastName,
    emails, phones, organization, notes, birthday, anniversary, contactDates,
    title, role, nickname, urls, instantMessages, categories, addresses,
  } = req.body || {};

  if (emails !== undefined && !Array.isArray(emails)) return res.status(400).json({ error: 'emails must be an array' });
  if (phones !== undefined && !Array.isArray(phones)) return res.status(400).json({ error: 'phones must be an array' });
  const normalizedBirthday = normalizeContactDate(birthday); const normalizedAnniversary = normalizeContactDate(anniversary);
  if (normalizedBirthday === undefined || normalizedAnniversary === undefined) return res.status(400).json({ error: 'Contact dates must use YYYY-MM-DD' });
  if (contactDates !== undefined && normalizeContactDates(contactDates) === undefined) return res.status(400).json({ error: 'contactDates must be an array of safe labelled YYYY-MM-DD or --MM-DD dates' });

  try {
    // Load current contact (with its book source to block edits to synced contacts)
    const cur = await query<{ id: string; user_id: string; address_book_id: string; uid?: string | null; vcard?: string | null; book_source?: string | null; title?: string | null; role?: string | null; nickname?: string | null; urls?: VCardContact['urls']; instant_messages?: VCardContact['instantMessages']; categories?: string[]; addresses?: VCardContact['addresses']; birthday?: string | null; anniversary?: string | null; [key: string]: unknown }>(
      `SELECT c.*, ab.source AS book_source FROM contacts c
       JOIN address_books ab ON ab.id = c.address_book_id
       WHERE c.id = $1 AND c.user_id = $2`,
      [req.params.id, userId]
    );
    if (!cur.rows.length) return res.status(404).json({ error: 'Contact not found' });
    const c = cur.rows[0];
    // Which writer owns this book is the capability model's answer, resolved once for the provider and
    // the local paths alike: a local edit to a provider collection would be an apparent write-back the
    // next sync discards.
    const access = await writableContactBook(userId, c.address_book_id);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    const writeTarget = access.target;

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

    const contactVCard: VCardContact = {
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

    // Provider first, then the local projection: a refusal or an unknown outcome leaves the local row
    // untouched, so the interface never shows a change the provider did not accept.
    if (writeTarget.kind === 'graph') {
      const providerContactId = await graphContactIdForLocalRow(userId, writeTarget.collectionId, c.id);
      if (!providerContactId) return res.status(409).json({ error: 'This contact is not linked to its provider copy yet' });
      const attempt = await writeGraphContact({
        userId, target: writeTarget, operation: 'update', providerContactId, contact: contactVCard, localResourceId: c.id,
      });
      if (attempt.status === 'failed') return contactWriteRefusal(res, attempt.failure);
    } else if (writeTarget.kind === 'google') {
      const link = await googlePersonLinkForLocalRow(userId, writeTarget.collectionId, c.id);
      if (!link) return res.status(409).json({ error: 'This contact is not linked to its provider copy yet' });
      // People's updateContact requires the etag of the version the caller read; the link carries it.
      const attempt = await writeGoogleContact({
        userId, target: writeTarget, operation: 'update',
        providerContactId: link.resourceName, contact: contactVCard, etag: link.etag, localResourceId: c.id,
      });
      if (attempt.status === 'failed') return contactWriteRefusal(res, attempt.failure);
    }

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
  } catch (caught) {
    const err = toAppError(caught);
    if (err.code === '23505') return res.status(409).json({ error: 'A contact with that email already exists' });
    console.error('Contact update error:', err);
    res.status(500).json({ error: 'Failed to update contact' });
  }
});

// DELETE /api/contacts/:id
router.delete('/:id', async (req, res) => {
  const userId = sessionUserId(req);
  try {
    // Block deletion of externally synced (read-only) contacts; they reappear on
    // the next sync anyway.
    const owner = await query<{ address_book_id: string }>(
      `SELECT c.address_book_id FROM contacts c
       WHERE c.id = $1 AND c.user_id = $2`,
      [req.params.id, userId]
    );
    if (!owner.rows.length) return res.status(404).json({ error: 'Contact not found' });
    const access = await writableContactBook(userId, owner.rows[0].address_book_id);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    const writeTarget = access.target;

    if (writeTarget.kind === 'graph' || writeTarget.kind === 'google') {
      const providerContactId = writeTarget.kind === 'graph'
        ? await graphContactIdForLocalRow(userId, writeTarget.collectionId, req.params.id)
        : (await googlePersonLinkForLocalRow(userId, writeTarget.collectionId, req.params.id))?.resourceName ?? null;
      if (!providerContactId) return res.status(409).json({ error: 'This contact is not linked to its provider copy yet' });
      // A contact the provider no longer has is the end state the user asked for, so its local row is
      // removed and the link tombstoned rather than the delete being reported as a failure.
      if (writeTarget.kind === 'graph') {
        const attempt = await writeGraphContact({ userId, target: writeTarget, operation: 'delete', providerContactId, localResourceId: req.params.id });
        if (attempt.status === 'failed' && attempt.failure.code !== 'RESOURCE_NOT_FOUND') {
          return contactWriteRefusal(res, attempt.failure);
        }
        await removeGraphContactLink({ userId, target: writeTarget, providerContactId });
      } else {
        const attempt = await writeGoogleContact({ userId, target: writeTarget, operation: 'delete', providerContactId, localResourceId: req.params.id });
        if (attempt.status === 'failed' && attempt.failure.code !== 'RESOURCE_NOT_FOUND') {
          return contactWriteRefusal(res, attempt.failure);
        }
        await removeGoogleContactLink({ userId, target: writeTarget, providerContactId });
      }
    }

    const result = await query<{ address_book_id: string }>(
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
