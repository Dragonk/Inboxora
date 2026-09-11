import { mergeCalendarResource } from '../utils/calendarRecurrence.js';
import ICAL from 'ical.js';
import { parseInboundCalendarInvitation } from '../services/inboundCalendarInvitation.js';
import { parseCalendarEvent } from '../utils/ical.js';
import { descriptionContentLines, normalizeDescription } from '../utils/richText.js';
import { Router } from 'express';
import crypto from 'crypto';
import { query, withTransaction } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { decrypt, encrypt } from '../services/encryption.js';
import { validateHost } from '../services/hostValidation.js';
import { getConnectionPolicy } from '../services/connectionPolicy.js';
import { releaseCalendarSource, scheduleCalendarSource, stopCalendarSource, syncCalendarSource } from '../services/externalCalendarSync.js';
import { sendCalendarInvitation } from '../services/calendarInvitation.js';
import { deliverInvitationOutbox, deliverStoredInvitation, invitationActionsForStorage, invitationDeliveryError, resolveInvitationActions } from '../services/calendarInvitationOutbox.js';
import { projectCalendarResources } from '../services/calendarProjectionPool.js';
import { EVENT_COLUMNS, coveragePredicate } from '../services/calendarOccurrences.js';

const router = Router();
const MAX_EVENT_RANGE_DAYS = 366;
const MAX_EVENT_RANGE_MS = MAX_EVENT_RANGE_DAYS * 24 * 60 * 60 * 1000;
const CONTACT_CALENDAR_ID = 'contacts-birthdays';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
router.use(requireAuth);

// Calendar selection is opt-in: an absent parameter means "every calendar"
// (the historical behaviour), while an explicitly empty selection means "none".
// Ownership is still enforced by the SQL filter (`c.user_id`/`c.owner_user_id`),
// so a foreign id can only ever match zero rows.
function parseCalendarSelection(raw) {
  if (raw === undefined || raw === null) return { ids: null };
  const parts = (Array.isArray(raw) ? raw : [raw])
    .flatMap(value => String(value).split(','))
    .map(value => value.trim())
    .filter(Boolean);
  const ids = [];
  for (const id of parts) {
    if (id === CONTACT_CALENDAR_ID) { ids.push(id); continue; }
    if (!UUID_PATTERN.test(id)) return { error: 'Invalid calendar id' };
    ids.push(id);
  }
  return { ids: [...new Set(ids)] };
}

function parseEventTimes(body) {
  const startsAt = new Date(body?.startsAt);
  const endsAt = new Date(body?.endsAt);
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) {
    return null;
  }
  return { startsAt, endsAt };
}

