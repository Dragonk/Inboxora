import { calendarResources, mergeCalendarResource, rruleFromCalendarResource, setSeriesRecurrence, truncateSeriesBefore } from '../utils/calendarRecurrence.js';
import { parseRecurrenceStructure, recurrenceToRRule, recurrenceViewFromRRule, type ParsedRecurrence } from '../utils/calendarRecurrenceRule.js';
import { googleConfigFromEnv, isGoogleConfigured, isMicrosoftConfigured, microsoftConfigFromEnv } from '../services/providerAuthService.js';
import { syncGoogleCalendar } from '../services/providers/google/googleCalendarSync.js';
import { releaseCalendarChannelForCollection } from '../services/providerPushGoogle.js';
import { deleteCaldavEvent, putCaldavEvent } from '../services/providers/caldavWriteBack.js';
import { davWriteBackHttpStatus, type DavWriteBackRouteResult } from '../services/providers/davWriteBack.js';
import {
  writeProviderCalendarOccurrence,
  type OccurrenceScope,
} from '../services/providerCalendarOccurrences.js';
import { GoogleApiError } from '../services/providers/google/googleApiClient.js';
import { syncGraphCalendar } from '../services/providers/microsoft/graphCalendarSync.js';
import { GraphApiError } from '../services/providers/microsoft/graphApiClient.js';
import {
  graphEventIdForLocalRow,
  recordGraphCalendarEventLink,
  removeGraphCalendarEventLink,
  resolveCalendarWriteTarget,
  writeGraphCalendarEvent,
} from '../services/providerCalendarWrites.js';
import {
  googleEventIdForLocalRow,
  recordGoogleCalendarEventLink,
  removeGoogleCalendarEventLink,
  resolveGoogleCalendarWriteTarget,
  writeGoogleCalendarEvent,
} from '../services/providerGoogleWrites.js';
import type { GoogleCalendarWriteTarget } from '../services/providerGoogleWrites.js';
import type { AttachmentRef, EmailAccountRow } from '../services/imapManager.js';
import ICAL from 'ical.js';
import { parseInboundCalendarInvitation } from '../services/inboundCalendarInvitation.js';
import { parseCalendarEvent } from '../utils/ical.js';
import { descriptionContentLines, normalizeDescription } from '../utils/richText.js';
import { Router } from 'express';
import { providerIntegrationsEnabled } from '../services/providerSwitches.js';
import type { Request, Response } from 'express';
import crypto from 'crypto';
import { query, withTransaction } from '../services/db.js';
import { collectionIsWritable } from '../services/providerAccess.js';
import { requireAuth } from '../middleware/auth.js';
import { decrypt, encrypt } from '../services/encryption.js';
import { validateHost } from '../services/hostValidation.js';
import { getConnectionPolicy } from '../services/connectionPolicy.js';
import { releaseCalendarSource, scheduleCalendarSource, stopCalendarSource, syncCalendarSource } from '../services/externalCalendarSync.js';
import { sendCalendarInvitation } from '../services/calendarInvitation.js';
import { deliverStoredInvitation, invitationActionsForStorage, invitationDeliveryError, readInvitationDeliveryStatus } from '../services/calendarInvitationOutbox.js';
import { projectCalendarResources } from '../services/calendarProjectionPool.js';
import { EVENT_COLUMNS, coveragePredicate } from '../services/calendarOccurrences.js';
import { queryString, sessionUserId } from '../utils/query.js';
import { toAppError } from '../utils/errors.js';

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
/** Either the requested ids (null = all) or a validation error. */
type CalendarSelection = { ids: string[] | null; error: null } | { ids: null; error: string };

function parseCalendarSelection(raw: unknown): CalendarSelection {
  if (raw === undefined || raw === null) return { ids: null, error: null };
  const parts = (Array.isArray(raw) ? raw : [raw])
    .flatMap(value => String(value).split(','))
    .map(value => value.trim())
    .filter(Boolean);
  const ids: string[] = [];
  for (const id of parts) {
    if (id === CONTACT_CALENDAR_ID) { ids.push(id); continue; }
    if (!UUID_PATTERN.test(id)) return { ids: null, error: 'Invalid calendar id' };
    ids.push(id);
  }
  return { ids: [...new Set(ids)], error: null };
}

function parseEventTimes(body: Record<string, unknown> | null | undefined): { startsAt: Date; endsAt: Date } | null {
  const startsAt = new Date(String(body?.startsAt ?? ''));
  const endsAt = new Date(String(body?.endsAt ?? ''));
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) {
    return null;
  }
  return { startsAt, endsAt };
}

/** A calendar event row as the /events reads return it. */
type CalendarEventRow = {
  id: string;
  starts_at: Date | string;
  ends_at: Date | string;
  [key: string]: unknown;
};

/** A contact row carrying its date entries. */
type ContactDateRow = { id?: string; display_name?: string | null; primary_email?: string | null; contact_dates?: unknown; [key: string]: unknown };