function contactDateEvents(contacts, from, to) {
  const events = [];
  for (const contact of contacts) {
    const dates = [
      ...(Array.isArray(contact.contact_dates) ? contact.contact_dates : []),
      ...(contact.birthday ? [{ label: 'Birthday', value: contact.birthday }] : []),
      ...(contact.anniversary ? [{ label: 'Anniversary', value: contact.anniversary }] : []),
    ];
    const seen = new Set();
    for (const date of dates) {
      if (!date || typeof date !== 'object') continue;
      const label = typeof date.label === 'string' && date.label.trim() ? date.label.trim() : 'Other';
      if (date.value instanceof Date && Number.isNaN(date.value.getTime())) continue;
      const value = date.value instanceof Date ? date.value.toISOString().slice(0, 10) : typeof date.value === 'string' ? date.value.trim() : '';
      if (!/^(?:\d{4}|-)-\d{2}-\d{2}$/.test(value)) continue;
      const key = `${label.toLocaleLowerCase()}\u0000${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const [, , month, day] = value.match(/^(\d{4}|-)-(\d{2})-(\d{2})$/);
      for (let year = from.getUTCFullYear(); year <= to.getUTCFullYear(); year++) {
        const startsAt = new Date(Date.UTC(year, Number(month) - 1, Number(day)));
        if (startsAt.getUTCMonth() !== Number(month) - 1 || startsAt.getUTCDate() !== Number(day) || startsAt < from || startsAt >= to) continue;
        const endsAt = new Date(startsAt); endsAt.setUTCDate(endsAt.getUTCDate() + 1);
        const labelKey = crypto.createHash('sha256').update(label).digest('hex').slice(0, 16);
        const dateSlug = value.replaceAll('-', '');
        const id = `contacts-${contact.id}-${labelKey}-${dateSlug}-${year}`;
        events.push({ id, calendar_id: 'contacts-birthdays', uid: id, summary: `${label}: ${contact.display_name || contact.primary_email || 'Contact'}`, contact_date_label: label, contact_name: contact.display_name || contact.primary_email || null, starts_at: startsAt, ends_at: endsAt, all_day: true, calendar_name: 'Contact dates', calendar_color: '#e879f9', source: 'contacts', read_only: true });
      }
    }
  }
  return events;
}

function escapeICalendarText(value) {
  return String(value || '')
    .replaceAll('\\', '\\\\')
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .replaceAll('\n', '\\n')
    .replaceAll(';', '\\;')
    .replaceAll(',', '\\,');
}

function formatICalendarDate(value, allDay) {
  const utc = value.toISOString();
  return allDay
    ? utc.slice(0, 10).replaceAll('-', '')
    : utc.replaceAll('-', '').replaceAll(':', '').replace('.000', '');
}

function foldICalendarLine(line) {
  const chunks = [];
  let chunk = '';
  let limit = 75;
  for (const character of line) {
    if (Buffer.byteLength(chunk + character, 'utf8') > limit && chunk) {
      chunks.push(chunk);
      chunk = character;
      limit = 74;
    } else chunk += character;
  }
  chunks.push(chunk);
  return chunks.join('\r\n ');
}

function localEventIcal({ uid, summary, description, location, url, organizer, attendees = [], startsAt, endsAt, allDay }) {
  const dateParameter = allDay ? ';VALUE=DATE' : '';
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Inboxora//DAV Hub//EN', 'BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${formatICalendarDate(new Date(), false)}`, `DTSTART${dateParameter}:${formatICalendarDate(startsAt, allDay)}`, `DTEND${dateParameter}:${formatICalendarDate(endsAt, allDay)}`];
  if (summary) lines.push(`SUMMARY:${escapeICalendarText(summary)}`);
  lines.push(...descriptionContentLines(description, escapeICalendarText));
  if (location) lines.push(`LOCATION:${escapeICalendarText(location)}`);
  if (url) lines.push(`URL:${String(url).replace(/[\r\n]/g, '')}`);
  if (organizer) lines.push(`ORGANIZER:mailto:${escapeICalendarText(organizer.replace(/^mailto:/i, ''))}`);
  for (const email of attendees) lines.push(`ATTENDEE:mailto:${email}`);
  lines.push('END:VEVENT', 'END:VCALENDAR', '');
  return lines.map(foldICalendarLine).join('\r\n');
}

function normalizeAttendees(value) {
  if (!Array.isArray(value)) return null;
  const attendees = value.map(email => typeof email === 'string' ? email.trim().toLowerCase() : '').filter(Boolean);
  if (attendees.some(email => /[\r\n\0\s,;"<>]/.test(email) || !/^[^@]+@[^@]+\.[^@]+$/.test(email))) return null;
  return [...new Set(attendees)];
}

// `attendees` is a jsonb column. node-postgres serialises a JavaScript array as a
// PostgreSQL array literal (`{a@b.c}`), which jsonb rejects with
// "invalid input syntax for type json" — and an empty array silently becomes the
// jsonb OBJECT `{}`. Either way a plain array must never be bound directly.
function jsonbAttendees(value) {
  return JSON.stringify(Array.isArray(value) ? value : []);
}

// Older rows may already hold `{}` because of the binding bug above. Read them
// back as an empty array and never call jsonb_array_length() on a non-array.
const ATTENDEES_IS_ARRAY = "jsonb_typeof(attendees) = 'array'";
// Reads must tolerate `{}` rows written before the binding fix; the CASE keeps
// jsonb_array_length() from ever seeing a non-array.
const READ_ATTENDEES = "CASE WHEN jsonb_typeof(attendees) = 'array' THEN attendees ELSE '[]'::jsonb END AS attendees";

function invitationOperationKey(req) {
  const supplied = req.headers['x-idempotency-key'];
  if (typeof supplied === 'string' && supplied.trim()) return supplied.trim().slice(0, 128);
  return crypto.createHash('sha256').update(JSON.stringify(req.body || {})).digest('hex');
}

function invitationRequestFingerprint(req, fields) {
  const { calendarId, normalizedAttendees, times, summary, description, location, url, organizer, allDay, timezone, invitationAccount } = fields;
  return crypto.createHash('sha256').update(JSON.stringify({
    eventId: req.params.eventId || null, calendarId, summary: summary || null, description, location, url, organizer,
    allDay: Boolean(allDay), timezone, attendees: normalizedAttendees, inviteAccountId: invitationAccount?.id || null,
    startsAt: times.startsAt.toISOString(), endsAt: times.endsAt.toISOString(),
  })).digest('hex');
}

// The single response shape for anything that may have to deliver an invitation.
function invitationDeliveryResponse(event, delivery) {
  return {
    event,
    invitationStatus: { status: delivery?.status || 'pending', lastError: delivery?.lastError || null },
    ...(invitationDeliveryError(delivery) ? { invitationError: invitationDeliveryError(delivery) } : {}),
  };
}

async function updateInvitedEvent(req, fields) {
  const { calendarId, invitationAccount, normalizedAttendees, times, summary, description, location, url, organizer, allDay, timezone } = fields;
  const key = invitationOperationKey(req);
  const fingerprint = invitationRequestFingerprint(req, fields);
  return withTransaction(async client => {
    const prior = await client.query('SELECT id, event_id, request_fingerprint, status, last_error, payload FROM calendar_invitation_outbox WHERE user_id = $1 AND idempotency_key = $2 FOR UPDATE', [req.session.userId, key]);
    if (prior.rows[0]) {
      if (prior.rows[0].request_fingerprint !== fingerprint) return { conflict: true };
      const event = (await client.query('SELECT id, calendar_id, uid, etag, summary, description, location, url, organizer, starts_at, ends_at, all_day, timezone, attendees, invite_account_id, invitation_sequence, created_at, updated_at FROM calendar_events WHERE id = $1 AND calendar_id = $2 AND user_id = $3', [prior.rows[0].event_id, calendarId, req.session.userId])).rows[0];
      if (!event || event.id !== req.params.eventId) return { conflict: true };
      // An identical retry of an undelivered invitation must actually resend it,
      // not just replay the earlier error. The caller delivers after commit.
      if (prior.rows[0].status === 'sent') return { event, duplicate: true, delivered: { status: 'sent', lastError: null } };
      return { event, duplicate: true, outboxId: prior.rows[0].id, payload: prior.rows[0].payload };
    }
    const existing = (await client.query(`SELECT uid, raw_ical, ${READ_ATTENDEES}, invite_account_id, invitation_sequence, summary, description, location, starts_at, ends_at, all_day FROM calendar_events WHERE id = $1 AND calendar_id = $2 AND user_id = $3 FOR UPDATE`, [req.params.eventId, calendarId, req.session.userId])).rows[0];
    if (!existing) return { notFound: true };
    const hadInvitation = Boolean(existing.invite_account_id && Array.isArray(existing.attendees) && existing.attendees.length);
    const senderChanged = hadInvitation && invitationAccount.id !== existing.invite_account_id;
    const cancelledAttendees = hadInvitation
      ? (senderChanged ? existing.attendees : existing.attendees.filter(email => !normalizedAttendees.includes(email)))
      : [];
    let cancellationAccount = null;
    if (cancelledAttendees.length) {
      cancellationAccount = invitationAccount.id === existing.invite_account_id
        ? invitationAccount
        : (await client.query('SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2 AND smtp_host IS NOT NULL', [existing.invite_account_id, req.session.userId])).rows[0] || null;
      if (!cancellationAccount) return { cancelFailed: true };
    }
    const rawIcal = mergeCalendarResource(existing.raw_ical, localEventIcal({ uid: existing.uid, summary, description, location, url, organizer, attendees: normalizedAttendees, allDay: Boolean(allDay), ...times }));
    const result = await client.query(`UPDATE calendar_events SET raw_ical = $1, summary = $2, description = $3, location = $4, url = $5, organizer = $6, starts_at = $7, ends_at = $8, all_day = $9, timezone = $10, attendees = $11, invite_account_id = $12, invitation_sequence = CASE WHEN (invite_account_id IS NOT NULL AND ${ATTENDEES_IS_ARRAY} AND jsonb_array_length(attendees) > 0) OR invitation_sequence > 0 THEN invitation_sequence + 1 ELSE 0 END, etag = gen_random_uuid()::text, updated_at = NOW() WHERE id = $13 AND calendar_id = $14 AND user_id = $15 RETURNING id, calendar_id, uid, etag, summary, description, location, url, organizer, starts_at, ends_at, all_day, timezone, attendees, invite_account_id, invitation_sequence, created_at, updated_at`, [rawIcal, summary || null, description, location, url, organizer, times.startsAt, times.endsAt, Boolean(allDay), timezone, jsonbAttendees(normalizedAttendees), invitationAccount.id, req.params.eventId, calendarId, req.session.userId]);
    const event = result.rows[0];
    const actions = [];
    if (cancelledAttendees.length) actions.push({ account: cancellationAccount, attendees: cancelledAttendees, summary: existing.summary, description: existing.description, location: existing.location, uid: existing.uid, allDay: Boolean(existing.all_day), method: 'CANCEL', sequence: Number(existing.invitation_sequence || 0) + 1, startsAt: new Date(existing.starts_at).toISOString(), endsAt: new Date(existing.ends_at).toISOString() });
    actions.push({ account: invitationAccount, attendees: normalizedAttendees, summary, description, location, uid: event.uid, allDay: Boolean(allDay), method: 'REQUEST', sequence: event.invitation_sequence, startsAt: times.startsAt.toISOString(), endsAt: times.endsAt.toISOString() });
    const outbox = await client.query('INSERT INTO calendar_invitation_outbox (user_id, event_id, idempotency_key, request_fingerprint, payload) VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING id', [req.session.userId, event.id, key, fingerprint, JSON.stringify({ actions: invitationActionsForStorage(actions) })]);
    return { event, outboxId: outbox.rows[0].id, actions };
  });
}

async function writableCalendar(userId, calendarId) {
  const result = await query(
    'SELECT id, source, read_only FROM calendars WHERE id = $1 AND user_id = $2 AND owner_user_id = $2',
    [calendarId, userId],
  );
  const calendar = result.rows[0];
  if (!calendar) return { status: 404, error: 'Calendar not found' };
  if (calendar.read_only || calendar.source !== 'local') return { status: 403, error: 'This calendar is read-only' };
  return { calendar };
}

async function contactCalendarAppearance(userId) {
  const result = await query("SELECT preferences->'calendarContactAppearance' AS appearance FROM users WHERE id = $1", [userId]);
  return result?.rows?.[0]?.appearance || {};
}

// Fetch the raw .ics MIME part of a message. Extracted so the reader can fall back
// to it whenever the invitation captured during sync is missing or unusable.
async function fetchInvitationAttachment(row, userId) {
  const attachments = typeof row.attachments === 'string' ? JSON.parse(row.attachments) : row.attachments || [];
  const candidates = attachments.filter(item => /^(text\/calendar|application\/(ics|ical|calendar))$/i.test(item.type || '') || /\.ics$/i.test(item.filename || ''));
  if (candidates.length !== 1 || candidates[0].size > 1024 * 1024) return null;
  const account = await query('SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2', [row.account_id, userId]);
  if (!account.rows[0]) return null;
  const { imapManager } = await import('../index.js');
  let data;
  try {
    data = await imapManager.fetchAttachment(account.rows[0], row.uid, row.folder, candidates[0].part);
  } catch (error) {
    // The mailbox could not be reached right now. This is a fetch failure, not a
    // malformed invitation, and it must not turn into an opaque 500.
    console.warn('Calendar invitation attachment fetch failed:', error.message);
    return null;
  }
  if (!data) return null;
  // The fetched part is decoded bytes; the parser needs the iCalendar text.
  const raw = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
  return raw.trim() ? raw : null;
}

async function readMessageInvitation(messageId, userId) {
  const result = await query(`SELECT i.raw_ical, m.account_id, m.uid, m.folder, m.attachments
    FROM messages m JOIN email_accounts a ON a.id = m.account_id
    LEFT JOIN inbound_calendar_invitations i ON i.message_id = m.id
    WHERE m.id = $1 AND a.user_id = $2`, [messageId, userId]);
  const row = result.rows[0];
  if (!row) return null;
  // Prefer the invitation captured during sync. When it is absent, or present but
  // not parseable, fall back to the raw MIME part: a message that predates the
  // capture (or whose capture was incomplete) must still be openable and importable.
  const sources = [row.raw_ical, () => fetchInvitationAttachment(row, userId)];
  for (const source of sources) {
    const raw = typeof source === 'function' ? await source() : source;
    if (!raw) continue;
    const invitation = parseInboundCalendarInvitation(raw);
    if (invitation) return { ...invitation, event: parseCalendarEvent(raw) };
  }
  return null;
}

// The local event a message's invitation was imported into, if any. The reader uses it
// to show an already-added invitation as added — and, on a cancellation, to offer
// removing the copy the organizer has just retracted. Scoped to the importing message
// so an unrelated local event with the same UID is never reported or removed.
async function importedEventForMessage(messageId, userId) {
  const result = await query(
    `SELECT id, calendar_id, invitation_sequence, starts_at, ends_at, all_day
     FROM calendar_events
     WHERE source_message_id = $1 AND user_id = $2
     ORDER BY created_at ASC LIMIT 1`,
    [messageId, userId],
  );
  const event = result.rows[0];
  return event ? {
    id: event.id, calendarId: event.calendar_id, sequence: Number(event.invitation_sequence || 0),
    startsAt: event.starts_at, endsAt: event.ends_at, allDay: event.all_day,
  } : null;
}

router.get('/invitations/:messageId', async (req, res) => {
  const invitation = await readMessageInvitation(req.params.messageId, req.session.userId);
  if (!invitation) return res.status(404).json({ error: 'Calendar invitation not found' });
  const { raw, event, ...metadata } = invitation;
  void raw;
  const localEvent = await importedEventForMessage(req.params.messageId, req.session.userId);
  res.json({ invitation: { ...metadata, localEvent, description: event?.description, location: event?.location, url: event?.url, attendees: event?.attendees || [] } });
});

// Remove the copy this message's invitation was added as. This is what makes a
// cancellation actionable: an organizer retracting an invitation should leave the
// calendar in the state it would have been in had the invitation never been accepted.
router.delete('/invitations/:messageId', async (req, res) => {
  const invitation = await readMessageInvitation(req.params.messageId, req.session.userId);
  if (!invitation) return res.status(404).json({ error: 'Calendar invitation not found' });
  const localEvent = await importedEventForMessage(req.params.messageId, req.session.userId);
  if (!localEvent) return res.status(404).json({ error: 'This invitation was not added to a calendar' });
  // A retraction that predates the copy we hold must not delete it: the organizer may
  // have sent a newer update since. Same ordering rule the import path already applies.
  if (Number(invitation.sequence || 0) < localEvent.sequence) {
    return res.status(409).json({ error: 'This cancellation is older than the event already in the calendar' });
  }
  // Only the imported mirror is removed, and only while it is still that mirror: an
  // event the user has since taken ownership of (by inviting attendees from it) is
  // left alone rather than silently deleted out from under them.
  const removed = await query(
    `DELETE FROM calendar_events
     WHERE id = $1 AND user_id = $2 AND source_message_id = $3 AND invite_account_id IS NULL
     RETURNING id`,
    [localEvent.id, req.session.userId, req.params.messageId],
  );
  if (!removed.rows[0]) return res.status(409).json({ error: 'This event can no longer be removed automatically' });
  res.json({ removed: true, calendarId: localEvent.calendarId });
});

router.post('/invitations/:messageId', async (req, res) => {
  if (!req.body?.calendarId) return res.status(400).json({ error: 'calendarId is required' });
  const access = await writableCalendar(req.session.userId, req.body.calendarId);
  if (access.error) return res.status(access.status).json({ error: access.error });
  const invitation = await readMessageInvitation(req.params.messageId, req.session.userId);
  if (!invitation) return res.status(404).json({ error: 'Calendar invitation not found' });
  if (invitation.method !== 'REQUEST' || !invitation.event) return res.status(409).json({ error: 'This invitation cannot be added' });
  const event = invitation.event;
  // Scope copies by organizer as well as UID; never overwrite an unrelated local event.
  const uid = `mail-${crypto.createHash('sha256').update(JSON.stringify([invitation.uid, invitation.organizer, invitation.recurrenceId])).digest('hex')}`;
  const component = new ICAL.Component(ICAL.parse(event.raw));
  component.removeAllProperties('method');
  component.getFirstSubcomponent('vevent').updatePropertyWithValue('uid', uid);
  const raw = component.toString();
  const result = await query(`INSERT INTO calendar_events
    (calendar_id, user_id, uid, raw_ical, etag, summary, starts_at, ends_at, all_day, timezone, description, location, url, organizer, attendees, invitation_sequence, source_message_id)
    VALUES ($1,$2,$3,$4,gen_random_uuid()::text,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16)
    ON CONFLICT (calendar_id, uid, recurrence_id) DO UPDATE SET
      raw_ical = EXCLUDED.raw_ical, etag = gen_random_uuid()::text, summary = EXCLUDED.summary,
      starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at, all_day = EXCLUDED.all_day, timezone = EXCLUDED.timezone,
      description = EXCLUDED.description, location = EXCLUDED.location, url = EXCLUDED.url,
      organizer = EXCLUDED.organizer, attendees = EXCLUDED.attendees, invitation_sequence = EXCLUDED.invitation_sequence,
      source_message_id = COALESCE(EXCLUDED.source_message_id, calendar_events.source_message_id), updated_at = NOW()
    WHERE calendar_events.invitation_sequence < EXCLUDED.invitation_sequence AND calendar_events.invite_account_id IS NULL
    RETURNING id`, [req.body.calendarId, req.session.userId, uid, raw, event.summary, event.startsAt, event.endsAt,
      event.allDay, event.timeZone, event.description, event.location, event.url, event.organizer, JSON.stringify(event.attendees), invitation.sequence,
      req.params.messageId]);
  res.json({ added: true, changed: Boolean(result.rows[0]), calendarId: req.body.calendarId });
});

router.get('/calendars', async (req, res) => {
  const result = await query(
    `SELECT id, name, description, color, source, external_url, read_only, display_visible, owner_user_id, sync_token, created_at, updated_at
     FROM calendars WHERE user_id = $1 AND owner_user_id = $1 ORDER BY created_at ASC`,
    [req.session.userId],
  );
  const appearance = await contactCalendarAppearance(req.session.userId);
  res.json({ calendars: [...result.rows, {
    id: 'contacts-birthdays', name: appearance.name || 'Contact dates', custom_name: Boolean(appearance.name), description: 'Birthdays and anniversaries from contacts',
    color: appearance.color || '#e879f9', source: 'contacts', external_url: null, read_only: true, display_visible: appearance.displayVisible !== false,
  }] });
});

function calendarName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  return name && name.length <= 120 ? name : null;
}

function calendarColor(value) {
  if (value == null || value === '') return null;
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : undefined;
}

router.post('/calendars', async (req, res) => {
  const name = calendarName(req.body?.name);
  const color = calendarColor(req.body?.color);
  const displayVisible = req.body?.displayVisible ?? true;
  if (!name || color === undefined || typeof displayVisible !== 'boolean') {
    return res.status(400).json({ error: 'name, a hex color, and displayVisible are required' });
  }
  try {
    const result = await query(
      `INSERT INTO calendars (user_id, owner_user_id, name, color, display_visible, source, read_only)
       VALUES ($1, $1, $2, $3, $4, 'local', false)
       RETURNING id, user_id, owner_user_id, name, description, color, source, external_url, read_only, display_visible, sync_token, created_at, updated_at`,
      [req.session.userId, name, color, displayVisible],
    );
    return res.status(201).json({ calendar: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'A calendar with that name already exists' });
    throw error;
  }
});

router.patch('/calendars/:calendarId', async (req, res) => {
  const name = calendarName(req.body?.name);
  const color = calendarColor(req.body?.color);
  const displayVisible = req.body?.displayVisible;
  if (!name || color === undefined || typeof displayVisible !== 'boolean') {
    return res.status(400).json({ error: 'name, a hex color, and displayVisible are required' });
  }
  if (req.params.calendarId === 'contacts-birthdays') {
    const customName = req.body.customName === false ? null : name;
    await query(
      "UPDATE users SET preferences = COALESCE(preferences, '{}'::jsonb) || jsonb_build_object('calendarContactAppearance', $2::jsonb) WHERE id = $1",
      [req.session.userId, JSON.stringify({ name: customName, color, displayVisible })],
    );
    return res.json({ calendar: { id: 'contacts-birthdays', name: customName || 'Contact dates', custom_name: Boolean(customName), color, display_visible: displayVisible, source: 'contacts', read_only: true } });
  }
  try {
    const result = await query(
      `UPDATE calendars
       SET name = $1, color = $2, display_visible = $3, updated_at = NOW()
       WHERE id = $4 AND owner_user_id = $5 AND user_id = $5
       RETURNING id, user_id, owner_user_id, name, description, color, source, external_url, read_only, display_visible, sync_token, created_at, updated_at`,
      [name, color, displayVisible, req.params.calendarId, req.session.userId],
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Calendar not found' });
    return res.json({ calendar: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'A calendar with that name already exists' });
    throw error;
  }
});

router.delete('/calendars/:calendarId', async (req, res) => {
  const confirmName = calendarName(req.body?.confirmName);
  if (!confirmName) return res.status(400).json({ error: 'confirmName is required' });
  const result = await query(
    `DELETE FROM calendars
     WHERE id = $1 AND owner_user_id = $2 AND user_id = $2 AND name = $3 AND source = 'local' AND read_only = false
     RETURNING id`,
    [req.params.calendarId, req.session.userId, confirmName],
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Calendar not found' });
  res.status(204).end();
});

router.get('/events', async (req, res) => {
  const from = new Date(req.query.from);
  const to = new Date(req.query.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to < from) {
    return res.status(400).json({ error: 'A valid from/to range is required' });
  }
  if (to.getTime() - from.getTime() > MAX_EVENT_RANGE_MS) {
    return res.status(400).json({ error: 'The requested event range is too large' });
  }
  const selection = parseCalendarSelection(req.query.calendarIds);
  if (selection.error) return res.status(400).json({ error: selection.error });
  const selectedIds = selection.ids === null ? null : selection.ids.filter(id => id !== CONTACT_CALENDAR_ID);
  const includeContacts = selection.ids === null || selection.ids.includes(CONTACT_CALENDAR_ID);
  // A selection naming only the contact calendar still needs no event query, and
  // an explicitly empty selection means "no calendars at all". Ownership stays
  // enforced by the SQL predicate, so a foreign id can only match zero rows.
  let materializedRows = [];
  let eventRows = [];
  if (selection.ids === null || selectedIds.length > 0) {
    const params = [req.session.userId, from, to];
    let calendarFilter = '';
    if (selectedIds !== null) { params.push(selectedIds); calendarFilter = ' AND c.id = ANY($4::uuid[])'; }
    // Materialised occurrences: a plain indexed range scan, with no recurrence expansion at
    // all. Any event whose stored rows are missing, stale, or do not cover this window is
    // excluded here and picked up by the fallback query below, so this read can never be the
    // reason an event is missing — only the reason it appears fast.
    const result = await query(
      `SELECT CASE WHEN o.recurrence_id = '' THEN e.id::text ELSE e.id::text || '@' || o.recurrence_id END AS id,
              CASE WHEN e.recurring THEN e.id END AS series_id,
              e.recurring,
              o.recurrence_id, o.starts_at, o.ends_at, o.all_day, o.timezone,
              COALESCE(o.summary, e.summary) AS summary,
              COALESCE(o.description, e.description) AS description,
              COALESCE(o.location, e.location) AS location,
              COALESCE(o.url, e.url) AS url,
              COALESCE(o.organizer, e.organizer) AS organizer,
              COALESCE(o.attendees, e.attendees) AS attendees,
              e.calendar_id, e.uid, e.etag, e.invite_account_id, e.invitation_sequence,
              CASE WHEN sa.id IS NOT NULL THEN e.source_message_id END AS source_message_id,
              sm.folder AS source_folder,
              sa.id AS source_account_id,
              c.name AS calendar_name, c.color AS calendar_color, c.source, c.read_only
       FROM calendar_occurrences o
       JOIN calendar_events e ON e.id = o.event_id
       JOIN calendars c ON c.id = o.calendar_id
       LEFT JOIN messages sm ON sm.id = e.source_message_id
       LEFT JOIN email_accounts sa ON sa.id = sm.account_id AND sa.user_id = e.user_id
       LEFT JOIN calendar_occurrence_state s ON s.event_id = e.id
       WHERE o.user_id = $1 AND c.user_id = $1 AND c.owner_user_id = $1
         AND o.starts_at < $3 AND o.ends_at > $2
         AND NOT ${coveragePredicate('s')}${calendarFilter}
       ORDER BY o.starts_at ASC`,
      params,
    );
    materializedRows = result.rows;

    // The live fallback. Everything not covered above is expanded exactly as it was before
    // materialisation existed, which is what makes a lagging or broken worker a performance
    // problem rather than a correctness one.
    // `e.recurring` is a stored, indexed column rather than a regex over raw_ical: the regex
    // could not use an index, so the planner scanned every event the user owned and detoasted
    // each raw_ical. See migration 0082.
    const fallback = await query(
      `SELECT ${EVENT_COLUMNS},
              CASE WHEN sa.id IS NOT NULL THEN e.source_message_id END AS source_message_id,
              sm.folder AS source_folder,
              sa.id AS source_account_id
       FROM calendar_events e
       JOIN calendars c ON c.id = e.calendar_id
       LEFT JOIN messages sm ON sm.id = e.source_message_id
       LEFT JOIN email_accounts sa ON sa.id = sm.account_id AND sa.user_id = e.user_id
       LEFT JOIN calendar_occurrence_state s ON s.event_id = e.id
       WHERE e.user_id = $1 AND c.user_id = $1 AND c.owner_user_id = $1
         AND ((e.starts_at < $3 AND e.ends_at > $2) OR e.recurring)
         AND ${coveragePredicate('s')}${calendarFilter}
       ORDER BY e.starts_at ASC`,
      params,
    );
    eventRows = fallback.rows;
  }
  let contactEvents = [];
  if (includeContacts) {
    // Both reads only need the same user id, so they run together rather than one after
    // the other — the contact calendar is on by default, so this is on the common path.
    const [contactResult, appearance] = await Promise.all([
      query(
        'SELECT id, display_name, primary_email, birthday, anniversary, contact_dates FROM contacts WHERE user_id = $1 AND (birthday IS NOT NULL OR anniversary IS NOT NULL OR (jsonb_typeof(contact_dates) = \'array\' AND jsonb_array_length(contact_dates) > 0))',
        [req.session.userId],
      ),
      contactCalendarAppearance(req.session.userId),
    ]);
    contactEvents = contactDateEvents(contactResult?.rows || [], from, to).map(event => ({
      ...event, calendar_name: appearance.name || event.calendar_name, calendar_custom_name: Boolean(appearance.name), calendar_color: appearance.color || event.calendar_color,
    }));
  }
  // Only the events the fast read could not serve are expanded here — normally none. The
  // worker pool still bounds the CPU when it does happen, so a single request cannot stall
  // the process on a series the worker has not reached yet.
  const projection = await projectCalendarResources(eventRows, from, to, { userId: req.session.userId });
  const events = [...materializedRows, ...projection.events, ...contactEvents]
    .sort((left, right) => new Date(left.starts_at) - new Date(right.starts_at));
  if (projection.truncated) {
    // A partial result must never look complete. Only the series id and a reason
    // category cross the wire; internal error text stays in the server log.
    for (const failure of projection.failures) {
      console.warn('Calendar projection incomplete:', JSON.stringify({ userId: req.session.userId, seriesId: failure.id, reason: failure.reason }));
    }
    return res.json({
      events,
      truncated: true,
      incompleteSeries: projection.failures.map(failure => ({ series_id: failure.id, reason: failure.reason || 'truncated' })),
    });
  }
  res.json({ events, truncated: false });
});

router.post('/events', async (req, res) => {
  const { calendarId, summary, description: rawDescription = null, location = null, url = null, organizer = null, allDay = false, timezone = null, sendInvites = false, inviteAccountId, attendees } = req.body || {};
  const description = normalizeDescription(rawDescription);
  const times = parseEventTimes(req.body);
  if (!calendarId || !times) return res.status(400).json({ error: 'calendarId and a valid event range are required' });
  const normalizedAttendees = normalizeAttendees(attendees || []);
  if (!normalizedAttendees) return res.status(400).json({ error: 'Attendees must be valid email addresses' });
  if (sendInvites && (!inviteAccountId || !normalizedAttendees.length)) {
    return res.status(400).json({ error: 'A sender account and at least one attendee are required for invitations' });
  }

  const access = await writableCalendar(req.session.userId, calendarId);
  if (access.error) return res.status(access.status).json({ error: access.error });

  let invitationAccount = null;
  if (sendInvites) {
    const sender = await query(
      'SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2 AND enabled = true AND smtp_host IS NOT NULL',
      [inviteAccountId, req.session.userId],
    );
    invitationAccount = sender.rows[0] || null;
    if (!invitationAccount) return res.status(400).json({ error: 'The selected sender account is unavailable' });
  }

  if (sendInvites && typeof req.headers['x-idempotency-key'] === 'string' && req.headers['x-idempotency-key'].trim()) {
    const idempotencyKey = invitationOperationKey(req);
    const fingerprint = invitationRequestFingerprint(req, { calendarId, normalizedAttendees, times, summary, description, location, url, organizer, allDay, timezone, invitationAccount });
    let outcome;
    try {
      outcome = await withTransaction(async client => {
      const prior = await client.query('SELECT id, event_id, request_fingerprint, status, last_error, payload FROM calendar_invitation_outbox WHERE user_id = $1 AND idempotency_key = $2 FOR UPDATE', [req.session.userId, idempotencyKey]);
      if (prior.rows[0]) {
        if (prior.rows[0].request_fingerprint !== fingerprint) return { conflict: true };
        const event = (await client.query('SELECT id, calendar_id, uid, etag, summary, description, location, url, organizer, starts_at, ends_at, all_day, timezone, attendees, invite_account_id, invitation_sequence, created_at, updated_at FROM calendar_events WHERE id = (SELECT event_id FROM calendar_invitation_outbox WHERE id = $1)', [prior.rows[0].id])).rows[0];
        if (prior.rows[0].status === 'sent') return { event, duplicate: true, delivered: { status: 'sent', lastError: null } };
        return { event, duplicate: true, outboxId: prior.rows[0].id, payload: prior.rows[0].payload };
      }
      const uid = crypto.randomUUID();
      const rawIcal = localEventIcal({ uid, summary, description, location, url, organizer, attendees: normalizedAttendees, allDay: Boolean(allDay), ...times });
      const result = await client.query(
        `INSERT INTO calendar_events (calendar_id, user_id, uid, raw_ical, summary, description, location, url, organizer, starts_at, ends_at, all_day, timezone, attendees, invite_account_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING id, calendar_id, uid, etag, summary, description, location, url, organizer, starts_at, ends_at, all_day, timezone, attendees, invite_account_id, invitation_sequence, created_at, updated_at`,
        [calendarId, req.session.userId, uid, rawIcal, summary || null, description, location, url, organizer, times.startsAt, times.endsAt, Boolean(allDay), timezone, jsonbAttendees(normalizedAttendees), invitationAccount.id],
      );
      const event = result.rows[0];
      const outbox = await client.query(
        `INSERT INTO calendar_invitation_outbox (user_id, event_id, idempotency_key, request_fingerprint, payload) VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING id`,
        [req.session.userId, event.id, idempotencyKey, fingerprint, JSON.stringify({ actions: invitationActionsForStorage([{ account: invitationAccount, attendees: normalizedAttendees, summary, description, location, uid, allDay: Boolean(allDay), method: 'REQUEST', sequence: event.invitation_sequence ?? 0, startsAt: times.startsAt.toISOString(), endsAt: times.endsAt.toISOString() }]) })],
      );
        return { event, outboxId: outbox.rows[0].id };
      });
    } catch (error) {
      console.error('Calendar invitation transaction failed:', error.message, error.code ? `(code ${error.code})` : '');
      return res.status(500).json({ error: 'The event and invitation could not be saved; no partial changes were kept.' });
    }
    if (outcome.conflict) return res.status(409).json({ error: 'The idempotency key was already used for a different calendar operation' });
    if (outcome.duplicate) {
      if (outcome.delivered) return res.status(201).json(invitationDeliveryResponse(outcome.event, outcome.delivered));
      // Same request, same key, invitation not delivered yet: resend it now rather
      // than replaying the stale error. The account is resolved from the payload.
      const delivered = await deliverStoredInvitation({ userId: req.session.userId, outboxId: outcome.outboxId, payload: outcome.payload, fallbackAccountId: outcome.event?.invite_account_id });
      return res.status(201).json(invitationDeliveryResponse(outcome.event, delivered));
    }
    const actions = await resolveInvitationActions(req.session.userId, [{ account: invitationAccount, attendees: normalizedAttendees, summary, description, location, uid: outcome.event.uid, allDay: Boolean(allDay), method: 'REQUEST', sequence: outcome.event.invitation_sequence ?? 0, startsAt: times.startsAt.toISOString(), endsAt: times.endsAt.toISOString() }]);
    const delivered = await deliverInvitationOutbox({ outboxId: outcome.outboxId, actions });
    return res.status(201).json(invitationDeliveryResponse(outcome.event, delivered));
  }

  const uid = crypto.randomUUID();
  const rawIcal = localEventIcal({ uid, summary, description, location, url, organizer, attendees: normalizedAttendees, allDay: Boolean(allDay), ...times });
  const result = await query(
    `INSERT INTO calendar_events (
       calendar_id, user_id, uid, raw_ical, summary, description, location, url, organizer,
       starts_at, ends_at, all_day, timezone, attendees, invite_account_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING id, calendar_id, uid, etag, summary, description, location, url, organizer,
               starts_at, ends_at, all_day, timezone, attendees, invite_account_id, invitation_sequence, created_at, updated_at`,
    [calendarId, req.session.userId, uid, rawIcal, summary || null, description, location, url, organizer, times.startsAt, times.endsAt, Boolean(allDay), timezone, jsonbAttendees(normalizedAttendees), invitationAccount?.id || null],
  );
  let invitationError = null;
  if (invitationAccount) {
    try {
      await sendCalendarInvitation({ account: invitationAccount, attendees: normalizedAttendees, summary, description, location, uid, allDay: Boolean(allDay), method: 'REQUEST', sequence: result.rows[0].invitation_sequence ?? 0, ...times });
    } catch (error) {
      invitationError = 'The event was saved, but the invitation could not be sent.';
      console.error('Calendar invitation delivery failed:', error.message);
    }
  }
  res.status(201).json({ event: result.rows[0], ...(invitationError ? { invitationError } : {}) });
});


router.all('/events/:eventId/occurrence', async (req, res) => {
  if (!['PATCH', 'DELETE'].includes(req.method)) return res.status(405).end();
  const { calendarId, recurrenceId } = req.body || {};
  if (!calendarId || typeof recurrenceId !== 'string' || !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}Z?)?$/.test(recurrenceId)) return res.status(400).json({ error: 'A valid occurrence and calendar are required' });
  const access = await writableCalendar(req.session.userId, calendarId);
  if (access.error) return res.status(access.status).json({ error: access.error });
  const cancel = req.method === 'DELETE';
  const times = cancel ? null : parseEventTimes(req.body);
  const attendees = normalizeAttendees(req.body.attendees || []);
  if (!cancel && (!times || !attendees)) return res.status(400).json({ error: 'Invalid event values' });
  const outcome = await withTransaction(async client => {
    const row = (await client.query('SELECT uid, raw_ical, invite_account_id FROM calendar_events WHERE id = $1 AND calendar_id = $2 AND user_id = $3 FOR UPDATE', [req.params.eventId, calendarId, req.session.userId])).rows[0];
    if (!row) return { status: 404 };
    const event = parseCalendarEvent(row.raw_ical);
    if (!event) return { status: 409 };
    const replacement = localEventIcal(cancel ? { ...event, allDay: event.allDay } : { ...req.body, description: normalizeDescription(req.body?.description), attendees, ...times, uid: row.uid });
    const raw = mergeCalendarResource(row.raw_ical, replacement, recurrenceId, cancel);
    await client.query('UPDATE calendar_events SET raw_ical = $1, etag = gen_random_uuid()::text, updated_at = NOW() WHERE id = $2 AND calendar_id = $3 AND user_id = $4', [raw, req.params.eventId, calendarId, req.session.userId]);
    return { status: 200 };
  });
  if (outcome.status !== 200) return res.status(outcome.status).json({ error: 'Calendar occurrence unavailable' });
  res.json({ updated: true });
});

router.patch('/events/:eventId', async (req, res) => {
  const { calendarId, summary, description: rawDescription = null, location = null, url = null, organizer = null, allDay = false, timezone = null, sendInvites = false, inviteAccountId, attendees } = req.body || {};
  const description = normalizeDescription(rawDescription);
  const times = parseEventTimes(req.body);
  if (!calendarId || !times) return res.status(400).json({ error: 'calendarId and a valid event range are required' });
  const normalizedAttendees = normalizeAttendees(attendees || []);
  if (!normalizedAttendees) return res.status(400).json({ error: 'Attendees must be valid email addresses' });
  if (sendInvites && (!inviteAccountId || !normalizedAttendees.length)) return res.status(400).json({ error: 'A sender account and at least one attendee are required for invitations' });

  const access = await writableCalendar(req.session.userId, calendarId);
  if (access.error) return res.status(access.status).json({ error: access.error });

  let invitationAccount = null;
  if (sendInvites) {
    const sender = await query('SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2 AND enabled = true AND smtp_host IS NOT NULL', [inviteAccountId, req.session.userId]);
    invitationAccount = sender.rows[0] || null;
    if (!invitationAccount) return res.status(400).json({ error: 'The selected sender account is unavailable' });
  }

  if (sendInvites && typeof req.headers['x-idempotency-key'] === 'string' && req.headers['x-idempotency-key'].trim()) {
    let outcome;
    try {
      outcome = await updateInvitedEvent(req, { calendarId, invitationAccount, normalizedAttendees, times, summary, description, location, url, organizer, allDay, timezone });
    } catch (error) {
      console.error('Calendar invitation transaction failed:', error.message, error.code ? `(code ${error.code})` : '');
      return res.status(500).json({ error: 'The event and invitation could not be saved; no partial changes were kept.' });
    }
    if (outcome.notFound) return res.status(404).json({ error: 'Event not found' });
    if (outcome.conflict) return res.status(409).json({ error: 'The idempotency key was already used for a different calendar update' });
    if (outcome.cancelFailed) return res.status(502).json({ error: 'The previous invitation could not be cancelled, so the event was not changed.' });
    if (outcome.duplicate) {
      if (outcome.delivered) return res.json(invitationDeliveryResponse(outcome.event, outcome.delivered));
      // An identical retry must resend an undelivered invitation, not replay the error.
      const delivered = await deliverStoredInvitation({ userId: req.session.userId, outboxId: outcome.outboxId, payload: outcome.payload, fallbackAccountId: outcome.event?.invite_account_id });
      return res.json(invitationDeliveryResponse(outcome.event, delivered));
    }
    const actions = await resolveInvitationActions(req.session.userId, outcome.actions);
    const delivered = await deliverInvitationOutbox({ outboxId: outcome.outboxId, actions });
    return res.json(invitationDeliveryResponse(outcome.event, delivered));
  }

  const outcome = await withTransaction(async client => {
    const existing = await client.query(`SELECT uid, raw_ical, ${READ_ATTENDEES}, invite_account_id, invitation_sequence, summary, description, location, starts_at, ends_at, all_day FROM calendar_events WHERE id = $1 AND calendar_id = $2 AND user_id = $3 FOR UPDATE`, [req.params.eventId, calendarId, req.session.userId]);
    const existingEvent = existing.rows[0];
    if (!existingEvent) return { notFound: true };

    const hadInvitation = Boolean(existingEvent.invite_account_id && Array.isArray(existingEvent.attendees) && existingEvent.attendees.length);
    const senderChanged = hadInvitation && sendInvites && invitationAccount?.id !== existingEvent.invite_account_id;
    const cancelledAttendees = hadInvitation ? (senderChanged || !sendInvites ? existingEvent.attendees : existingEvent.attendees.filter(email => !normalizedAttendees.includes(email))) : [];
    const cancellationAccount = invitationAccount?.id === existingEvent.invite_account_id
      ? invitationAccount
      : cancelledAttendees.length
        // A disabled account retains SMTP settings for cancellation; referenced
        // sender accounts cannot be deleted because the FK is ON DELETE RESTRICT.
        ? (await client.query('SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2 AND smtp_host IS NOT NULL', [existingEvent.invite_account_id, req.session.userId])).rows[0] || null
        : null;
    if (cancelledAttendees.length) {
      if (!cancellationAccount) return { cancelFailed: true };
      try {
        await sendCalendarInvitation({ account: cancellationAccount, attendees: cancelledAttendees, summary: existingEvent.summary, description: existingEvent.description, location: existingEvent.location, uid: existingEvent.uid, allDay: Boolean(existingEvent.all_day), method: 'CANCEL', sequence: Number(existingEvent.invitation_sequence || 0) + 1, startsAt: new Date(existingEvent.starts_at), endsAt: new Date(existingEvent.ends_at) });
      } catch (error) {
        console.error('Calendar invitation cancellation before update failed:', error.message);
        return { cancelFailed: true };
      }
    }

    const rawIcal = mergeCalendarResource(existingEvent.raw_ical, localEventIcal({ uid: existingEvent.uid, summary, description, location, url, organizer, attendees: normalizedAttendees, allDay: Boolean(allDay), ...times }));
    const result = await client.query(`UPDATE calendar_events SET raw_ical = $1, summary = $2, description = $3, location = $4, url = $5, organizer = $6, starts_at = $7, ends_at = $8, all_day = $9, timezone = $10, attendees = $11, invite_account_id = $12, invitation_sequence = CASE WHEN (invite_account_id IS NOT NULL AND ${ATTENDEES_IS_ARRAY} AND jsonb_array_length(attendees) > 0) OR invitation_sequence > 0 THEN invitation_sequence + 1 ELSE 0 END, etag = gen_random_uuid()::text, updated_at = NOW() WHERE id = $13 AND calendar_id = $14 AND user_id = $15 RETURNING id, calendar_id, uid, etag, summary, description, location, url, organizer, starts_at, ends_at, all_day, timezone, attendees, invite_account_id, invitation_sequence, created_at, updated_at`, [rawIcal, summary || null, description, location, url, organizer, times.startsAt, times.endsAt, Boolean(allDay), timezone, jsonbAttendees(normalizedAttendees), invitationAccount?.id || null, req.params.eventId, calendarId, req.session.userId]);
    if (!result.rows[0]) return { notFound: true };

    let delivered = null;
    if (invitationAccount) {
      try {
        // Keep the row lock until this REQUEST is emitted, so a later mutation
        // cannot overtake it with a higher sequence number.
        await sendCalendarInvitation({ account: invitationAccount, attendees: normalizedAttendees, summary, description, location, uid: existingEvent.uid, allDay: Boolean(allDay), method: 'REQUEST', sequence: result.rows[0].invitation_sequence, ...times });
        delivered = { status: 'sent', lastError: null };
      } catch (error) {
        delivered = { status: 'failed', lastError: error.message };
        console.error('Calendar invitation delivery failed:', error.message, error.code ? `(code ${error.code})` : '');
      }
    }
    return { event: result.rows[0], delivered };
  });
  if (outcome.cancelFailed) return res.status(502).json({ error: 'The previous invitation could not be cancelled, so the event was not changed.' });
  if (outcome.notFound || !outcome.event) return res.status(404).json({ error: 'Event not found' });

  res.json(invitationDeliveryResponse(outcome.event, outcome.delivered || { status: 'sent', lastError: null }));
});


router.delete('/events/:eventId', async (req, res) => {
  const calendarId = typeof req.query.calendarId === 'string' ? req.query.calendarId : null;
  if (!calendarId) return res.status(400).json({ error: 'calendarId is required' });

  const access = await writableCalendar(req.session.userId, calendarId);
  if (access.error) return res.status(access.status).json({ error: access.error });

  const outcome = await withTransaction(async client => {
    const existing = await client.query(`SELECT uid, raw_ical, ${READ_ATTENDEES}, invite_account_id, invitation_sequence, summary, description, location, starts_at, ends_at, all_day FROM calendar_events WHERE id = $1 AND calendar_id = $2 AND user_id = $3 FOR UPDATE`, [req.params.eventId, calendarId, req.session.userId]);
    const event = existing.rows[0];
    if (!event) return { notFound: true };

    if (event.invite_account_id && Array.isArray(event.attendees) && event.attendees.length) {
      try {
        // A disabled account retains SMTP settings for cancellation; referenced
        // sender accounts cannot be deleted because the FK is ON DELETE RESTRICT.
        const sender = await client.query('SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2 AND smtp_host IS NOT NULL', [event.invite_account_id, req.session.userId]);
        if (!sender.rows[0]) return { cancelFailed: true };
        await sendCalendarInvitation({ account: sender.rows[0], attendees: event.attendees, summary: event.summary, description: event.description, location: event.location, uid: event.uid, allDay: Boolean(event.all_day), method: 'CANCEL', sequence: Number(event.invitation_sequence || 0) + 1, startsAt: new Date(event.starts_at), endsAt: new Date(event.ends_at) });
      } catch (error) {
        console.error('Calendar invitation cancellation before deletion failed:', error.message);
        return { cancelFailed: true };
      }
    }

    const result = await client.query('DELETE FROM calendar_events WHERE id = $1 AND calendar_id = $2 AND user_id = $3 RETURNING id', [req.params.eventId, calendarId, req.session.userId]);
    return { deleted: Boolean(result.rows[0]) };
  });
  if (outcome.cancelFailed) return res.status(502).json({ error: 'The invitation could not be cancelled, so the event was not deleted.' });
  if (outcome.notFound || !outcome.deleted) return res.status(404).json({ error: 'Event not found' });

  res.status(204).end();
});

function publicSource(source) {
  const secretValues = source.url ? [source.url, decrypt(source.url)] : [];
  const lastError = typeof source.last_error === 'string'
    ? secretValues.filter(Boolean).reduce((error, secret) => error.replaceAll(secret, '[redacted]'), source.last_error)
    : source.last_error;
  return {
    id: source.id, kind: source.kind,
    displayName: source.display_name, color: source.color, intervalMin: source.interval_min,
    enabled: source.enabled, lastSyncAt: source.last_sync_at, lastError,
  };
}

router.get('/sources', async (req, res) => {
  const result = await query(
    `SELECT id, kind, url, username, display_name, color, interval_min, enabled, last_sync_at, last_error
     FROM calendar_import_sources WHERE user_id = $1 ORDER BY created_at ASC`, [req.session.userId],
  );
  res.json({ sources: result.rows.map(publicSource) });
});

router.post('/sources', async (req, res) => {
  const { kind, url, username, password, displayName, color = null, intervalMin = 60 } = req.body || {};
  if (!['caldav', 'ical_url'].includes(kind) || !url || !displayName) return res.status(400).json({ error: 'kind, url, and displayName are required' });
  if (kind === 'caldav' && (!username || !password)) return res.status(400).json({ error: 'CalDAV sources require username and password' });
  let parsed;
  try { parsed = new URL(url); } catch { return res.status(400).json({ error: 'Invalid source URL' }); }
  if (parsed.protocol === 'webcal:') parsed = new URL(url.replace(/^[^:]+:/, 'https:'));
  if (parsed.username || parsed.password) return res.status(400).json({ error: 'Source URL must not include credentials' });
  if (!['https:', 'http:'].includes(parsed.protocol)) return res.status(400).json({ error: 'Source URL must use http(s)' });
  const policy = await getConnectionPolicy();
  const hostError = await validateHost(parsed.hostname, { allowPrivate: policy.allowPrivateHosts });
  if (hostError) return res.status(400).json({ error: hostError });
  if (parsed.protocol === 'http:') {
    if (!policy.allowPrivateHosts) return res.status(400).json({ error: 'Source URL must use HTTPS' });
    const publicHostError = await validateHost(parsed.hostname, { allowPrivate: false });
    if (!publicHostError) return res.status(400).json({ error: 'HTTPS is required for a public source' });
  }
  const interval = Math.max(15, Math.min(1440, Number.parseInt(intervalMin, 10) || 60));
  try {
    const normalizedUrl = parsed.toString();
    const urlFingerprint = crypto.createHash('sha256').update(normalizedUrl).digest('hex');
    const result = await query(
      `INSERT INTO calendar_import_sources (user_id, kind, url, url_fingerprint, username, password, display_name, color, interval_min)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.session.userId, kind, encrypt(normalizedUrl), urlFingerprint, username || null, password ? encrypt(password) : null, displayName, color, interval],
    );
    const source = result.rows[0];
    scheduleCalendarSource(source);
    const sync = await syncCalendarSource(req.session.userId, source.id);
    if (!sync.ok) {
      // The sync records the failure asynchronously from the insert result;
      // reflect that terminal state in the response so the client can render
      // the persisted source as retryable immediately.
      source.last_error = sync.error;
      return res.status(502).json({ error: sync.error, source: publicSource(source), sync });
    }
    res.status(201).json({ source: publicSource(source), sync });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'A source with this URL already exists' });
    if (error.code === '23514') return res.status(409).json({ error: 'Calendar source URL could not be stored securely' });
    throw error;
  }
});

router.post('/sources/:sourceId/sync', async (req, res) => {
  const result = await syncCalendarSource(req.session.userId, req.params.sourceId);
  if (!result.ok && result.error === 'Calendar source not found') return res.status(404).json({ error: result.error });
  res.json(result);
});

// Change an existing source's cadence. The interval is a per-calendar setting, so it
// must be editable after creation and not only at creation time: how often a feed is
// worth polling depends on how often it changes, which the user learns over time.
router.patch('/sources/:sourceId', async (req, res) => {
  if (req.body?.intervalMin === undefined) return res.status(400).json({ error: 'intervalMin is required' });
  const interval = Number.parseInt(req.body.intervalMin, 10);
  // Same bounds as the CHECK constraint and the create route, rejected explicitly
  // rather than clamped so a bad client value is visible instead of silently ignored.
  if (!Number.isInteger(interval) || interval < 15 || interval > 1440) {
    return res.status(400).json({ error: 'intervalMin must be between 15 and 1440' });
  }
  const result = await query(
    `UPDATE calendar_import_sources SET interval_min = $1, updated_at = NOW()
     WHERE id = $2 AND user_id = $3 RETURNING *`,
    [interval, req.params.sourceId, req.session.userId],
  );
  const source = result.rows[0];
  if (!source) return res.status(404).json({ error: 'Calendar source not found' });
  // Re-arm the timer. The scheduler closes over the source row it was given, so without
  // this the new interval would not take effect until the process restarted.
  scheduleCalendarSource(source);
  res.json({ source: publicSource(source) });
});

router.delete('/sources/:sourceId', async (req, res) => {
  const existing = await query('SELECT * FROM calendar_import_sources WHERE id = $1 AND user_id = $2', [req.params.sourceId, req.session.userId]);
  if (!existing.rows[0]) return res.status(404).json({ error: 'Calendar source not found' });
  let sourceDeleted = false;
  try {
    await stopCalendarSource(req.params.sourceId);
    const result = await query('DELETE FROM calendar_import_sources WHERE id = $1 AND user_id = $2 RETURNING id', [req.params.sourceId, req.session.userId]);
    if (!result.rows[0]) {
      releaseCalendarSource(req.params.sourceId);
      return res.status(404).json({ error: 'Calendar source not found' });
    }
    sourceDeleted = true;
    await query('DELETE FROM calendars WHERE user_id = $1 AND owner_user_id = $1 AND external_url = $2', [req.session.userId, `source:${req.params.sourceId}`]);
    releaseCalendarSource(req.params.sourceId);
    res.status(204).end();
  } catch (error) {
    releaseCalendarSource(req.params.sourceId);
    if (!sourceDeleted) scheduleCalendarSource(existing.rows[0]);
    throw error;
  }
});

export default router;