function contactDateEvents(contacts: ContactDateRow[], from: Date, to: Date) {
  const events: Array<{ id: string; calendar_id: string; uid: string; summary: string; contact_date_label?: string | null; contact_name?: string | null; starts_at: Date; ends_at: Date; all_day: boolean; contact?: ContactDateRow; date?: { value?: unknown }; [key: string]: unknown }> = [];
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

/** Sort key for a stored or projected event; a missing start sorts as invalid, exactly as `new Date(undefined)` did. */
function eventStartTime(value: Date | string | undefined): number {
  return value === undefined ? Number.NaN : new Date(value).getTime();
}

function escapeICalendarText(value: unknown): string {
  return String(value || '')
    .replaceAll('\\', '\\\\')
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .replaceAll('\n', '\\n')
    .replaceAll(';', '\\;')
    .replaceAll(',', '\\,');
}

function formatICalendarDate(value: Date, allDay: boolean): string {
  const utc = value.toISOString();
  return allDay
    ? utc.slice(0, 10).replaceAll('-', '')
    : utc.replaceAll('-', '').replaceAll(':', '').replace('.000', '');
}

function foldICalendarLine(line: string) {
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

/** The rendered invitation fields `localEventIcal` turns into one VEVENT. */
type LocalEventIcalInput = {
  uid: string;
  summary?: string | null;
  description?: string | null;
  location?: string | null;
  url?: string | null;
  organizer?: string | null;
  attendees?: string[];
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  /** Server-rendered RRULE; never an unvalidated client string. */
  rrule?: string | null;
};

/** The values an invitation request carries, shared by the create and update paths. */
type InvitationFields = {
  calendarId: string;
  invitationAccount: EmailAccountRow;
  normalizedAttendees: string[];
  times: { startsAt: Date; endsAt: Date };
  summary?: string | null;
  description?: string | null;
  location?: string | null;
  url?: string | null;
  organizer?: string | null;
  allDay?: boolean | null;
  timezone?: string | null;
  /** Present only when the request asked to change the series rule; null clears it. */
  rrule?: string | null;
};

/** The outbox delivery result an invitation response reports. */
type InvitationDeliveryStatus = { status?: string | null; lastError?: string | null };

/** The message columns the invitation attachment fallback reads. */
type InvitationMessageRow = {
  account_id: string;
  uid: string | number;
  folder: string;
  attachments?: AttachmentRef[] | string | null;
  raw_ical?: string | null;
};

function localEventIcal({ uid, summary, description, location, url, organizer, attendees = [], startsAt, endsAt, allDay, rrule = null }: LocalEventIcalInput) {
  const dateParameter = allDay ? ';VALUE=DATE' : '';
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Inboxora//DAV Hub//EN', 'BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${formatICalendarDate(new Date(), false)}`, `DTSTART${dateParameter}:${formatICalendarDate(startsAt, allDay)}`, `DTEND${dateParameter}:${formatICalendarDate(endsAt, allDay)}`];
  if (summary) lines.push(`SUMMARY:${escapeICalendarText(summary)}`);
  lines.push(...descriptionContentLines(description, escapeICalendarText));
  if (location) lines.push(`LOCATION:${escapeICalendarText(location)}`);
  if (url) lines.push(`URL:${String(url).replace(/[\r\n]/g, '')}`);
  if (organizer) lines.push(`ORGANIZER:mailto:${escapeICalendarText(organizer.replace(/^mailto:/i, ''))}`);
  for (const email of attendees) lines.push(`ATTENDEE:mailto:${email}`);
  // The rule is built server-side from a validated structured input, so it never
  // carries client text; the CR/LF strip is a defensive last line.
  if (rrule) lines.push(`RRULE:${String(rrule).replace(/[\r\n]/g, '')}`);
  lines.push('END:VEVENT', 'END:VCALENDAR', '');
  return lines.map(foldICalendarLine).join('\r\n');
}

function normalizeAttendees(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const attendees = value.map(email => typeof email === 'string' ? email.trim().toLowerCase() : '').filter(Boolean);
  if (attendees.some(email => /[\r\n\0\s,;"<>]/.test(email) || !/^[^@]+@[^@]+\.[^@]+$/.test(email))) return null;
  return [...new Set(attendees)];
}

// `attendees` is a jsonb column. node-postgres serialises a JavaScript array as a
// PostgreSQL array literal (`{a@b.c}`), which jsonb rejects with
// "invalid input syntax for type json" — and an empty array silently becomes the
// jsonb OBJECT `{}`. Either way a plain array must never be bound directly.
function jsonbAttendees(value: unknown): string {
  return JSON.stringify(Array.isArray(value) ? value : []);
}

// Older rows may already hold `{}` because of the binding bug above. Read them
// back as an empty array and never call jsonb_array_length() on a non-array.
const ATTENDEES_IS_ARRAY = "jsonb_typeof(attendees) = 'array'";
// Reads must tolerate `{}` rows written before the binding fix; the CASE keeps
// jsonb_array_length() from ever seeing a non-array.
const READ_ATTENDEES = "CASE WHEN jsonb_typeof(attendees) = 'array' THEN attendees ELSE '[]'::jsonb END AS attendees";

function invitationOperationKey(req: Request): string {
  const supplied = req.headers['x-idempotency-key'];
  if (typeof supplied === 'string' && supplied.trim()) return supplied.trim().slice(0, 128);
  // Requests without a client retry key still use the durable outbox.
  return `server:${crypto.randomUUID()}`;
}

function invitationRequestFingerprint(req: Request, fields: InvitationFields) {
  const { calendarId, normalizedAttendees, times, summary, description, location, url, organizer, allDay, timezone, invitationAccount, rrule } = fields;
  return crypto.createHash('sha256').update(JSON.stringify({
    eventId: req.params.eventId || null, calendarId, summary: summary || null, description, location, url, organizer,
    allDay: Boolean(allDay), timezone, attendees: normalizedAttendees, inviteAccountId: invitationAccount?.id || null,
    startsAt: times.startsAt.toISOString(), endsAt: times.endsAt.toISOString(),
    // `undefined` means "keep the stored rule" and `null` means "clear it"; the
    // two must not share an idempotency fingerprint.
    rrule: rrule === undefined ? '<keep>' : rrule,
  })).digest('hex');
}

// The single response shape for anything that may have to deliver an invitation.
function invitationDeliveryResponse(event: unknown, delivery: InvitationDeliveryStatus | null | undefined, operation: { kind: 'cancellation'; outboxId: string } | null = null) {
  return {
    event,
    invitationStatus: { status: delivery?.status || 'pending', lastError: delivery?.lastError || null },
    ...(invitationDeliveryError(delivery) ? { invitationError: invitationDeliveryError(delivery) } : {}),
    ...(operation ? { invitationOperation: operation } : {}),
  };
}

async function updateInvitedEvent(req: Request, fields: InvitationFields) {
  const { calendarId, invitationAccount, normalizedAttendees, times, summary, description, location, url, organizer, allDay, timezone, rrule } = fields;
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
      ? (senderChanged ? existing.attendees : existing.attendees.filter((email: string) => !normalizedAttendees.includes(email)))
      : [];
    let cancellationAccount = null;
    if (cancelledAttendees.length) {
      cancellationAccount = invitationAccount.id === existing.invite_account_id
        ? invitationAccount
        : (await client.query<EmailAccountRow>('SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2 AND smtp_host IS NOT NULL', [existing.invite_account_id, req.session.userId])).rows[0] || null;
      if (!cancellationAccount) return { cancelFailed: true };
    }
    const mergedIcal = mergeCalendarResource(existing.raw_ical, localEventIcal({ uid: existing.uid, summary, description, location, url, organizer, attendees: normalizedAttendees, allDay: Boolean(allDay), ...times }));
    // `mergeCalendarResource` deliberately leaves RRULE alone (the DAV resource may
    // carry exceptions); a series-level edit applies the validated rule explicitly.
    const rawIcal = rrule === undefined ? mergedIcal : (setSeriesRecurrence(mergedIcal, rrule) ?? mergedIcal);
    const result = await client.query(`UPDATE calendar_events SET raw_ical = $1, summary = $2, description = $3, location = $4, url = $5, organizer = $6, starts_at = $7, ends_at = $8, all_day = $9, timezone = $10, attendees = $11, invite_account_id = $12, invitation_sequence = CASE WHEN (invite_account_id IS NOT NULL AND ${ATTENDEES_IS_ARRAY} AND jsonb_array_length(attendees) > 0) OR invitation_sequence > 0 THEN invitation_sequence + 1 ELSE 0 END, etag = gen_random_uuid()::text, updated_at = NOW() WHERE id = $13 AND calendar_id = $14 AND user_id = $15 RETURNING id, calendar_id, uid, etag, summary, description, location, url, organizer, starts_at, ends_at, all_day, timezone, attendees, invite_account_id, invitation_sequence, created_at, updated_at`, [rawIcal, summary || null, description, location, url, organizer, times.startsAt, times.endsAt, Boolean(allDay), timezone, jsonbAttendees(normalizedAttendees), invitationAccount.id, req.params.eventId, calendarId, req.session.userId]);
    const event = result.rows[0];
    const actions = [];
    if (cancelledAttendees.length) actions.push({ account: cancellationAccount, attendees: cancelledAttendees, summary: existing.summary, description: existing.description, location: existing.location, uid: existing.uid, allDay: Boolean(existing.all_day), method: 'CANCEL', sequence: Number(existing.invitation_sequence || 0) + 1, startsAt: new Date(existing.starts_at).toISOString(), endsAt: new Date(existing.ends_at).toISOString() });
    actions.push({ account: invitationAccount, attendees: normalizedAttendees, summary, description, location, uid: event.uid, allDay: Boolean(allDay), method: 'REQUEST', sequence: event.invitation_sequence, startsAt: times.startsAt.toISOString(), endsAt: times.endsAt.toISOString(), rrule });
    const outbox = await client.query('INSERT INTO calendar_invitation_outbox (user_id, event_id, idempotency_key, request_fingerprint, payload) VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING id', [req.session.userId, event.id, key, fingerprint, JSON.stringify({ actions: invitationActionsForStorage(actions) })]);
    return { event, outboxId: outbox.rows[0].id, actions };
  });
}

/**
 * Resolve which writer owns a calendar and whether it accepts a change.
 *
 * The answer comes from `resolveCalendarWriteTarget`, the same resolution the provider write paths use:
 * the capability model (adapter, conflict protection, the origin's permission and the user's write-back
 * choice) decides *whether*, and the returned target says *who*. A local calendar returns the local
 * target; a write-enabled provider collection returns the connection and the provider's own calendar id.
 *
 * The shared resolver owns the local and Microsoft branches. Google's write path lives in
 * `providerGoogleWrites.ts`, which is asked only when the shared resolver refused: it answers `google`
 * for a write-enabled Google collection and `not_google` for everything else, so every other refusal
 * (missing, read-only, an origin with no writer) is returned exactly as it was.
 */
type WritableCalendar =
  | { ok: false; status: number; error: string }
  | { ok: true; target: (ReturnType<typeof resolveCalendarWriteTarget> extends Promise<infer T> ? Exclude<T, { kind: 'refused' }> : never) | GoogleCalendarWriteTarget };

async function writableCalendar(userId: string, calendarId: string): Promise<WritableCalendar> {
  const target = await resolveCalendarWriteTarget(userId, calendarId);
  if (target.kind !== 'refused') return { ok: true, target };
  const google = await resolveGoogleCalendarWriteTarget(userId, calendarId);
  if (google.kind === 'google') return { ok: true, target: google };
  if (google.kind === 'refused') return { ok: false, status: google.status, error: google.error };
  return { ok: false, status: target.status, error: target.error };
}

/**
 * Report a provider write refusal with the shared vocabulary.
 *
 * `code` is what the interface switches on (`RESOURCE_NOT_FOUND`, `MUTATION_OUTCOME_UNKNOWN`, a
 * provider problem code) and `error` is the sentence it shows; neither provider invents its own shape.
 */
function providerWriteRefusal(res: Response, failure: { status: number; error: string; code?: string }): void {
  res.status(failure.status).json({
    ...(failure.code ? { code: failure.code } : {}),
    error: failure.error,
  });
}

/**
 * Answer a REST call with what the DAV source did.
 *
 * The same statuses the DAV handlers answer with (`davWriteBackHttpStatus`), because the web path and the DAV
 * path are writing to the same source and must not disagree about what a conflict or an unknown outcome is.
 */
function respondCaldavWriteBack(res: Response, result: DavWriteBackRouteResult, body: Record<string, unknown> = {}): void {
  if (result.retryAfterSeconds !== undefined) res.setHeader('Retry-After', String(result.retryAfterSeconds));
  const status = davWriteBackHttpStatus(result);
  if (status === 204 || status === 201) {
    res.status(status).json({ ok: true, created: result.created, ...body });
    return;
  }
  res.status(status).json({
    ...(result.code ? { code: result.code } : {}),
    error: status === 412
      ? 'The calendar changed at its source since you loaded it. Reload and try again.'
      : 'The calendar source refused this change.',
    ...body,
  });
}

/** A CalDAV collection the user enabled write-back for. */
type CaldavWriteTarget = Extract<
  Awaited<ReturnType<typeof resolveCalendarWriteTarget>>,
  { kind: 'caldav' }
>;

/**
 * Forward one local event resource to the external CalDAV source that owns the collection.
 *
 * The write-back client commits the local projection itself, only after the source confirms, so the caller
 * must not also write the row: the projection and the source's answer are the same fact, and doing both would
 * mean two writers for one event.
 */
async function writeCaldavEventResource(input: {
  userId: string;
  target: CaldavWriteTarget;
  method: 'PUT' | 'DELETE';
  filename: string;
  uid: string;
  raw: string;
  exists: boolean;
  localObjectId: string | null;
  localRevision: string | null;
}): Promise<DavWriteBackRouteResult> {
  const calendar = { id: input.target.calendarId, external_url: input.target.externalUrl, source: 'caldav' };
  if (input.method === 'DELETE') {
    return await deleteCaldavEvent({
      method: 'DELETE', userId: input.userId, calendar, filename: input.filename, uid: input.uid,
      raw: '', parsed: null, exists: input.exists, localObjectId: input.localObjectId, localRevision: input.localRevision,
    });
  }
  const parsed = parseCalendarEvent(input.raw);
  if (!parsed) {
    return { status: 'permanent', created: false, code: 'INVALID_REQUEST' };
  }
  return await putCaldavEvent({
    method: 'PUT', userId: input.userId, calendar, filename: input.filename, uid: input.uid,
    raw: input.raw, parsed, exists: input.exists, localObjectId: input.localObjectId, localRevision: input.localRevision,
  });
}

/** The stored event a CalDAV write needs: its identity, its resource text and its entity-tag. */
async function readCaldavEventRow(userId: string, calendarId: string, eventId: string) {
  const result = await query<{ id: string; uid: string; raw_ical: string; etag: string; dav_filename: string | null }>(
    'SELECT id, uid, raw_ical, etag, dav_filename FROM calendar_events WHERE id = $1 AND calendar_id = $2 AND user_id = $3',
    [eventId, calendarId, userId],
  );
  return result.rows[0] ?? null;
}

async function contactCalendarAppearance(userId: string): Promise<{ name?: string | null; color?: string | null; [key: string]: unknown }> {
  const result = await query<{ appearance?: { name?: string | null; color?: string | null; [key: string]: unknown } | null }>("SELECT preferences->'calendarContactAppearance' AS appearance FROM users WHERE id = $1", [userId]);
  return result?.rows?.[0]?.appearance || {};
}

// Fetch the raw .ics MIME part of a message. Extracted so the reader can fall back
// to it whenever the invitation captured during sync is missing or unusable.
async function fetchInvitationAttachment(row: InvitationMessageRow, userId: string) {
  const attachments: AttachmentRef[] = typeof row.attachments === 'string' ? JSON.parse(row.attachments) : row.attachments || [];
  const candidates = attachments.filter(item => /^(text\/calendar|application\/(ics|ical|calendar))$/i.test(item.type || '') || /\.ics$/i.test(item.filename || ''));
  if (candidates.length !== 1 || Number(candidates[0].size) > 1024 * 1024) return null;
  const account = await query<EmailAccountRow>('SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2', [row.account_id, userId]);
  if (!account.rows[0]) return null;
  const { imapManager } = await import('../index.js');
  let data;
  try {
    data = await imapManager.fetchAttachment(account.rows[0], row.uid, row.folder, candidates[0].part);
  } catch (caught) {
    const error = toAppError(caught);
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

async function readMessageInvitation(messageId: string, userId: string) {
  const result = await query<InvitationMessageRow>(`SELECT i.raw_ical, m.account_id, m.uid, m.folder, m.attachments
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
async function importedEventForMessage(messageId: string, userId: string) {
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
  const invitation = await readMessageInvitation(req.params.messageId, sessionUserId(req));
  if (!invitation) return res.status(404).json({ error: 'Calendar invitation not found' });
  const { raw, event, ...metadata } = invitation;
  void raw;
  const localEvent = await importedEventForMessage(req.params.messageId, sessionUserId(req));
  res.json({ invitation: { ...metadata, localEvent, description: event?.description, location: event?.location, url: event?.url, attendees: event?.attendees || [] } });
});

// Remove the copy this message's invitation was added as. This is what makes a
// cancellation actionable: an organizer retracting an invitation should leave the
// calendar in the state it would have been in had the invitation never been accepted.
router.delete('/invitations/:messageId', async (req, res) => {
  const invitation = await readMessageInvitation(req.params.messageId, sessionUserId(req));
  if (!invitation) return res.status(404).json({ error: 'Calendar invitation not found' });
  const localEvent = await importedEventForMessage(req.params.messageId, sessionUserId(req));
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
  const access = await writableCalendar(sessionUserId(req), req.body.calendarId);
  if (!access.ok) return res.status(access.status).json({ error: access.error });
  if (access.target.kind !== 'local') {
    // A provider calendar's events live at the provider. Adding the invitation only locally would put an
    // event in Inboxora that no other client can see and that the provider never agreed to, so the write
    // is refused with a reason instead of being accepted and then silently discarded.
    return res.status(501).json({
      code: 'OPERATION_FORBIDDEN',
      error: 'Adding an invitation to a provider calendar is not available yet. Accept it in the provider and let it sync.',
    });
  }
  const invitation = await readMessageInvitation(req.params.messageId, sessionUserId(req));
  if (!invitation) return res.status(404).json({ error: 'Calendar invitation not found' });
  if (invitation.method !== 'REQUEST' || !invitation.event) return res.status(409).json({ error: 'This invitation cannot be added' });
  const event = invitation.event;
  // Scope copies by organizer as well as UID; never overwrite an unrelated local event.
  const uid = `mail-${crypto.createHash('sha256').update(JSON.stringify([invitation.uid, invitation.organizer, invitation.recurrenceId])).digest('hex')}`;
  const component = new ICAL.Component(ICAL.parse(event.raw));
  component.removeAllProperties('method');
  component.getAllSubcomponents('vevent')[0].updatePropertyWithValue('uid', uid);
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
    // `collection_id` is what the write-back opt-in is addressed by: a pulled calendar is written through
    // its collection, and the interface needs the id to offer the switch.
    `SELECT c.id, c.name, c.description, c.color, c.source, c.external_url, c.read_only, c.display_visible,
            c.owner_user_id, c.sync_token, c.created_at, c.updated_at, c.dav_mode, ic.id AS collection_id
       FROM calendars c
       LEFT JOIN integration_collections ic ON ic.local_calendar_id = c.id AND ic.kind = 'calendar' AND ic.user_id = c.user_id
      WHERE c.user_id = $1 AND c.owner_user_id = $1
      ORDER BY c.created_at ASC`,
    [req.session.userId],
  );
  const appearance = await contactCalendarAppearance(sessionUserId(req));
  res.json({ calendars: [...result.rows, {
    id: 'contacts-birthdays', name: appearance.name || 'Contact dates', custom_name: Boolean(appearance.name), description: 'Birthdays and anniversaries from contacts',
    color: appearance.color || '#e879f9', source: 'contacts', external_url: null, read_only: true, display_visible: appearance.displayVisible !== false, dav_mode: 'off',
  }] });
});

function calendarName(value: unknown): string | null {
  const name = typeof value === 'string' ? value.trim() : '';
  return name && name.length <= 120 ? name : null;
}

function calendarColor(value: unknown): string | null | undefined {
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
       RETURNING id, user_id, owner_user_id, name, description, color, source, external_url, read_only, display_visible, sync_token, created_at, updated_at, dav_mode`,
      [req.session.userId, name, color, displayVisible],
    );
    return res.status(201).json({ calendar: result.rows[0] });
  } catch (caught) {
    const error = toAppError(caught);
    if (error.code === '23505') return res.status(409).json({ error: 'A calendar with that name already exists' });
    throw error;
  }
});

router.patch('/calendars/:calendarId', async (req, res) => {
  const name = calendarName(req.body?.name);
  const color = calendarColor(req.body?.color);
  const displayVisible = req.body?.displayVisible;
  const davMode = req.body?.davMode;
  if (!name || color === undefined || typeof displayVisible !== 'boolean') {
    return res.status(400).json({ error: 'name, a hex color, and displayVisible are required' });
  }
  if (davMode !== undefined && davMode !== null && davMode !== 'off' && davMode !== 'read_only' && davMode !== 'read_write') {
    return res.status(400).json({ error: 'davMode must be off, read_only or read_write' });
  }
  if (req.params.calendarId === 'contacts-birthdays') {
    if (davMode !== undefined && davMode !== null) {
      // The synthetic contact-date calendar is read-only and never DAV-exported.
      return res.status(400).json({ error: 'The contact dates calendar cannot be shared over DAV' });
    }
    const customName = req.body.customName === false ? null : name;
    await query(
      "UPDATE users SET preferences = COALESCE(preferences, '{}'::jsonb) || jsonb_build_object('calendarContactAppearance', $2::jsonb) WHERE id = $1",
      [req.session.userId, JSON.stringify({ name: customName, color, displayVisible })],
    );
    return res.json({ calendar: { id: 'contacts-birthdays', name: customName || 'Contact dates', custom_name: Boolean(customName), color, display_visible: displayVisible, source: 'contacts', read_only: true, dav_mode: 'off' } });
  }
  try {
    const result = await query(
      `UPDATE calendars
       SET name = $1, color = $2, display_visible = $3, dav_mode = COALESCE($4, dav_mode), updated_at = NOW()
       WHERE id = $5 AND owner_user_id = $6 AND user_id = $6
       RETURNING id, user_id, owner_user_id, name, description, color, source, external_url, read_only, display_visible, sync_token, created_at, updated_at, dav_mode`,
      [name, color, displayVisible, davMode ?? null, req.params.calendarId, req.session.userId],
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Calendar not found' });
    return res.json({ calendar: result.rows[0] });
  } catch (caught) {
    const error = toAppError(caught);
    if (error.code === '23505') return res.status(409).json({ error: 'A calendar with that name already exists' });
    throw error;
  }
});

router.delete('/calendars/:calendarId', async (req, res) => {
  const confirmName = calendarName(req.body?.confirmName);
  if (!confirmName) return res.status(400).json({ error: 'confirmName is required' });
  // The capability model decides whether the calendar may be removed at all; the
  // DELETE that follows is scoped to the same owner and confirmed name, so the
  // decision cannot be raced into a different row.
  const current = await query(
    `SELECT id, source, read_only FROM calendars
     WHERE id = $1 AND owner_user_id = $2 AND user_id = $2 AND name = $3`,
    [req.params.calendarId, req.session.userId, confirmName],
  );
  const candidate = current.rows[0];
  if (!candidate || !collectionIsWritable(candidate, 'calendars')) return res.status(404).json({ error: 'Calendar not found' });
  // Stop the calendar's push channel before the collection row goes: the row's foreign key would remove the
  // subscription record without telling Google, leaving a channel pushing at an endpoint that no longer
  // recognises it. Best effort — the removal must not fail because Google is unreachable. A local calendar has
  // no collection and no channel, so the lookup only happens for a provider-backed one.
  const collection = candidate.source && candidate.source !== 'local'
    ? await query<{ id: string }>(
      'SELECT id FROM integration_collections WHERE local_calendar_id = $1 AND user_id = $2',
      [req.params.calendarId, req.session.userId],
    )
    : { rows: [] as Array<{ id: string }> };
  if (collection.rows[0]) {
    await releaseCalendarChannelForCollection({
      userId: req.session.userId!,
      collectionId: collection.rows[0].id,
    }).catch(error => console.warn('Calendar push channel cleanup failed:', error instanceof Error ? error.message : error));
  }
  const result = await query(
    `DELETE FROM calendars
     WHERE id = $1 AND owner_user_id = $2 AND user_id = $2 AND name = $3
     RETURNING id`,
    [req.params.calendarId, req.session.userId, confirmName],
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Calendar not found' });
  res.status(204).end();
});

router.get('/events', async (req, res) => {
  const from = new Date(queryString(req.query.from) ?? '');
  const to = new Date(queryString(req.query.to) ?? '');
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
  let materializedRows: CalendarEventRow[] = [];
  let eventRows: CalendarEventRow[] = [];
  if (selectedIds === null || selectedIds.length > 0) {
    const params: unknown[] = [req.session.userId, from, to];
    let calendarFilter = '';
    if (selectedIds !== null) { params.push(selectedIds); calendarFilter = ' AND c.id = ANY($4::uuid[])'; }
    // Materialised occurrences: a plain indexed range scan, with no recurrence expansion at
    // all. Any event whose stored rows are missing, stale, or do not cover this window is
    // excluded here and picked up by the fallback query below, so this read can never be the
    // reason an event is missing — only the reason it appears fast.
    const result = await query<CalendarEventRow>(
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
              e.calendar_id, e.uid, e.etag, e.invite_account_id, e.invitation_sequence, e.cancellation_outbox_id,
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
    const fallback = await query<CalendarEventRow>(
      `SELECT ${EVENT_COLUMNS},
              CASE WHEN sa.id IS NOT NULL THEN e.source_message_id END AS source_message_id,
              sm.folder AS source_folder,
              sa.id AS source_account_id,
              c.name AS calendar_name, c.color AS calendar_color, c.source, c.read_only
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
  let contactEvents: Array<{ starts_at: Date; ends_at: Date; [key: string]: unknown }> = [];
  if (includeContacts) {
    // Both reads only need the same user id, so they run together rather than one after
    // the other — the contact calendar is on by default, so this is on the common path.
    const [contactResult, appearance] = await Promise.all([
      query(
        'SELECT id, display_name, primary_email, birthday, anniversary, contact_dates FROM contacts WHERE user_id = $1 AND (birthday IS NOT NULL OR anniversary IS NOT NULL OR (jsonb_typeof(contact_dates) = \'array\' AND jsonb_array_length(contact_dates) > 0))',
        [req.session.userId],
      ),
      contactCalendarAppearance(sessionUserId(req)),
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
    .sort((left, right) => eventStartTime(left.starts_at) - eventStartTime(right.starts_at));
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
  // The rule is rendered server-side from a validated structure; a bad rule is a
  // validation error, never a half-created series.
  const recurrenceParse = parseRecurrenceStructure((req.body || {}).recurrence, { allDay: Boolean(allDay) });
  if (!recurrenceParse.ok) return res.status(400).json({ error: recurrenceParse.error });
  // One validated structure, two renderings: the iCalendar RRULE the local resource stores and the
  // Graph pattern/range the provider write sends.
  const recurrence = recurrenceParse.recurrence;
  const rrule = recurrenceToRRule(recurrence);

  const access = await writableCalendar(sessionUserId(req), calendarId);
  if (!access.ok) return res.status(access.status).json({ error: access.error });
  const target = access.target;

  // A provider-backed calendar is written at the provider **first**. Microsoft notifies attendees itself
  // when an event carries them, and Google does when `sendUpdates` asks it to, so Inboxora's own
  // invitation mail is skipped on this path rather than sending a second copy.
  let providerEvent: { providerEventId: string; uid: string } | null = null;
  const providerIdempotencyKey = typeof req.headers['x-idempotency-key'] === 'string' ? req.headers['x-idempotency-key'].slice(0, 128) : null;
  const eventWrite = {
    summary: summary || null, description, location, url, startsAt: times.startsAt, endsAt: times.endsAt,
    allDay: Boolean(allDay), attendees: normalizedAttendees,
    // A create has nothing to clear: a missing rule is an **absent** field, not an explicit clear.
    ...(recurrence ? { recurrence } : {}),
  };
  if (target.kind === 'graph') {
    const attempt = await writeGraphCalendarEvent({
      userId: req.session.userId!,
      target,
      operation: 'create',
      idempotencyKey: providerIdempotencyKey,
      event: eventWrite,
    });
    if (attempt.status === 'failed') return providerWriteRefusal(res, attempt.failure);
    providerEvent = {
      providerEventId: attempt.providerEventId,
      // The provider's own iCalUId keeps the local resource, the DAV view and the next sync on one identity.
      uid: attempt.event?.iCalUId?.trim() || `msgrap-${attempt.providerEventId}`,
    };
  } else if (target.kind === 'google') {
    // Google sends the invitation from this one call when the user asked for it; with `none` it sends
    // nothing, so the choice is stated rather than left to Google's default.
    const attempt = await writeGoogleCalendarEvent({
      userId: req.session.userId!,
      target,
      operation: 'create',
      idempotencyKey: providerIdempotencyKey,
      event: eventWrite,
      sendUpdates: sendInvites ? 'all' : 'none',
    });
    if (attempt.status === 'failed') return providerWriteRefusal(res, attempt.failure);
    // Same identity rule as the read path uses for an event without an iCalUID.
    providerEvent = {
      providerEventId: attempt.providerEventId,
      uid: attempt.event?.iCalUID?.trim() || `${attempt.providerEventId}@google.com`,
    };
  }
  if (target.kind === 'caldav') {
    // The source owns the collection, so it is written first and the projection follows from that answer.
    const caldavUid = crypto.randomUUID();
    const caldavRaw = localEventIcal({ uid: caldavUid, summary, description, location, url, organizer, attendees: normalizedAttendees, allDay: Boolean(allDay), ...times, rrule });
    const written = await writeCaldavEventResource({
      userId: req.session.userId!, target, method: 'PUT', filename: `${caldavUid}.ics`, uid: caldavUid,
      raw: caldavRaw, exists: false, localObjectId: null, localRevision: null,
    });
    if (written.status !== 'confirmed') return respondCaldavWriteBack(res, written);

    const stored = await query<{ id: string }>(
      'SELECT id FROM calendar_events WHERE calendar_id = $1 AND uid = $2 AND user_id = $3',
      [calendarId, caldavUid, req.session.userId],
    );
    // Invitations are Inboxora's on this path: a plain CalDAV server is not a scheduling service, so the
    // organiser's own mail client behaviour is reproduced here rather than assumed.
    if (sendInvites && normalizedAttendees.length) {
      const sender = await query<EmailAccountRow>(
        'SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2 AND enabled = true AND smtp_host IS NOT NULL',
        [inviteAccountId, req.session.userId],
      );
      if (!sender.rows[0]) return res.status(400).json({ error: 'The selected sender account is unavailable' });
      try {
        await sendCalendarInvitation({
          account: sender.rows[0], attendees: normalizedAttendees, summary: summary || null, description,
          location, uid: caldavUid, startsAt: times.startsAt, endsAt: times.endsAt, allDay: Boolean(allDay),
          method: 'REQUEST', sequence: 0, rrule,
        });
      } catch (caught) {
        console.error('Calendar invitation delivery failed:', toAppError(caught).message);
        return res.status(201).json({ event: { id: stored.rows[0]?.id ?? null }, invitationError: 'The event was saved, but the invitation could not be sent.' });
      }
    }
    return res.status(201).json({ event: { id: stored.rows[0]?.id ?? null } });
  }

  const invitesHandledByProvider = target.kind !== 'local';

  let invitationAccount = null;
  if (sendInvites && !invitesHandledByProvider) {
    const sender = await query<EmailAccountRow>(
      'SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2 AND enabled = true AND smtp_host IS NOT NULL',
      [inviteAccountId, req.session.userId],
    );
    invitationAccount = sender.rows[0] || null;
    if (!invitationAccount) return res.status(400).json({ error: 'The selected sender account is unavailable' });
  }

  if (sendInvites && !invitesHandledByProvider && invitationAccount) {
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
      const rawIcal = localEventIcal({ uid, summary, description, location, url, organizer, attendees: normalizedAttendees, allDay: Boolean(allDay), ...times, rrule });
      const result = await client.query(
        `INSERT INTO calendar_events (calendar_id, user_id, uid, raw_ical, summary, description, location, url, organizer, starts_at, ends_at, all_day, timezone, attendees, invite_account_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING id, calendar_id, uid, etag, summary, description, location, url, organizer, starts_at, ends_at, all_day, timezone, attendees, invite_account_id, invitation_sequence, created_at, updated_at`,
        [calendarId, req.session.userId, uid, rawIcal, summary || null, description, location, url, organizer, times.startsAt, times.endsAt, Boolean(allDay), timezone, jsonbAttendees(normalizedAttendees), invitationAccount.id],
      );
      const event = result.rows[0];
      const outbox = await client.query(
        `INSERT INTO calendar_invitation_outbox (user_id, event_id, idempotency_key, request_fingerprint, payload) VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING id`,
        [req.session.userId, event.id, idempotencyKey, fingerprint, JSON.stringify({ actions: invitationActionsForStorage([{ account: invitationAccount, attendees: normalizedAttendees, summary, description, location, uid, allDay: Boolean(allDay), method: 'REQUEST', sequence: event.invitation_sequence ?? 0, startsAt: times.startsAt.toISOString(), endsAt: times.endsAt.toISOString(), rrule }]) })],
      );
        return { event, outboxId: outbox.rows[0].id };
      });
    } catch (caught) {
      const error = toAppError(caught);
      console.error('Calendar invitation transaction failed:', error.message, error.code ? `(code ${error.code})` : '');
      return res.status(500).json({ error: 'The event and invitation could not be saved; no partial changes were kept.' });
    }
    if (outcome.conflict) return res.status(409).json({ error: 'The idempotency key was already used for a different calendar operation' });
    if (outcome.duplicate) {
      if (outcome.delivered) return res.status(201).json(invitationDeliveryResponse(outcome.event, outcome.delivered));
      // Same request, same key, invitation not delivered yet: resend it now rather
      // than replaying the stale error. The account is resolved from the payload.
      const delivered = await deliverStoredInvitation({ outboxId: outcome.outboxId, userId: req.session.userId });
      return res.status(201).json(invitationDeliveryResponse(outcome.event, delivered));
    }
    const delivered = await deliverStoredInvitation({ outboxId: outcome.outboxId, userId: req.session.userId });
    return res.status(201).json(invitationDeliveryResponse(outcome.event, delivered));
  }

  const uid = providerEvent?.uid ?? crypto.randomUUID();
  const rawIcal = localEventIcal({ uid, summary, description, location, url, organizer, attendees: normalizedAttendees, allDay: Boolean(allDay), ...times, rrule });
  const result = await query<{ id: string; calendar_id: string; uid: string; etag?: string | null; summary?: string | null; description?: string | null; location?: string | null; url?: string | null; organizer?: string | null; starts_at?: string | Date | null; ends_at?: string | Date | null; all_day?: boolean | null; timezone?: string | null; attendees?: unknown; invite_account_id?: string | null; invitation_sequence?: number | null; created_at?: string | Date | null }>(
    `INSERT INTO calendar_events (
       calendar_id, user_id, uid, raw_ical, summary, description, location, url, organizer,
       starts_at, ends_at, all_day, timezone, attendees, invite_account_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING id, calendar_id, uid, etag, summary, description, location, url, organizer,
               starts_at, ends_at, all_day, timezone, attendees, invite_account_id, invitation_sequence, created_at, updated_at`,
    [calendarId, req.session.userId, uid, rawIcal, summary || null, description, location, url, organizer, times.startsAt, times.endsAt, Boolean(allDay), timezone, jsonbAttendees(normalizedAttendees), invitationAccount?.id || null],
  );
  if (providerEvent) {
    // The link is recorded after the local row exists, so the next delta updates this row instead of
    // inserting a second copy of the event.
    if (target.kind === 'graph') {
      await recordGraphCalendarEventLink({
        userId: req.session.userId!,
        target,
        providerEventId: providerEvent.providerEventId,
        localId: result.rows[0].id,
      });
    } else if (target.kind === 'google') {
      await recordGoogleCalendarEventLink({
        userId: req.session.userId!,
        target,
        providerEventId: providerEvent.providerEventId,
        localId: result.rows[0].id,
      });
    }
  }
  let invitationError = null;
  if (invitationAccount) {
    try {
      await sendCalendarInvitation({ account: invitationAccount, attendees: normalizedAttendees, summary, description, location, uid, allDay: Boolean(allDay), method: 'REQUEST', sequence: result.rows[0].invitation_sequence ?? 0, ...times, rrule });
    } catch (caught) {
      const error = toAppError(caught);
      invitationError = 'The event was saved, but the invitation could not be sent.';
      console.error('Calendar invitation delivery failed:', error.message);
    }
  }
  res.status(201).json({ event: result.rows[0], ...(invitationError ? { invitationError } : {}) });
});


/**
 * Change or cancel one occurrence (or the rest of a series) in a provider calendar.
 *
 * The provider is written first and must confirm: the local projection is produced afterwards by the
 * collection's own sync, so a scoped change is rendered by the same code the next scheduled run uses and a
 * change the provider refused cannot look saved locally. A sync that fails here is reported, not hidden —
 * the provider holds the change and the next run projects it.
 *
 * Notifications are the provider's on this path (`sendUpdates: 'all'` for Google; Graph notifies its own
 * attendees), so no duplicate invitation is sent by Inboxora.
 */
/** The values one occurrence-scoped request carries, parsed once for both the provider and local paths. */
interface OccurrenceRequestValues {
  cancel: boolean;
  times: { startsAt: Date; endsAt: Date } | null;
  attendees: string[] | null;
  summary: string | null;
  description: string | null;
  location: string | null;
  url: string | null;
  organizer: string | null;
  allDay: boolean;
  timezone: string | null;
  recurrenceProvided: boolean;
  recurrence: ParsedRecurrence | null;
}

/**
 * Change or cancel one occurrence (or the rest of a series) in a provider calendar.
 *
 * The provider is written first and must confirm: the local projection is produced afterwards by the
 * collection's own sync, so a scoped change is rendered by the same code the next scheduled run uses and a
 * change the provider refused cannot look saved locally. A sync that fails here is reported, not hidden —
 * the provider holds the change and the next run projects it.
 *
 * Notifications are the provider's on this path (`sendUpdates: 'all'` for Google; Graph notifies its own
 * attendees), so Inboxora sends no duplicate invitation.
 */
async function handleProviderOccurrence(
  req: Request,
  res: Response,
  input: {
    calendarId: string;
    recurrenceId: string;
    scope: OccurrenceScope;
    values: OccurrenceRequestValues;
    /** Either provider target: both carry the same four fields the write needs. */
    target: { kind: 'graph' | 'google'; connectionId: string; collectionId: string; providerCalendarId: string; calendarId: string };
  },
) {
  const userId = sessionUserId(req)!;
  const localEventId = String(req.params.eventId);
  const providerEventId = input.target.kind === 'graph'
    ? await graphEventIdForLocalRow(userId, input.target.collectionId, localEventId)
    : await googleEventIdForLocalRow(userId, input.target.collectionId, localEventId);
  if (!providerEventId) return res.status(409).json({ error: 'This event is not linked to its provider copy yet' });

  // The occurrence's own start and all-day flag come from the stored row; the endpoint's `recurrenceId` is
  // the `RECURRENCE-ID` the provider's instance carries as its original start.
  const stored = await query<{ uid: string; all_day: boolean | null }>(
    'SELECT uid, all_day FROM calendar_events WHERE id = $1 AND calendar_id = $2 AND user_id = $3',
    [localEventId, input.calendarId, userId],
  );
  if (!stored.rows[0]) return res.status(404).json({ error: 'Event not found' });

  const outcome = await writeProviderCalendarOccurrence({
    target: {
      kind: input.target.kind,
      userId,
      connectionId: input.target.connectionId,
      collectionId: input.target.collectionId,
      providerCalendarId: input.target.providerCalendarId,
      calendarId: input.target.calendarId,
      localEventId,
      masterProviderId: providerEventId,
      occurrenceStart: input.recurrenceId,
      allDay: stored.rows[0].all_day === true,
    },
    scope: input.scope,
    operation: input.values.cancel ? 'cancel' : 'update',
    ...(input.values.cancel ? {} : {
      values: {
        summary: input.values.summary,
        description: input.values.description,
        location: input.values.location,
        url: input.values.url,
        startsAt: input.values.times!.startsAt,
        endsAt: input.values.times!.endsAt,
        allDay: input.values.allDay,
        attendees: input.values.attendees!,
        ...(input.values.recurrenceProvided ? { recurrence: input.values.recurrence } : {}),
      },
    }),
    sendUpdates: 'all',
  });
  if (outcome.status !== 'confirmed') return providerWriteRefusal(res, outcome.failure);

  let synced = false;
  try {
    if (input.target.kind === 'graph') {
      await syncGraphCalendar({ userId, connectionId: input.target.connectionId, config: microsoftConfigFromEnv() });
    } else {
      await syncGoogleCalendar({ userId, connectionId: input.target.connectionId, config: googleConfigFromEnv() });
    }
    synced = true;
  } catch (caught) {
    // The provider accepted the change; the projection arrives on the next run, so this is reported rather
    // than turned into a failure the user would read as "not saved".
    console.error('Calendar projection after a scoped occurrence change failed:', toAppError(caught).message);
  }
  return res.json({
    updated: true,
    scope: input.scope,
    providerEventId: outcome.providerOccurrenceId,
    ...(outcome.createdSeriesId ? { createdSeriesId: outcome.createdSeriesId } : {}),
    synced,
  });
}

/**
 * Change or cancel one occurrence (or the rest of a series) in an external CalDAV collection.
 *
 * The same three scopes the provider path implements, expressed in the resource the source understands: a
 * single-occurrence change is the master with one override merged in, "this and following" is the master
 * truncated (and, for an edit, a new resource for the remainder). Each write is forwarded through the DAV
 * write-back client, which commits the local projection only after the source confirms.
 */
async function handleCaldavOccurrence(
  req: Request,
  res: Response,
  input: { calendarId: string; recurrenceId: string; scope: OccurrenceScope; values: OccurrenceRequestValues; target: CaldavWriteTarget },
) {
  const existing = await readCaldavEventRow(sessionUserId(req)!, input.calendarId, String(req.params.eventId));
  if (!existing) return res.status(404).json({ error: 'Event not found' });
  const { values } = input;
  const filename = existing.dav_filename ?? `${existing.uid}.ics`;

  if (input.scope === 'single') {
    // A cancellation is the occurrence's own component with a cancelled status; the merge below keeps it as an
    // override of the master rather than replacing the series.
    const master = parseCalendarEvent(existing.raw_ical);
    const replacement = localEventIcal(
      values.cancel
        ? {
          uid: existing.uid, summary: master?.summary ?? null, description: master?.description ?? null,
          location: master?.location ?? null, url: master?.url ?? null, organizer: master?.organizer ?? null,
          attendees: master?.attendees ?? [], allDay: master?.allDay ?? values.allDay,
          startsAt: master?.startsAt ?? new Date(), endsAt: master?.endsAt ?? new Date(),
        }
        : {
          uid: existing.uid, summary: values.summary, description: values.description, location: values.location,
          url: values.url, organizer: values.organizer, attendees: values.attendees!, allDay: values.allDay,
          ...values.times!,
        },
    );
    const raw = mergeCalendarResource(existing.raw_ical, replacement, input.recurrenceId, values.cancel);
    const written = await writeCaldavEventResource({
      userId: sessionUserId(req)!, target: input.target, method: 'PUT', filename, uid: existing.uid, raw,
      exists: true, localObjectId: existing.id, localRevision: existing.etag,
    });
    if (written.status !== 'confirmed') return respondCaldavWriteBack(res, written);
    return res.json({ updated: true, scope: 'single' });
  }

  const truncated = truncateSeriesBefore(existing.raw_ical, input.recurrenceId);
  if (!truncated) return res.status(409).json({ error: 'This occurrence is not part of the stored series' });
  if (truncated.empty) {
    const written = await writeCaldavEventResource({
      userId: sessionUserId(req)!, target: input.target, method: 'DELETE', filename, uid: existing.uid, raw: '',
      exists: true, localObjectId: existing.id, localRevision: existing.etag,
    });
    if (written.status !== 'confirmed') return respondCaldavWriteBack(res, written);
    return res.json({ updated: true, scope: 'following' });
  }
  if (values.cancel) {
    const written = await writeCaldavEventResource({
      userId: sessionUserId(req)!, target: input.target, method: 'PUT', filename, uid: existing.uid,
      raw: truncated.raw, exists: true, localObjectId: existing.id, localRevision: existing.etag,
    });
    if (written.status !== 'confirmed') return respondCaldavWriteBack(res, written);
    return res.json({ updated: true, scope: 'following' });
  }

  // An edit: the earlier part keeps its occurrences, the remainder becomes its own resource at the source.
  const remainderRrule = values.recurrenceProvided ? recurrenceToRRule(values.recurrence) : rruleFromCalendarResource(existing.raw_ical);
  const remainderUid = `${existing.uid}#${input.recurrenceId.replace(/[^0-9A-Za-z]/g, '')}`;
  const remainderRaw = localEventIcal({
    uid: remainderUid, summary: values.summary, description: values.description, location: values.location,
    url: values.url, organizer: values.organizer, attendees: values.attendees!, allDay: values.allDay,
    ...values.times!, rrule: remainderRrule,
  });
  const truncatedWrite = await writeCaldavEventResource({
    userId: sessionUserId(req)!, target: input.target, method: 'PUT', filename, uid: existing.uid,
    raw: truncated.raw, exists: true, localObjectId: existing.id, localRevision: existing.etag,
  });
  if (truncatedWrite.status !== 'confirmed') return respondCaldavWriteBack(res, truncatedWrite);
  const remainderWrite = await writeCaldavEventResource({
    userId: sessionUserId(req)!, target: input.target, method: 'PUT', filename: `${remainderUid}.ics`,
    uid: remainderUid, raw: remainderRaw, exists: false, localObjectId: null, localRevision: null,
  });
  if (remainderWrite.status !== 'confirmed') return respondCaldavWriteBack(res, remainderWrite);
  return res.json({ updated: true, scope: 'following' });
}

router.all('/events/:eventId/occurrence', async (req, res) => {
  if (!['PATCH', 'DELETE'].includes(req.method)) return res.status(405).end();
  const { calendarId, recurrenceId } = req.body || {};
  if (!calendarId || typeof recurrenceId !== 'string' || !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}Z?)?$/.test(recurrenceId)) return res.status(400).json({ error: 'A valid occurrence and calendar are required' });
  // 'single' changes only the occurrence named; 'following' changes it and every later one. Deleting the
  // whole series is the plain event DELETE, which already handles invitations.
  const scope: OccurrenceScope = req.body?.scope === 'following' ? 'following' : 'single';
  const cancel = req.method === 'DELETE';
  const times = cancel ? null : parseEventTimes(req.body);
  const attendees = normalizeAttendees(req.body.attendees || []);
  if (!cancel && (!times || !attendees)) return res.status(400).json({ error: 'Invalid event values' });
  // A series-level edit may carry `recurrence`; a single-occurrence edit never does. An absent field means
  // "leave the rule alone", an explicit null clears it, and an object sets it — the same three states the
  // whole-series update uses.
  const recurrenceProvided = Object.prototype.hasOwnProperty.call(req.body || {}, 'recurrence');
  const recurrenceParse = recurrenceProvided ? parseRecurrenceStructure((req.body || {}).recurrence, { allDay: Boolean(req.body?.allDay) }) : null;
  if (recurrenceParse && !recurrenceParse.ok) return res.status(400).json({ error: recurrenceParse.error });
  const values: OccurrenceRequestValues = {
    cancel,
    times,
    attendees,
    summary: typeof req.body?.summary === 'string' ? req.body.summary : null,
    description: normalizeDescription(req.body?.description),
    location: typeof req.body?.location === 'string' ? req.body.location : null,
    url: typeof req.body?.url === 'string' ? req.body.url : null,
    organizer: typeof req.body?.organizer === 'string' ? req.body.organizer : null,
    allDay: Boolean(req.body?.allDay),
    timezone: typeof req.body?.timezone === 'string' ? req.body.timezone : null,
    recurrenceProvided,
    recurrence: recurrenceParse?.ok ? recurrenceParse.recurrence : null,
  };

  const access = await writableCalendar(sessionUserId(req), calendarId);
  if (!access.ok) return res.status(access.status).json({ error: access.error });
  if (access.target.kind === 'graph' || access.target.kind === 'google') {
    return handleProviderOccurrence(req, res, { calendarId, recurrenceId, scope, values, target: access.target });
  }
  if (access.target.kind === 'caldav') {
    return handleCaldavOccurrence(req, res, { calendarId, recurrenceId, scope, values, target: access.target });
  }

  const outcome = await withTransaction(async client => {
    const row = (await client.query(
      `SELECT uid, raw_ical, invite_account_id, invitation_sequence, summary, description, location,
              starts_at, ends_at, all_day, ${READ_ATTENDEES}
         FROM calendar_events WHERE id = $1 AND calendar_id = $2 AND user_id = $3 FOR UPDATE`,
      [req.params.eventId, calendarId, req.session.userId],
    )).rows[0];
    if (!row) return { status: 404 };
    // An invited series is mutated **and** its attendees are told, in one RFC-compliant sequence: each
    // scoped change is an iTIP message (a REQUEST, or a CANCEL of the occurrence), sent with the sequence
    // advanced, because an invitee's client ignores a message whose sequence it has already seen. The
    // local change commits first and the messages go out after it, so a delivery failure cannot lose the
    // edit and a retry has the same sequence to send.
    let invitationPlan: {
      account: EmailAccountRow;
      messages: Array<Parameters<typeof sendCalendarInvitation>[0]>;
    } | null = null;
    if (row.invite_account_id && Array.isArray(row.attendees) && row.attendees.length) {
      const sender = (await client.query<EmailAccountRow>(
        'SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2 AND smtp_host IS NOT NULL',
        [row.invite_account_id, req.session.userId],
      )).rows[0];
      if (!sender) return { status: 502, invitedFailure: true };
      invitationPlan = { account: sender, messages: [] };
    }
    const sequence = Number(row.invitation_sequence || 0) + 1;
    if (scope === 'following') {
      const truncated = truncateSeriesBefore(row.raw_ical, recurrenceId);
      if (!truncated) return { status: 409 };
      if (truncated.empty) {
        // Acting from the series' own first occurrence leaves nothing of it, so remove the event rather
        // than keep a series that produces no occurrences.
        await client.query('DELETE FROM calendar_events WHERE id = $1 AND calendar_id = $2 AND user_id = $3', [req.params.eventId, calendarId, req.session.userId]);
        return { status: 200 };
      }
      if (cancel) {
        await client.query('UPDATE calendar_events SET raw_ical = $1, etag = gen_random_uuid()::text, invitation_sequence = invitation_sequence + 1, updated_at = NOW() WHERE id = $2 AND calendar_id = $3 AND user_id = $4', [truncated.raw, req.params.eventId, calendarId, req.session.userId]);
        if (invitationPlan) {
          // There is no iTIP "cancel the rest" primitive: the invitee's copy is corrected by an update that
          // no longer contains those occurrences, which is what the truncated rule says.
          invitationPlan.messages.push({
            account: invitationPlan.account, attendees: row.attendees, summary: row.summary, description: row.description,
            location: row.location, uid: row.uid, startsAt: row.starts_at, endsAt: row.ends_at, allDay: Boolean(row.all_day),
            method: 'REQUEST', sequence, rrule: rruleFromCalendarResource(truncated.raw),
          });
        }
        return { status: 200, invitationPlan };
      }
      // An edit of "this and following": the earlier part keeps its occurrences and the remainder becomes a
      // **new series** starting at the named occurrence, carrying the client's values and rule. The UID is
      // derived from the master and the occurrence, so re-sending the same edit updates that remainder rather
      // than creating a second one.
      // The client's new rule when it sent one, otherwise the master's own rule verbatim — re-rendering it
      // through the editor's structure would drop parts the editor cannot represent (a `custom` rule).
      const remainderRrule = recurrenceProvided ? recurrenceToRRule(values.recurrence) : rruleFromCalendarResource(row.raw_ical);
      const remainderUid = `${row.uid}#${recurrenceId.replace(/[^0-9A-Za-z]/g, '')}`;
      const remainderRaw = localEventIcal({
        uid: remainderUid, summary: values.summary, description: values.description, location: values.location,
        url: values.url, organizer: values.organizer, attendees: values.attendees!, allDay: values.allDay,
        ...values.times!, rrule: remainderRrule,
      });
      await client.query('UPDATE calendar_events SET raw_ical = $1, etag = gen_random_uuid()::text, invitation_sequence = invitation_sequence + 1, updated_at = NOW() WHERE id = $2 AND calendar_id = $3 AND user_id = $4', [truncated.raw, req.params.eventId, calendarId, req.session.userId]);
      if (invitationPlan) {
        // The earlier part is an update that ends where the split is; the remainder is a new series, which
        // the invitee learns from its own REQUEST.
        invitationPlan.messages.push({
          account: invitationPlan.account, attendees: row.attendees, summary: row.summary, description: row.description,
          location: row.location, uid: row.uid, startsAt: row.starts_at, endsAt: row.ends_at, allDay: Boolean(row.all_day),
          method: 'REQUEST', sequence, rrule: rruleFromCalendarResource(truncated.raw),
        });
        invitationPlan.messages.push({
          account: invitationPlan.account, attendees: values.attendees!, summary: values.summary, description: values.description,
          location: values.location, uid: remainderUid, startsAt: values.times!.startsAt, endsAt: values.times!.endsAt,
          allDay: values.allDay, method: 'REQUEST', sequence: 0, rrule: remainderRrule,
        });
      }
      await client.query(
        `INSERT INTO calendar_events (
           calendar_id, user_id, uid, raw_ical, summary, description, location, url, organizer,
           starts_at, ends_at, all_day, timezone, attendees
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (calendar_id, uid, recurrence_id) DO UPDATE SET
           raw_ical = EXCLUDED.raw_ical, summary = EXCLUDED.summary, description = EXCLUDED.description,
           location = EXCLUDED.location, url = EXCLUDED.url, organizer = EXCLUDED.organizer,
           starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at, all_day = EXCLUDED.all_day,
           timezone = EXCLUDED.timezone, attendees = EXCLUDED.attendees, etag = gen_random_uuid()::text,
           updated_at = NOW()`,
        [calendarId, req.session.userId, remainderUid, remainderRaw, values.summary, values.description, values.location, values.url, values.organizer, values.times!.startsAt, values.times!.endsAt, values.allDay, values.timezone, jsonbAttendees(values.attendees!)],
      );
      return { status: 200, invitationPlan };
    }
    const event = parseCalendarEvent(row.raw_ical);
    if (!event) return { status: 409 };
    const replacement = localEventIcal(cancel ? { ...event, allDay: event.allDay } : { ...req.body, description: values.description, attendees: values.attendees!, ...values.times!, uid: row.uid });
    const raw = mergeCalendarResource(row.raw_ical, replacement, recurrenceId, cancel);
    await client.query('UPDATE calendar_events SET raw_ical = $1, etag = gen_random_uuid()::text, invitation_sequence = invitation_sequence + 1, updated_at = NOW() WHERE id = $2 AND calendar_id = $3 AND user_id = $4', [raw, req.params.eventId, calendarId, req.session.userId]);
    if (invitationPlan) {
      const occurrenceTimes = cancel
        ? { startsAt: event.startsAt, endsAt: event.endsAt }
        : { startsAt: values.times!.startsAt, endsAt: values.times!.endsAt };
      invitationPlan.messages.push({
        account: invitationPlan.account,
        attendees: cancel ? row.attendees : values.attendees!,
        summary: cancel ? event.summary : values.summary,
        description: cancel ? event.description : values.description,
        location: cancel ? event.location : values.location,
        uid: row.uid,
        startsAt: occurrenceTimes.startsAt,
        endsAt: occurrenceTimes.endsAt,
        allDay: cancel ? event.allDay : values.allDay,
        method: cancel ? 'CANCEL' : 'REQUEST',
        sequence,
        // The message is about one occurrence, which is exactly what `RECURRENCE-ID` tells the invitee.
        recurrenceId,
      });
    }
    return { status: 200, invitationPlan };
  });
  if (outcome.status !== 200) {
    return res.status(outcome.status).json({
      error: outcome.invitedFailure
        ? 'The invitation could not be prepared, so the occurrence was not changed.'
        : 'Calendar occurrence unavailable',
    });
  }
  if (outcome.invitationPlan?.messages.length) {
    // The change is durable; the messages are the notification. A delivery failure is reported, not turned
    // into a failed edit, and the sequence has already advanced so a retry cannot double-notify.
    try {
      for (const message of outcome.invitationPlan.messages) {
        await sendCalendarInvitation(message);
      }
    } catch (caught) {
      console.error('Calendar occurrence invitation delivery failed:', toAppError(caught).message);
      return res.json({ updated: true, scope, invitationError: 'The occurrence was changed, but an invitation could not be sent.' });
    }
  }
  res.json({ updated: true, scope });
});

router.get('/events/:eventId/cancellation-delivery', async (req, res) => {
  const operation = await query<{ id: string; calendar_id: string; cancellation_outbox_id: string }>(
    `SELECT e.id, e.calendar_id, e.cancellation_outbox_id
     FROM calendar_events e
     JOIN calendar_invitation_outbox o ON o.id = e.cancellation_outbox_id AND o.user_id = e.user_id
     WHERE e.id = $1 AND e.user_id = $2`,
    [req.params.eventId, req.session.userId],
  );
  const event = operation.rows[0];
  if (!event) return res.json({ operation: null, invitationStatus: null });
  const delivery = await readInvitationDeliveryStatus(event.cancellation_outbox_id, req.session.userId || null);
  return res.json({
    operation: { kind: 'cancellation', outboxId: event.cancellation_outbox_id },
    invitationStatus: delivery,
  });
});

router.post('/events/:eventId/cancellation-delivery/retry', async (req, res) => {
  const operation = await query<{ id: string; cancellation_outbox_id: string }>(
    `SELECT e.id, e.cancellation_outbox_id
     FROM calendar_events e
     JOIN calendar_invitation_outbox o ON o.id = e.cancellation_outbox_id AND o.user_id = e.user_id
     WHERE e.id = $1 AND e.user_id = $2`,
    [req.params.eventId, req.session.userId],
  );
  const event = operation.rows[0];
  if (!event) return res.status(404).json({ error: 'Invitation cancellation operation not found' });
  const delivery = await deliverStoredInvitation({ outboxId: event.cancellation_outbox_id, userId: req.session.userId });
  return res.json({ operation: { kind: 'cancellation', outboxId: event.cancellation_outbox_id }, invitationStatus: delivery });
});

// One event's full stored representation, used by the editor to open the whole
// series (the list only carries materialised occurrences, not the master rule).
router.get('/events/:eventId', async (req, res) => {
  const result = await query<{
    id: string; calendar_id: string; uid: string; summary?: string | null; description?: string | null;
    location?: string | null; url?: string | null; organizer?: string | null; starts_at?: string | Date | null;
    ends_at?: string | Date | null; all_day?: boolean | null; timezone?: string | null; attendees?: unknown;
    invite_account_id?: string | null; recurring?: boolean | null; raw_ical?: string | null;
    read_only?: boolean | null; source?: string | null;
  }>(
    `SELECT e.id, e.calendar_id, e.uid, e.summary, e.description, e.location, e.url, e.organizer,
            e.starts_at, e.ends_at, e.all_day, e.timezone, ${READ_ATTENDEES}, e.invite_account_id,
            e.recurring, e.raw_ical, c.read_only, c.source
       FROM calendar_events e
       JOIN calendars c ON c.id = e.calendar_id
      WHERE e.id = $1 AND e.user_id = $2 AND c.user_id = $2 AND c.owner_user_id = $2`,
    [req.params.eventId, req.session.userId],
  );
  const event = result.rows[0];
  if (!event) return res.status(404).json({ error: 'Event not found' });
  const { raw_ical: _raw, ...safe } = event;
  res.json({ event: { ...safe, recurrence: recurrenceViewFromRRule(rruleFromCalendarResource(event.raw_ical)) } });
});

router.patch('/events/:eventId', async (req, res) => {
  const { calendarId, summary, description: rawDescription = null, location = null, url = null, organizer = null, allDay = false, timezone = null, sendInvites = false, inviteAccountId, attendees } = req.body || {};
  const description = normalizeDescription(rawDescription);
  const times = parseEventTimes(req.body);
  if (!calendarId || !times) return res.status(400).json({ error: 'calendarId and a valid event range are required' });
  const normalizedAttendees = normalizeAttendees(attendees || []);
  if (!normalizedAttendees) return res.status(400).json({ error: 'Attendees must be valid email addresses' });
  if (sendInvites && (!inviteAccountId || !normalizedAttendees.length)) return res.status(400).json({ error: 'A sender account and at least one attendee are required for invitations' });
  // A series-level edit carries `recurrence`; an occurrence edit never does. An
  // absent field keeps the stored rule, an explicit null clears it.
  const recurrenceProvided = Object.prototype.hasOwnProperty.call(req.body || {}, 'recurrence');
  const recurrenceParse = parseRecurrenceStructure((req.body || {}).recurrence, { allDay: Boolean(allDay) });
  if (!recurrenceParse.ok) return res.status(400).json({ error: recurrenceParse.error });
  const recurrence = recurrenceParse.recurrence;
  const rrule = recurrenceToRRule(recurrence);
  const seriesRecurrence = recurrenceProvided ? { rrule } : undefined;

  const access = await writableCalendar(sessionUserId(req), calendarId);
  if (!access.ok) return res.status(access.status).json({ error: access.error });
  const target = access.target;
  if (target.kind === 'graph' || target.kind === 'google') {
    // Provider first: an edit the provider refuses must not change the local copy, and the provider
    // notifies attendees itself, so Inboxora's own invitation mail is skipped on this path.
    const providerEventId = target.kind === 'graph'
      ? await graphEventIdForLocalRow(req.session.userId!, target.collectionId, req.params.eventId)
      : await googleEventIdForLocalRow(req.session.userId!, target.collectionId, req.params.eventId);
    if (!providerEventId) return res.status(409).json({ error: 'This event is not linked to its provider copy yet' });
    const eventWrite = {
      summary: summary || null, description, location, url, startsAt: times.startsAt, endsAt: times.endsAt,
      allDay: Boolean(allDay), attendees: normalizedAttendees,
      // Three states reach the provider: the key is **absent** to keep the stored rule, an explicit `null`
      // makes the event a one-off (Graph `recurrence: null`, Google `recurrence: []`), and an object sets it.
      ...(recurrenceProvided ? { recurrence } : {}),
    };
    if (target.kind === 'graph') {
      const attempt = await writeGraphCalendarEvent({ userId: req.session.userId!, target, operation: 'update', providerEventId, event: eventWrite, localResourceId: req.params.eventId });
      if (attempt.status === 'failed') return providerWriteRefusal(res, attempt.failure);
    } else {
      const attempt = await writeGoogleCalendarEvent({
        userId: req.session.userId!, target, operation: 'update', providerEventId, event: eventWrite,
        sendUpdates: sendInvites ? 'all' : 'none', localResourceId: req.params.eventId,
      });
      if (attempt.status === 'failed') return providerWriteRefusal(res, attempt.failure);
    }
  }
  if (target.kind === 'caldav') {
    const existing = await readCaldavEventRow(req.session.userId!, calendarId, req.params.eventId);
    if (!existing) return res.status(404).json({ error: 'Event not found' });
    const merged = mergeCalendarResource(existing.raw_ical, localEventIcal({ uid: existing.uid, summary, description, location, url, organizer, attendees: normalizedAttendees, allDay: Boolean(allDay), ...times }));
    const raw = seriesRecurrence ? (setSeriesRecurrence(merged, rrule) ?? merged) : merged;
    const written = await writeCaldavEventResource({
      userId: req.session.userId!, target, method: 'PUT',
      filename: existing.dav_filename ?? `${existing.uid}.ics`, uid: existing.uid, raw,
      exists: true, localObjectId: req.params.eventId, localRevision: existing.etag,
    });
    if (written.status !== 'confirmed') return respondCaldavWriteBack(res, written);
    if (sendInvites && normalizedAttendees.length) {
      const sender = await query<EmailAccountRow>('SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2 AND enabled = true AND smtp_host IS NOT NULL', [inviteAccountId, req.session.userId]);
      if (!sender.rows[0]) return res.status(400).json({ error: 'The selected sender account is unavailable' });
      const stored = await query<{ invitation_sequence: number | null }>('SELECT invitation_sequence FROM calendar_events WHERE id = $1 AND user_id = $2', [req.params.eventId, req.session.userId]);
      try {
        await sendCalendarInvitation({
          account: sender.rows[0], attendees: normalizedAttendees, summary: summary || null, description,
          location, uid: existing.uid, startsAt: times.startsAt, endsAt: times.endsAt, allDay: Boolean(allDay),
          method: 'REQUEST', sequence: Number(stored.rows[0]?.invitation_sequence ?? 0) + 1,
          ...(seriesRecurrence ? { rrule } : {}),
        });
      } catch (caught) {
        console.error('Calendar invitation delivery failed:', toAppError(caught).message);
        return res.json({ updated: true, invitationError: 'The event was saved, but the invitation could not be sent.' });
      }
    }
    return res.json({ updated: true });
  }

  const invitesHandledByProvider = target.kind !== 'local';

  let invitationAccount = null;
  if (sendInvites && !invitesHandledByProvider) {
    const sender = await query<EmailAccountRow>('SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2 AND enabled = true AND smtp_host IS NOT NULL', [inviteAccountId, req.session.userId]);
    invitationAccount = sender.rows[0] || null;
    if (!invitationAccount) return res.status(400).json({ error: 'The selected sender account is unavailable' });
  }

  if (sendInvites && !invitesHandledByProvider && invitationAccount) {
    let outcome;
    try {
      outcome = await updateInvitedEvent(req, { calendarId, invitationAccount, normalizedAttendees, times, summary, description, location, url, organizer, allDay, timezone, rrule: seriesRecurrence ? rrule : undefined });
    } catch (caught) {
      const error = toAppError(caught);
      console.error('Calendar invitation transaction failed:', error.message, error.code ? `(code ${error.code})` : '');
      return res.status(500).json({ error: 'The event and invitation could not be saved; no partial changes were kept.' });
    }
    if (outcome.notFound) return res.status(404).json({ error: 'Event not found' });
    if (outcome.conflict) return res.status(409).json({ error: 'The idempotency key was already used for a different calendar update' });
    if (outcome.cancelFailed) return res.status(502).json({ error: 'The previous invitation could not be cancelled, so the event was not changed.' });
    if (outcome.duplicate) {
      if (outcome.delivered) return res.json(invitationDeliveryResponse(outcome.event, outcome.delivered));
      // An identical retry must resend an undelivered invitation, not replay the error.
      const delivered = await deliverStoredInvitation({ outboxId: outcome.outboxId, userId: req.session.userId });
      return res.json(invitationDeliveryResponse(outcome.event, delivered));
    }
    const delivered = await deliverStoredInvitation({ outboxId: outcome.outboxId, userId: req.session.userId });
    return res.json(invitationDeliveryResponse(outcome.event, delivered));
  }

  const outcome = await withTransaction(async client => {
    const existing = await client.query(`SELECT uid, raw_ical, ${READ_ATTENDEES}, invite_account_id, invitation_sequence, summary, description, location, starts_at, ends_at, all_day FROM calendar_events WHERE id = $1 AND calendar_id = $2 AND user_id = $3 FOR UPDATE`, [req.params.eventId, calendarId, req.session.userId]);
    const existingEvent = existing.rows[0];
    if (!existingEvent) return { notFound: true };

    const hadInvitation = Boolean(existingEvent.invite_account_id && Array.isArray(existingEvent.attendees) && existingEvent.attendees.length);
    const senderChanged = hadInvitation && sendInvites && invitationAccount?.id !== existingEvent.invite_account_id;
    const cancelledAttendees = hadInvitation ? (senderChanged || !sendInvites ? existingEvent.attendees : existingEvent.attendees.filter((email: string) => !normalizedAttendees.includes(email))) : [];
    const cancellationAccount = invitationAccount?.id === existingEvent.invite_account_id
      ? invitationAccount
      : cancelledAttendees.length
        // A disabled account retains SMTP settings for cancellation; referenced
        // sender accounts cannot be deleted because the FK is ON DELETE RESTRICT.
        ? (await client.query<EmailAccountRow>('SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2 AND smtp_host IS NOT NULL', [existingEvent.invite_account_id, req.session.userId])).rows[0] || null
        : null;
    if (cancelledAttendees.length && !cancellationAccount) return { cancelFailed: true };
    const cancellationAction = cancelledAttendees.length && cancellationAccount
      ? { account: cancellationAccount, attendees: cancelledAttendees, summary: existingEvent.summary, description: existingEvent.description, location: existingEvent.location, uid: existingEvent.uid, allDay: Boolean(existingEvent.all_day), method: 'CANCEL', sequence: Number(existingEvent.invitation_sequence || 0) + 1, startsAt: new Date(existingEvent.starts_at).toISOString(), endsAt: new Date(existingEvent.ends_at).toISOString() }
      : null;

    const mergedIcal = mergeCalendarResource(existingEvent.raw_ical, localEventIcal({ uid: existingEvent.uid, summary, description, location, url, organizer, attendees: normalizedAttendees, allDay: Boolean(allDay), ...times }));
    // A series-level edit applies the validated rule; an occurrence edit or a plain
    // single-event edit leaves the stored rule (there is none) untouched.
    const rawIcal = seriesRecurrence ? (setSeriesRecurrence(mergedIcal, rrule) ?? mergedIcal) : mergedIcal;
    const result = await client.query(`UPDATE calendar_events SET raw_ical = $1, summary = $2, description = $3, location = $4, url = $5, organizer = $6, starts_at = $7, ends_at = $8, all_day = $9, timezone = $10, attendees = $11, invite_account_id = $12, invitation_sequence = CASE WHEN (invite_account_id IS NOT NULL AND ${ATTENDEES_IS_ARRAY} AND jsonb_array_length(attendees) > 0) OR invitation_sequence > 0 THEN invitation_sequence + 1 ELSE 0 END, etag = gen_random_uuid()::text, updated_at = NOW() WHERE id = $13 AND calendar_id = $14 AND user_id = $15 RETURNING id, calendar_id, uid, etag, summary, description, location, url, organizer, starts_at, ends_at, all_day, timezone, attendees, invite_account_id, invitation_sequence, created_at, updated_at`, [rawIcal, summary || null, description, location, url, organizer, times.startsAt, times.endsAt, Boolean(allDay), timezone, jsonbAttendees(normalizedAttendees), invitationAccount?.id || null, req.params.eventId, calendarId, req.session.userId]);
    if (!result.rows[0]) return { notFound: true };

    let cancellationOutboxId: string | null = null;
    if (cancellationAction) {
      const outbox = await client.query('INSERT INTO calendar_invitation_outbox (user_id, event_id, idempotency_key, request_fingerprint, payload) VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING id', [req.session.userId, result.rows[0].id, `cancel:${crypto.randomUUID()}`, crypto.randomUUID(), JSON.stringify({ actions: invitationActionsForStorage([cancellationAction]) })]);
      cancellationOutboxId = outbox?.rows?.[0]?.id || null;
      if (cancellationOutboxId) {
        await client.query('UPDATE calendar_events SET cancellation_outbox_id = $1 WHERE id = $2 AND user_id = $3', [cancellationOutboxId, result.rows[0].id, req.session.userId]);
      }
    }

    let delivered = null;
    if (invitationAccount) {
      try {
        // Keep the row lock until this REQUEST is emitted, so a later mutation
        // cannot overtake it with a higher sequence number.
        await sendCalendarInvitation({ account: invitationAccount, attendees: normalizedAttendees, summary, description, location, uid: existingEvent.uid, allDay: Boolean(allDay), method: 'REQUEST', sequence: result.rows[0].invitation_sequence, ...times });
        delivered = { status: 'sent', lastError: null };
      } catch (caught) {
        const error = toAppError(caught);
        delivered = { status: 'failed', lastError: error.message };
        console.error('Calendar invitation delivery failed:', error.message, error.code ? `(code ${error.code})` : '');
      }
    }
    return { event: result.rows[0], delivered, cancellationOutboxId };
  });
  if (outcome.cancelFailed) return res.status(502).json({ error: 'The previous invitation could not be cancelled, so the event was not changed.' });
  if (outcome.notFound || !outcome.event) return res.status(404).json({ error: 'Event not found' });

  const cancellationDelivery = outcome.cancellationOutboxId
    ? await deliverStoredInvitation({ outboxId: outcome.cancellationOutboxId, userId: req.session.userId })
    : null;
  const delivery = cancellationDelivery || outcome.delivered || { status: 'sent', lastError: null };
  res.json(invitationDeliveryResponse(
    outcome.event,
    delivery,
    outcome.cancellationOutboxId ? { kind: 'cancellation', outboxId: outcome.cancellationOutboxId } : null,
  ));
});


router.delete('/events/:eventId', async (req, res) => {
  const calendarId = typeof req.query.calendarId === 'string' ? req.query.calendarId : null;
  if (!calendarId) return res.status(400).json({ error: 'calendarId is required' });

  const access = await writableCalendar(sessionUserId(req), calendarId);
  if (!access.ok) return res.status(access.status).json({ error: access.error });
  const target = access.target;
  if (target.kind === 'graph' || target.kind === 'google') {
    // Provider first, and the provider notifies attendees itself. An event the provider no longer has is
    // the end state the caller asked for, so the local row is still removed and the link tombstoned.
    const providerEventId = target.kind === 'graph'
      ? await graphEventIdForLocalRow(req.session.userId!, target.collectionId, req.params.eventId)
      : await googleEventIdForLocalRow(req.session.userId!, target.collectionId, req.params.eventId);
    if (!providerEventId) return res.status(409).json({ error: 'This event is not linked to its provider copy yet' });
    if (target.kind === 'graph') {
      const attempt = await writeGraphCalendarEvent({ userId: req.session.userId!, target, operation: 'delete', providerEventId, localResourceId: req.params.eventId });
      if (attempt.status === 'failed' && attempt.failure.code !== 'RESOURCE_NOT_FOUND') {
        return providerWriteRefusal(res, attempt.failure);
      }
      await removeGraphCalendarEventLink({ userId: req.session.userId!, target, providerEventId });
    } else {
      // The cancellation is sent from the provider's own delete, so attendees are told once.
      const attempt = await writeGoogleCalendarEvent({ userId: req.session.userId!, target, operation: 'delete', providerEventId, sendUpdates: 'all', localResourceId: req.params.eventId });
      if (attempt.status === 'failed' && attempt.failure.code !== 'RESOURCE_NOT_FOUND') {
        return providerWriteRefusal(res, attempt.failure);
      }
      await removeGoogleCalendarEventLink({ userId: req.session.userId!, target, providerEventId });
    }
  }

  if (target.kind === 'caldav') {
    const existing = await readCaldavEventRow(req.session.userId!, calendarId, req.params.eventId);
    if (!existing) return res.status(404).json({ error: 'Event not found' });
    // An event the source no longer has is the end state the caller asked for, so the local row is removed
    // by the projection and the caller is told the deletion happened.
    const written = await writeCaldavEventResource({
      userId: req.session.userId!, target, method: 'DELETE',
      filename: existing.dav_filename ?? `${existing.uid}.ics`, uid: existing.uid, raw: '',
      exists: true, localObjectId: req.params.eventId, localRevision: existing.etag,
    });
    if (written.status === 'permanent' && written.code === 'RESOURCE_NOT_FOUND') {
      await query('DELETE FROM calendar_events WHERE id = $1 AND calendar_id = $2 AND user_id = $3', [req.params.eventId, calendarId, req.session.userId]);
      return res.status(204).end();
    }
    if (written.status !== 'confirmed') return respondCaldavWriteBack(res, written);
    return res.status(204).end();
  }

  const outcome = await withTransaction(async client => {
    const existing = await client.query(`SELECT uid, raw_ical, ${READ_ATTENDEES}, invite_account_id, invitation_sequence, summary, description, location, starts_at, ends_at, all_day FROM calendar_events WHERE id = $1 AND calendar_id = $2 AND user_id = $3 FOR UPDATE`, [req.params.eventId, calendarId, req.session.userId]);
    const event = existing.rows[0];
    if (!event) return { notFound: true };

    let cancellationOutboxId: string | null = null;
    if (event.invite_account_id && Array.isArray(event.attendees) && event.attendees.length) {
      // A disabled account retains SMTP settings for cancellation. Persist the
      // action before deleting the event; migration 0086 keeps this outbox row.
      const sender = await client.query<EmailAccountRow>('SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2 AND smtp_host IS NOT NULL', [event.invite_account_id, req.session.userId]);
      if (!sender.rows[0]) return { cancelFailed: true };
      const action = { account: sender.rows[0], attendees: event.attendees, summary: event.summary, description: event.description, location: event.location, uid: event.uid, allDay: Boolean(event.all_day), method: 'CANCEL', sequence: Number(event.invitation_sequence || 0) + 1, startsAt: new Date(event.starts_at).toISOString(), endsAt: new Date(event.ends_at).toISOString() };
      const outbox = await client.query('INSERT INTO calendar_invitation_outbox (user_id, event_id, idempotency_key, request_fingerprint, payload) VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING id', [req.session.userId, req.params.eventId, `cancel:${crypto.randomUUID()}`, crypto.randomUUID(), JSON.stringify({ actions: invitationActionsForStorage([action]) })]);
      cancellationOutboxId = outbox?.rows?.[0]?.id || null;
    }

    const result = await client.query('DELETE FROM calendar_events WHERE id = $1 AND calendar_id = $2 AND user_id = $3 RETURNING id', [req.params.eventId, calendarId, req.session.userId]);
    return { deleted: Boolean(result.rows[0]), cancellationOutboxId };
  });
  if (outcome.cancelFailed) return res.status(502).json({ error: 'The invitation could not be cancelled, so the event was not deleted.' });
  if (outcome.notFound || !outcome.deleted) return res.status(404).json({ error: 'Event not found' });

  // The deletion is durable even if SMTP only accepts a subset: the outbox row
  // retains rejected recipients for the worker and a later retry.
  if (outcome.cancellationOutboxId) await deliverStoredInvitation({ outboxId: outcome.cancellationOutboxId, userId: req.session.userId });
  res.status(204).end();
});

/** A calendar_import_sources row as the source routes return, redact and schedule it. */
type CalendarSourceRow = {
  id: string;
  kind: string;
  url: string;
  user_id?: string;
  url_fingerprint?: string | null;
  username?: string;
  password?: string;
  display_name?: string | null;
  color?: string | null;
  interval_min?: number;
  enabled?: boolean | null;
  last_sync_at?: string | Date | null;
  last_error?: string | null;
  [key: string]: unknown;
};

function publicSource(source: CalendarSourceRow) {
  const decryptedUrl = source.url ? decrypt(source.url) : null;
  const secretValues = decryptedUrl === null
    ? (source.url ? [source.url] : [])
    : [source.url, decryptedUrl];
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
  const result = await query<CalendarSourceRow>(
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
    const result = await query<CalendarSourceRow>(
      `INSERT INTO calendar_import_sources (user_id, kind, url, url_fingerprint, username, password, display_name, color, interval_min)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.session.userId, kind, encrypt(normalizedUrl), urlFingerprint, username || null, password ? encrypt(password) : null, displayName, color, interval],
    );
    const source = result.rows[0];
    scheduleCalendarSource(source);
    const sync = await syncCalendarSource(sessionUserId(req), source.id);
    if (!sync.ok) {
      // The sync records the failure asynchronously from the insert result;
      // reflect that terminal state in the response so the client can render
      // the persisted source as retryable immediately.
      source.last_error = sync.error;
      return res.status(502).json({ error: sync.error, source: publicSource(source), sync });
    }
    res.status(201).json({ source: publicSource(source), sync });
  } catch (caught) {
    const error = toAppError(caught);
    if (error.code === '23505') return res.status(409).json({ error: 'A source with this URL already exists' });
    if (error.code === '23514') return res.status(409).json({ error: 'Calendar source URL could not be stored securely' });
    throw error;
  }
});

router.post('/sources/:sourceId/sync', async (req, res) => {
  const result = await syncCalendarSource(sessionUserId(req), req.params.sourceId);
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
  const result = await query<CalendarSourceRow>(
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

// Whether Google calendars can be pulled, and what has been pulled so far. Safe
// for any authenticated user: no credential, only counts and timestamps.
router.get('/providers/google/status', async (req, res) => {
  const userId = sessionUserId(req);
  const [connections, collections] = await Promise.all([
    query<{ id: string }>(
      "SELECT id FROM provider_connections WHERE user_id = $1 AND provider = 'google' AND status = 'active'",
      [userId],
    ),
    query<{
      connection_id: string; calendar_id: string; name: string | null;
      event_count: number; last_success_at: string | Date | null; last_error_code: string | null; last_error_at: string | Date | null;
    }>(
      `SELECT ic.connection_id, c.id AS calendar_id, c.name,
              (SELECT COUNT(*)::int FROM calendar_events e WHERE e.calendar_id = c.id) AS event_count,
              s.last_success_at, s.last_error_code, s.last_error_at
         FROM integration_collections ic
         JOIN calendars c ON c.id = ic.local_calendar_id
         LEFT JOIN sync_states s ON s.collection_id = ic.id AND s.user_id = ic.user_id
         JOIN provider_connections pc ON pc.id = ic.connection_id
        WHERE ic.user_id = $1 AND ic.kind = 'calendar' AND pc.provider = 'google'
        ORDER BY c.created_at ASC`,
      [userId],
    ),
  ]);
  res.json({
    configured: isGoogleConfigured(googleConfigFromEnv()),
    connected: connections.rows.length > 0,
    connections: connections.rows.length,
    calendars: collections.rows.map(row => ({
      connectionId: row.connection_id,
      calendarId: row.calendar_id,
      name: row.name,
      eventCount: row.event_count,
      lastSyncedAt: row.last_success_at,
      lastErrorCode: row.last_error_code,
      lastErrorAt: row.last_error_at,
    })),
  });
});

// Pull the signed-in user's Google calendars and their events. The synced
// calendars are read-only and hidden from DAV devices until the user enables them.
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
    return res.status(409).json({ error: 'Connect a Google account before syncing calendars' });
  }
  const config = googleConfigFromEnv();
  if (!isGoogleConfigured(config)) {
    return res.status(409).json({ error: 'Google API is not configured by the administrator' });
  }

  const results: Array<Record<string, unknown>> = [];
  for (const connection of connections.rows) {
    try {
      results.push({ connectionId: connection.id, ...(await syncGoogleCalendar({ userId, connectionId: connection.id, config })) });
    } catch (caught) {
      const error = caught instanceof GoogleApiError ? caught : null;
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


// Whether Microsoft calendars can be pulled, and what has been pulled so far. The scope is
// deliberately per provider: a Microsoft calendar and a Google calendar share the `calendar` collection
// kind, so the connection's provider is what separates them.
router.get('/providers/microsoft/status', async (req, res) => {
  const userId = sessionUserId(req);
  const [connections, collections] = await Promise.all([
    query<{ id: string }>(
      "SELECT id FROM provider_connections WHERE user_id = $1 AND provider = 'microsoft' AND status = 'active'",
      [userId],
    ),
    query<{
      connection_id: string; calendar_id: string; name: string | null; source_access: string | null;
      event_count: number; last_success_at: string | Date | null; last_error_code: string | null; last_error_at: string | Date | null;
    }>(
      `SELECT ic.connection_id, c.id AS calendar_id, c.name, ic.source_access,
              (SELECT COUNT(*)::int FROM calendar_events e WHERE e.calendar_id = c.id) AS event_count,
              s.last_success_at, s.last_error_code, s.last_error_at
         FROM integration_collections ic
         JOIN calendars c ON c.id = ic.local_calendar_id
         LEFT JOIN sync_states s ON s.collection_id = ic.id AND s.user_id = ic.user_id
         JOIN provider_connections pc ON pc.id = ic.connection_id
        WHERE ic.user_id = $1 AND ic.kind = 'calendar' AND pc.provider = 'microsoft'
        ORDER BY c.created_at ASC`,
      [userId],
    ),
  ]);
  res.json({
    configured: isMicrosoftConfigured(microsoftConfigFromEnv()),
    connected: connections.rows.length > 0,
    connections: connections.rows.length,
    calendars: collections.rows.map(row => ({
      connectionId: row.connection_id,
      calendarId: row.calendar_id,
      name: row.name,
      // Whether the provider itself permits writes to this calendar. Read-only is the honest default.
      canWriteAtSource: row.source_access === 'read_write',
      eventCount: row.event_count,
      lastSyncedAt: row.last_success_at,
      lastErrorCode: row.last_error_code,
      lastErrorAt: row.last_error_at,
    })),
  });
});

// Pull the signed-in user's Microsoft calendars and their events. The synced calendars are read-only and
// hidden from DAV devices until the user enables them, exactly as the Google path stores them.
router.post('/providers/microsoft/sync', async (req, res) => {
  if (!providerIntegrationsEnabled()) {
    return res.status(403).json({ error: 'Provider integrations are disabled on this installation' });
  }
  const userId = sessionUserId(req);
  const connections = await query<{ id: string }>(
    "SELECT id FROM provider_connections WHERE user_id = $1 AND provider = 'microsoft' AND status = 'active' ORDER BY created_at ASC",
    [userId],
  );
  if (!connections.rows.length) {
    return res.status(409).json({ error: 'Connect a Microsoft account before syncing calendars' });
  }
  const config = microsoftConfigFromEnv();
  if (!isMicrosoftConfigured(config)) {
    return res.status(409).json({ error: 'Microsoft API is not configured by the administrator' });
  }

  const results: Array<Record<string, unknown>> = [];
  for (const connection of connections.rows) {
    try {
      results.push({ connectionId: connection.id, ...(await syncGraphCalendar({ userId, connectionId: connection.id, config })) });
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


// Import an .ics file into a local calendar. Identity is the event UID, exactly as
// in the DAV and provider paths, so re-importing a file updates the events it
// already has instead of creating a second copy of each series.
router.post('/calendars/:id/import/ics', async (req, res) => {
  const ics = typeof req.body?.ics === 'string' ? req.body.ics : '';
  if (!ics || ics.length > 900_000) return res.status(400).json({ error: 'iCalendar file must be a non-empty file smaller than 900 KB' });
  const userId = sessionUserId(req);
  try {
    const owned = await query<{ id: string; source?: string | null }>(
      'SELECT id, source FROM calendars WHERE id = $1 AND user_id = $2',
      [req.params.id, userId],
    );
    const calendar = owned.rows[0];
    if (!calendar) return res.status(404).json({ error: 'Calendar not found' });
    // An imported or provider calendar is written by its source, not by a file.
    if ((calendar.source ?? 'local') !== 'local') return res.status(403).json({ error: 'This calendar is read-only' });

    let resources: string[];
    try {
      resources = calendarResources(ics);
    } catch {
      return res.status(400).json({ error: 'The file is not a valid iCalendar document' });
    }

    let imported = 0;
    // Events the file clashed with that Inboxora owns through a sent invitation.
    let protectedEvents = 0;
    await withTransaction(async client => {
      for (const raw of resources) {
        const event = parseCalendarEvent(raw);
        // A resource the projection cannot read is skipped rather than stored broken.
        if (!event) continue;
        const etag = crypto.createHash('md5').update(raw).digest('hex');
        const written = await client.query<{ id: string }>(
          `INSERT INTO calendar_events
             (calendar_id, user_id, uid, raw_ical, etag, summary, starts_at, ends_at, all_day, timezone, description, location, url, organizer, attendees)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
           ON CONFLICT (calendar_id, uid, recurrence_id) DO UPDATE SET
             raw_ical = EXCLUDED.raw_ical, etag = EXCLUDED.etag, summary = EXCLUDED.summary,
             starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at, all_day = EXCLUDED.all_day,
             timezone = EXCLUDED.timezone, description = EXCLUDED.description, location = EXCLUDED.location,
             url = EXCLUDED.url, organizer = EXCLUDED.organizer, attendees = EXCLUDED.attendees, updated_at = NOW()
           -- An event Inboxora owns because invitations were sent for it is not the file's
           -- to overwrite: the CalDAV write path refuses the same conflict, and an import
           -- must not achieve silently what a DAV client is told it cannot do.
           WHERE calendar_events.invite_account_id IS NULL
           RETURNING id`,
          [
            calendar.id, userId, event.uid, raw, etag, event.summary, event.startsAt, event.endsAt,
            event.allDay, event.timeZone, event.description, event.location, event.url, event.organizer,
            JSON.stringify(event.attendees),
          ],
        );
        if (written.rows.length) imported += 1;
        else protectedEvents += 1;
      }
    });
    // A file whose events were all left alone because Inboxora owns them did contain
    // events; saying "none found" would misreport what happened.
    if (!imported && !protectedEvents) return res.status(400).json({ error: 'No events found in the file' });
    // No manual token bump: the `calendar_events` trigger maintains `sync_version` and
    // `sync_token` in the `sync-N` scheme the DAV endpoint advertises, and writing a
    // random token here replaced it with a value that scheme never produces.
    res.status(201).json({ imported, protected: protectedEvents });
  } catch (err) {
    console.error('iCalendar import error:', err);
    res.status(500).json({ error: 'Failed to import the iCalendar file' });
  }
});

export default router;
