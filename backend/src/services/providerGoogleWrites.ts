import { query } from './db.js';
import { collectionIsWritable } from './providerAccess.js';
import { runProviderMutation } from './providerMutationService.js';
import { providerWriteFailure, type ProviderWriteFailure } from './providerWriteFailure.js';
import { googleConfigFromEnv, isGoogleConfigured } from './providerAuthService.js';
import { providerIntegrationsEnabled, readProviderSwitches } from './providerSwitches.js';
import {
  deleteGoogleEvent,
  insertGoogleEvent,
  patchGoogleEvent,
  type GoogleCalendarEvent,
  type GoogleEventWritePayload,
  type GoogleSendUpdates,
} from './providers/google/googleCalendar.js';
import type { GoogleApiOptions } from './providers/google/googleApiClient.js';
import {
  createGooglePerson,
  deleteGooglePerson,
  personResourcePath,
  updateGooglePerson,
  type GooglePerson,
  type GooglePersonDate,
  type GooglePersonName,
  type GooglePersonWrite,
} from './providers/google/googlePeople.js';
import { GOOGLE_PERSONAL_COLLECTION_REMOTE_ID, contactUidForPerson } from './providers/google/googleContactsSync.js';
import { classifyGmailMailMutationFailure } from './providers/google/gmailMailMutations.js';
import { recurrenceToRRule } from '../utils/calendarRecurrenceRule.js';
import type { ParsedRecurrence } from '../utils/calendarRecurrenceRule.js';
import type { VCardContact } from '../utils/vcard.js';
import type { ProviderAdapterOutcome, ProviderMutationAdapter } from './providerMutationService.js';

/**
 * Google Calendar/People **writes** (P09): which local collection owns a Google resource, and how one
 * mutation becomes a provider call on the shared journal.
 *
 * This is the Google half of the same shape `providerCalendarWrites.ts` / `providerContactWrites.ts`
 * give Microsoft: the provider is written first, the local projection second, the durable claim is
 * committed before the network call, and an ambiguous answer is parked rather than retried. The two
 * Microsoft files keep their own resolution because their adapters address Graph's resources; this
 * file owns the Google identity (calendar id + event id, people resource name) and the two Google
 * API adapters.
 *
 * The two target resolvers deliberately answer only for a Google collection: a local calendar or a
 * Microsoft one is `not_google`, and the caller keeps the answer the shared resolver already gave it.
 * That is what keeps the local/Microsoft rules in one place — this file never decides whether a
 * Microsoft calendar is writable.
 */

// ── The Google write gate ────────────────────────────────────────────────────

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What the journal's `resource_id` may hold.
 *
 * That column is a `UUID`, and it records the **local** row an operation belongs to — the same value
 * the Gmail mutations pass. A provider id (a Google event id, a People resource name) is not a UUID:
 * binding one here is rejected by PostgreSQL before the provider is ever called, so the provider
 * identity travels in the payload and in `remote_object_links` instead, and a create (whose local row
 * does not exist yet) records none.
 */
export function journalResourceId(value: string | null | undefined): string | null {
  return value && UUID_PATTERN.test(value) ? value : null;
}

/**
 * Whether this installation may make a Google Calendar/People write call at all.
 *
 * The operator's layer switch, the per-provider/method switch and a configured OAuth client are
 * three separate reasons a Google write must not leave the process, and each is checked before any
 * outbound call rather than at the route, so a path added later cannot forget one of them.
 */
export async function googleWriteGate(): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (!providerIntegrationsEnabled()) {
    return { ok: false, status: 403, error: 'Provider integrations are disabled on this installation' };
  }
  const switches = await readProviderSwitches('google');
  if (!switches.enabled || !switches.apiEnabled) {
    return { ok: false, status: 403, error: 'Google Calendar and Contacts are switched off on this installation' };
  }
  if (!isGoogleConfigured(googleConfigFromEnv())) {
    return { ok: false, status: 409, error: 'Google API is not configured by the administrator' };
  }
  return { ok: true };
}

// ── Calendar events ──────────────────────────────────────────────────────────

/**
 * The local fields a Google event write sends.
 *
 * Times travel as the **instant in UTC with `timeZone: 'UTC'`**, exactly as the Microsoft adapter
 * does: the local model stores an instant and keeps the user's zone as metadata, so sending the
 * instant is faithful, while inventing a zone-specific wall clock from that metadata would move the
 * event whenever the two disagreed. An all-day event stays date-valued for the same reason.
 */
export interface GoogleEventWriteInput {
  summary: string | null;
  description: string | null;
  location: string | null;
  url: string | null;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  attendees: string[];
  /**
   * The series rule for this write. `undefined` says nothing about the rule, `null` makes the event a
   * one-off, and an object sets it. Google removes a recurrence when it receives an **empty** list, so the
   * clear must be an explicit `[]` rather than an omitted field.
   */
  recurrence?: ParsedRecurrence | null;
}

/** Google's `date` value: the calendar date of an all-day event, in the local UTC convention. */
function calendarDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The Google event body for a local event. `url` has no writable Google field and is not sent. */
export function googleEventPayloadFor(event: GoogleEventWriteInput): GoogleEventWritePayload {
  const payload: GoogleEventWritePayload = {
    summary: event.summary ?? '',
    start: event.allDay
      ? { date: calendarDate(event.startsAt) }
      : { dateTime: event.startsAt.toISOString(), timeZone: 'UTC' },
    // Google's all-day end date is exclusive, which is what the local model's next-midnight end means.
    end: event.allDay
      ? { date: calendarDate(event.endsAt) }
      : { dateTime: event.endsAt.toISOString(), timeZone: 'UTC' },
  };
  if (event.description) payload.description = event.description;
  if (event.location) payload.location = event.location;
  if (event.attendees.length) payload.attendees = event.attendees.map(email => ({ email }));
  // Google stores complete iCalendar lines; the local structure is the validated rule the route parsed.
  if (event.recurrence === null) {
    // An empty list is Google's way of removing the recurrence; an omitted field would leave it in place.
    payload.recurrence = [];
  } else if (event.recurrence) {
    const rrule = recurrenceToRRule(event.recurrence);
    if (rrule) payload.recurrence = [`RRULE:${rrule}`];
  }
  return payload;
}

export interface GoogleCalendarWriteTarget {
  kind: 'google';
  connectionId: string;
  collectionId: string;
  /** Google's own calendar id, as the sync stored it. */
  providerCalendarId: string;
  calendarId: string;
}

/**
 * What asking about a Google calendar answered. `not_google` means "this is not a writable Google
 * collection, keep the shared resolver's answer"; `refused` is a Google collection this installation
 * may not write right now, with the reason the caller shows.
 */
export type GoogleCalendarTargetResolution =
  | GoogleCalendarWriteTarget
  | { kind: 'refused'; status: number; error: string; code?: 'FEATURE_DISABLED' }
  | { kind: 'not_google' };

/**
 * Resolve a local calendar to its Google collection, or say it is not one.
 *
 * The query only returns a `source = 'google'` row, so a local or Microsoft calendar answers
 * `not_google` without a second query on the write path the shared resolver already owns.
 */
export async function resolveGoogleCalendarWriteTarget(userId: string, calendarId: string): Promise<GoogleCalendarTargetResolution> {
  const result = await query<{
    id: string; collection_id: string; remote_id: string | null; connection_id: string | null;
    account_id: string | null; feature_enabled: boolean | null;
    source_access: string | null; user_access: string | null;
  }>(
    `SELECT c.id, ic.id AS collection_id, ic.remote_id, ic.connection_id, ic.account_id,
            settings.enabled AS feature_enabled, ic.source_access, ic.user_access
       FROM calendars c
       JOIN integration_collections ic
         ON ic.local_calendar_id = c.id AND ic.kind = 'calendar' AND ic.user_id = c.user_id
       LEFT JOIN account_provider_feature_settings settings
         ON settings.account_id = ic.account_id AND settings.feature = 'calendars'
      WHERE c.id = $1 AND c.user_id = $2 AND c.owner_user_id = $2 AND c.source = 'google'`,
    [calendarId, userId],
  );
  const row = result.rows[0];
  if (!row) return { kind: 'not_google' };
  // The origin's permission and the user's write-back choice are the same two gates as everywhere else;
  // a Google collection they do not both permit stays refused by the shared resolver, unchanged.
  if (!collectionIsWritable({ source: 'google', source_access: row.source_access, user_access: row.user_access }, 'calendars')) {
    return { kind: 'not_google' };
  }
  if (!row.account_id || row.feature_enabled !== true) {
    return { kind: 'refused', status: 409, error: 'Calendars are disabled for this account', code: 'FEATURE_DISABLED' };
  }
  const gate = await googleWriteGate();
  if (!gate.ok) return { kind: 'refused', status: gate.status, error: gate.error };
  if (!row.connection_id) return { kind: 'refused', status: 409, error: 'This calendar is not linked to a Google connection' };
  return {
    kind: 'google',
    connectionId: row.connection_id,
    collectionId: row.collection_id,
    providerCalendarId: row.remote_id || 'primary',
    calendarId: row.id,
  };
}

export interface GoogleCalendarEventWritePayload {
  operation: 'create' | 'update' | 'delete';
  calendarId: string;
  eventId?: string | null;
  event?: GoogleEventWriteInput;
  /**
   * Whether Google notifies attendees itself. Sent on every write, including `none`, so the
   * notification behaviour is never Google's default but this caller's explicit choice.
   */
  sendUpdates: GoogleSendUpdates;
}

export interface GoogleEventWriteResult {
  event?: GoogleCalendarEvent | null;
}

/**
 * The Google calendar-event adapter.
 *
 * Declared **non-idempotent** for the same reason the Graph one is: a create addresses a calendar
 * rather than a resource, and Google's `events.insert` has no transaction-id field, so a replayed
 * create would be a second event; a delete answers `404` for an event that is already gone, which
 * cannot be told apart from "never existed". A recovered claim is therefore parked.
 */
export function googleCalendarEventMutationAdapter(options: {
  api: GoogleApiOptions;
  insert?: typeof insertGoogleEvent;
  patch?: typeof patchGoogleEvent;
  remove?: typeof deleteGoogleEvent;
}): ProviderMutationAdapter<GoogleCalendarEventWritePayload, GoogleEventWriteResult> {
  const insert = options.insert ?? insertGoogleEvent;
  const patch = options.patch ?? patchGoogleEvent;
  const remove = options.remove ?? deleteGoogleEvent;
  return {
    resourceType: 'calendar_event',
    idempotent: false,
    async perform(write): Promise<ProviderAdapterOutcome<GoogleEventWriteResult>> {
      try {
        if (write.operation === 'create') {
          if (!write.event) return { status: 'permanent', code: 'INVALID_REQUEST' };
          const created = await insert(options.api, write.calendarId, googleEventPayloadFor(write.event), { sendUpdates: write.sendUpdates });
          // An event Google answers without an id cannot be reconciled against a replay.
          if (!created?.id) return { status: 'outcome_unknown', code: 'EVENT_ID_MISSING' };
          return { status: 'committed', value: { event: created } };
        }
        if (!write.eventId) return { status: 'permanent', code: 'RESOURCE_NOT_FOUND' };
        if (write.operation === 'update') {
          if (!write.event) return { status: 'permanent', code: 'INVALID_REQUEST' };
          const updated = await patch(options.api, write.calendarId, write.eventId, googleEventPayloadFor(write.event), { sendUpdates: write.sendUpdates });
          return { status: 'committed', value: { event: updated } };
        }
        await remove(options.api, write.calendarId, write.eventId, { sendUpdates: write.sendUpdates });
        return { status: 'committed' };
      } catch (error) {
        // The shared Google classification: a throttle/quota answer is `retryable` (the provider did
        // not apply it), a 404/403/4xx is `permanent`, and anything unclassified is `outcome_unknown`.
        return classifyGmailMailMutationFailure(error);
      }
    },
  };
}

export type GoogleCalendarWriteOutcome =
  | { status: 'confirmed'; providerEventId: string; event: GoogleCalendarEvent | null }
  | { status: 'failed'; failure: ProviderWriteFailure };

/** Run one calendar-event write against Google through the journal, and report what happened. */
export async function writeGoogleCalendarEvent(input: {
  userId: string;
  target: GoogleCalendarWriteTarget;
  operation: 'create' | 'update' | 'delete';
  providerEventId?: string | null;
  event?: GoogleEventWriteInput;
  sendUpdates: GoogleSendUpdates;
  /** The local `calendar_events.id` this write belongs to, for the journal's `resource_id`. */
  localResourceId?: string | null;
  idempotencyKey?: string | null;
}): Promise<GoogleCalendarWriteOutcome> {
  const api = {
    userId: input.userId,
    connectionId: input.target.connectionId,
    config: googleConfigFromEnv(),
  };
  const payload: GoogleCalendarEventWritePayload = {
    operation: input.operation,
    calendarId: input.target.providerCalendarId,
    eventId: input.providerEventId ?? null,
    sendUpdates: input.sendUpdates,
    ...(input.event ? { event: input.event } : {}),
  };
  const result = await runProviderMutation(
    {
      userId: input.userId,
      channel: 'web',
      operation: input.operation,
      connectionId: input.target.connectionId,
      collectionId: input.target.collectionId,
      resourceId: journalResourceId(input.localResourceId),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      payload,
      timeoutMs: 20_000,
    },
    googleCalendarEventMutationAdapter({ api }),
  );
  if (result.status !== 'confirmed') return { status: 'failed', failure: providerWriteFailure(result) };
  const event = result.value?.event ?? null;
  const providerEventId = input.providerEventId ?? event?.id ?? null;
  if (!providerEventId) {
    return { status: 'failed', failure: { status: 502, error: 'The provider did not identify the saved event', code: 'EVENT_ID_MISSING' } };
  }
  return { status: 'confirmed', providerEventId, event };
}

/** Record the provider identity of a newly created local event, so the next delta updates it. */
export async function recordGoogleCalendarEventLink(input: {
  userId: string;
  target: GoogleCalendarWriteTarget;
  providerEventId: string;
  localId: string;
}): Promise<void> {
  await query(
    `INSERT INTO remote_object_links
       (user_id, connection_id, collection_id, object_type, local_id, collection_remote_id, object_remote_id, remote_href, status)
     VALUES ($1,$2,$3,'calendar_event',$4,$5,$6,$5,'active')
     ON CONFLICT (collection_id, object_remote_id) DO UPDATE SET
       local_id = EXCLUDED.local_id, status = 'active', updated_at = NOW()`,
    [input.userId, input.target.connectionId, input.target.collectionId, input.localId, input.target.providerCalendarId, input.providerEventId],
  );
}

/** Tombstone the link of an event removed at the provider. */
export async function removeGoogleCalendarEventLink(input: {
  userId: string;
  target: GoogleCalendarWriteTarget;
  providerEventId: string;
}): Promise<void> {
  await query(
    `UPDATE remote_object_links SET local_id = NULL, status = 'deleted', updated_at = NOW()
      WHERE collection_id = $1 AND user_id = $2 AND object_remote_id = $3`,
    [input.target.collectionId, input.userId, input.providerEventId],
  );
}

/** The Google event id a local event row is linked to. */
export async function googleEventIdForLocalRow(userId: string, collectionId: string, localId: string): Promise<string | null> {
  const result = await query<{ object_remote_id: string | null }>(
    `SELECT object_remote_id FROM remote_object_links
      WHERE collection_id = $1 AND user_id = $2 AND local_id = $3 AND object_type = 'calendar_event' AND status = 'active'`,
    [collectionId, userId, localId],
  );
  return result.rows[0]?.object_remote_id ?? null;
}

// ── Contacts ─────────────────────────────────────────────────────────────────

/** The Google date object for a vCard date (`1990-01-02`, or `--05-06` for no year). */
export function googlePersonDate(value: string | null | undefined): GooglePersonDate | null {
  if (!value) return null;
  const match = /^(?:(\d{4})-|--)(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day] = match;
  const parsed = { ...(year ? { year: Number(year) } : {}), month: Number(month), day: Number(day) };
  const daysInMonth = parsed.month === 2 ? 29 : ([4, 6, 9, 11].includes(parsed.month) ? 30 : 31);
  if (parsed.month < 1 || parsed.month > 12 || parsed.day < 1 || parsed.day > daysInMonth) return null;
  return parsed;
}

/**
 * The People name for a local contact.
 *
 * A contact with a structured first/last name is sent as one, so Google's own display-name rendering
 * applies; a contact that only has a display name is sent as an unstructured name. A contact with
 * neither is not sent at all — People requires a name, and clearing one is not a change this model
 * can express.
 */
function googleNameFor(contact: VCardContact): GooglePersonName | null {
  const givenName = contact.firstName?.trim();
  const familyName = contact.lastName?.trim();
  if (givenName || familyName) {
    return { ...(givenName ? { givenName } : {}), ...(familyName ? { familyName } : {}) };
  }
  const unstructuredName = contact.displayName?.trim();
  return unstructuredName ? { unstructuredName } : null;
}

/** The People `metadata.primary` marker belongs on at most one entry, the first the model marked. */
function primaryIndexOf(entries: ReadonlyArray<{ primary?: boolean }>): number {
  return entries.findIndex(entry => entry.primary === true);
}

export interface GoogleContactPayload {
  person: GooglePersonWrite;
  /** The `updatePersonFields` mask, naming exactly the fields `person` sets. */
  updateFields: string[];
}

/**
 * The People body and update mask for a local contact.
 *
 * The rule is: a field the caller supplied is replaced (an empty list clears it), and a field the
 * caller left out is untouched. `updateFields` is derived from the body rather than declared once, so
 * the two cannot disagree — a mask that names a field the body omits would clear it on Google.
 *
 * Only the fields {@link personToVCardContact} reads back are written. A local-only field (`role`,
 * `categories`, `contactDates`) is deliberately not sent: the next sync would drop it, so writing it
 * would silently destroy the user's own value.
 */
export function googleContactPayloadFor(contact: VCardContact, etag: string | null): GoogleContactPayload {
  const person: GooglePersonWrite = {};
  const updateFields: string[] = [];
  if (etag) person.etag = etag;

  const name = googleNameFor(contact);
  if (name) {
    person.names = [name];
    updateFields.push('names');
  }

  if (contact.nickname !== undefined) {
    person.nicknames = contact.nickname ? [{ value: contact.nickname }] : [];
    updateFields.push('nicknames');
  }

  if (contact.emails !== undefined) {
    const emails = (contact.emails ?? []).filter(entry => entry.value?.trim());
    const primary = primaryIndexOf(emails);
    person.emailAddresses = emails.map((entry, index) => ({
      value: String(entry.value).trim(),
      ...(entry.type ? { type: entry.type } : {}),
      ...(index === primary ? { metadata: { primary: true } } : {}),
    }));
    updateFields.push('emailAddresses');
  }

  if (contact.phones !== undefined) {
    const phones = (contact.phones ?? []).filter(entry => entry.value?.trim());
    const primary = primaryIndexOf(phones);
    person.phoneNumbers = phones.map((entry, index) => ({
      value: String(entry.value).trim(),
      ...(entry.type ? { type: entry.type } : {}),
      ...(index === primary ? { metadata: { primary: true } } : {}),
    }));
    updateFields.push('phoneNumbers');
  }

  if (contact.organization !== undefined || contact.title !== undefined) {
    const organization = contact.organization?.trim();
    const title = contact.title?.trim();
    person.organizations = organization || title
      ? [{ ...(organization ? { name: organization } : {}), ...(title ? { title } : {}) }]
      : [];
    updateFields.push('organizations');
  }

  if (contact.notes !== undefined) {
    person.biographies = contact.notes ? [{ value: contact.notes }] : [];
    updateFields.push('biographies');
  }

  if (contact.urls !== undefined) {
    person.urls = (contact.urls ?? [])
      .filter(entry => entry.value?.trim())
      .map(entry => ({ value: String(entry.value).trim(), ...(entry.type ? { type: entry.type } : {}) }));
    updateFields.push('urls');
  }

  if (contact.addresses !== undefined) {
    person.addresses = (contact.addresses ?? []).map(address => ({
      type: address.type ?? 'other',
      ...(address.pobox ? { poBox: address.pobox } : {}),
      ...(address.extended ? { extendedAddress: address.extended } : {}),
      ...(address.street ? { streetAddress: address.street } : {}),
      ...(address.locality ? { locality: address.locality } : {}),
      ...(address.region ? { region: address.region } : {}),
      ...(address.postalCode ? { postalCode: address.postalCode } : {}),
      ...(address.country ? { country: address.country } : {}),
    }));
    updateFields.push('addresses');
  }

  if (contact.birthday !== undefined) {
    const raw = contact.birthday?.trim();
    const date = googlePersonDate(raw);
    if (date) {
      person.birthdays = [{ date }];
      updateFields.push('birthdays');
    } else if (!raw) {
      // An explicitly emptied date clears it; a value this adapter cannot represent leaves it as it is
      // rather than destroying a field the caller did not mean to clear.
      person.birthdays = [];
      updateFields.push('birthdays');
    }
  }

  if (contact.anniversary !== undefined) {
    const raw = contact.anniversary?.trim();
    const date = googlePersonDate(raw);
    if (date) {
      // An anniversary is a dated event of type `anniversary`, which is the one `personToVCardContact` reads.
      person.events = [{ type: 'anniversary', date }];
      updateFields.push('events');
    } else if (!raw) {
      person.events = [];
      updateFields.push('events');
    }
  }

  if (contact.instantMessages !== undefined) {
    person.imClients = (contact.instantMessages ?? [])
      .filter(entry => entry.value?.trim())
      .map(entry => ({ username: String(entry.value).trim(), ...(entry.type ? { protocol: entry.type } : {}) }));
    updateFields.push('imClients');
  }

  return { person, updateFields };
}

export interface GoogleContactWriteTarget {
  kind: 'google';
  connectionId: string;
  collectionId: string;
  /** The collection's own remote id (`people/me`), which is what the read path links a person to. */
  collectionRemoteId: string;
  addressBookId: string;
}

export type GoogleContactTargetResolution =
  | GoogleContactWriteTarget
  | { kind: 'refused'; status: number; error: string; code?: 'FEATURE_DISABLED' }
  | { kind: 'not_google' };

/** Resolve a local address book to its Google collection, or say it is not one. */
export async function resolveGoogleContactWriteTarget(userId: string, addressBookId: string): Promise<GoogleContactTargetResolution> {
  const result = await query<{
    id: string; collection_id: string; remote_id: string | null; connection_id: string | null;
    account_id: string | null; feature_enabled: boolean | null;
    source_access: string | null; user_access: string | null;
  }>(
    `SELECT ab.id, ic.id AS collection_id, ic.remote_id, ic.connection_id, ic.account_id,
            settings.enabled AS feature_enabled, ic.source_access, ic.user_access
       FROM address_books ab
       JOIN integration_collections ic
         ON ic.local_address_book_id = ab.id AND ic.kind = 'address_book' AND ic.user_id = ab.user_id
       LEFT JOIN account_provider_feature_settings settings
         ON settings.account_id = ic.account_id AND settings.feature = 'contacts'
      WHERE ab.id = $1 AND ab.user_id = $2 AND ab.source = 'google'`,
    [addressBookId, userId],
  );
  const row = result.rows[0];
  if (!row) return { kind: 'not_google' };
  if (!collectionIsWritable({ source: 'google', source_access: row.source_access, user_access: row.user_access }, 'contacts')) {
    return { kind: 'not_google' };
  }
  if (!row.account_id || row.feature_enabled !== true) {
    return { kind: 'refused', status: 409, error: 'Contacts are disabled for this account', code: 'FEATURE_DISABLED' };
  }
  const gate = await googleWriteGate();
  if (!gate.ok) return { kind: 'refused', status: gate.status, error: gate.error };
  if (!row.connection_id) return { kind: 'refused', status: 409, error: 'This address book is not linked to a Google connection' };
  return {
    kind: 'google',
    connectionId: row.connection_id,
    collectionId: row.collection_id,
    collectionRemoteId: row.remote_id || GOOGLE_PERSONAL_COLLECTION_REMOTE_ID,
    addressBookId: row.id,
  };
}

export interface GoogleContactWritePayload {
  operation: 'create' | 'update' | 'delete';
  /** The People resource name (`people/c…`), for an update or delete. */
  resourceName?: string | null;
  person?: GooglePersonWrite;
  /** The `updatePersonFields` mask for `person`, for an update. */
  updateFields?: string[];
}

export interface GoogleContactWriteResult {
  /** The person a create/update returned, absent for a delete. */
  person?: GooglePerson | null;
}

/**
 * The Google People contact adapter.
 *
 * Non-idempotent as a whole, like the Graph one: a create addresses a collection, and a delete
 * answers `404` for a contact that is already gone, which cannot be told apart from "never existed".
 */
export function googleContactMutationAdapter(options: {
  api: GoogleApiOptions;
  create?: typeof createGooglePerson;
  update?: typeof updateGooglePerson;
  remove?: typeof deleteGooglePerson;
}): ProviderMutationAdapter<GoogleContactWritePayload, GoogleContactWriteResult> {
  const create = options.create ?? createGooglePerson;
  const update = options.update ?? updateGooglePerson;
  const remove = options.remove ?? deleteGooglePerson;
  return {
    resourceType: 'contact',
    idempotent: false,
    async perform(write): Promise<ProviderAdapterOutcome<GoogleContactWriteResult>> {
      try {
        if (write.operation === 'create') {
          const created = await create(options.api, write.person ?? {});
          // A create Google answers without a resource name cannot be reconciled against a replay.
          if (!created?.resourceName) return { status: 'outcome_unknown', code: 'CONTACT_ID_MISSING' };
          return { status: 'committed', value: { person: created } };
        }
        const resourcePath = write.resourceName ? personResourcePath(write.resourceName) : null;
        if (!resourcePath) return { status: 'permanent', code: 'RESOURCE_NOT_FOUND' };
        if (write.operation === 'update') {
          // An empty mask would ask People to replace nothing; refuse it rather than issue a call
          // whose effect is not the one the caller described.
          if (!write.person || !write.updateFields?.length) return { status: 'permanent', code: 'INVALID_REQUEST' };
          const updated = await update(options.api, resourcePath, write.person, write.updateFields);
          return { status: 'committed', value: { person: updated } };
        }
        await remove(options.api, resourcePath);
        return { status: 'committed' };
      } catch (error) {
        return classifyGmailMailMutationFailure(error);
      }
    },
  };
}

export type GoogleContactWriteOutcome =
  | { status: 'confirmed'; providerContactId: string; person: GooglePerson | null }
  | { status: 'failed'; failure: ProviderWriteFailure };

/** Run one contact write against Google through the journal, and report what happened. */
export async function writeGoogleContact(input: {
  userId: string;
  target: GoogleContactWriteTarget;
  operation: 'create' | 'update' | 'delete';
  providerContactId?: string | null;
  contact?: VCardContact;
  /**
   * The etag the read path stored for this person. People's `updateContact` requires it for a
   * contact-source person, so it is carried from the link rather than fetched again.
   */
  etag?: string | null;
  /** The local `contacts.id` this write belongs to, for the journal's `resource_id`. */
  localResourceId?: string | null;
  idempotencyKey?: string | null;
}): Promise<GoogleContactWriteOutcome> {
  const api = {
    userId: input.userId,
    connectionId: input.target.connectionId,
    config: googleConfigFromEnv(),
  };
  const mapped = input.contact ? googleContactPayloadFor(input.contact, input.etag ?? null) : null;
  const payload: GoogleContactWritePayload = {
    operation: input.operation,
    resourceName: input.providerContactId ?? null,
    ...(mapped ? { person: mapped.person, updateFields: mapped.updateFields } : {}),
  };
  const result = await runProviderMutation(
    {
      userId: input.userId,
      channel: 'web',
      operation: input.operation,
      connectionId: input.target.connectionId,
      collectionId: input.target.collectionId,
      resourceId: journalResourceId(input.localResourceId),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      payload,
      timeoutMs: 20_000,
    },
    googleContactMutationAdapter({ api }),
  );
  if (result.status !== 'confirmed') return { status: 'failed', failure: providerWriteFailure(result) };
  const person = result.value?.person ?? null;
  const providerContactId = input.providerContactId ?? person?.resourceName ?? null;
  if (!providerContactId) {
    return { status: 'failed', failure: { status: 502, error: 'The provider did not identify the saved contact', code: 'CONTACT_ID_MISSING' } };
  }
  return { status: 'confirmed', providerContactId, person };
}

/** Record the provider identity of a newly created local contact, so the next delta updates it. */
export async function recordGoogleContactLink(input: {
  userId: string;
  target: GoogleContactWriteTarget;
  providerContactId: string;
  localId: string;
  etag?: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO remote_object_links
       (user_id, connection_id, collection_id, object_type, local_id, collection_remote_id, object_remote_id, remote_href, remote_version, status)
     VALUES ($1,$2,$3,'contact',$4,$5,$6,$5,$7,'active')
     ON CONFLICT (collection_id, object_remote_id) DO UPDATE SET
       local_id = EXCLUDED.local_id, remote_version = EXCLUDED.remote_version, status = 'active', updated_at = NOW()`,
    [
      input.userId, input.target.connectionId, input.target.collectionId, input.localId,
      input.target.collectionRemoteId, input.providerContactId, input.etag ?? null,
    ],
  );
}

/** Tombstone the link of a contact removed at the provider. */
export async function removeGoogleContactLink(input: {
  userId: string;
  target: GoogleContactWriteTarget;
  providerContactId: string;
}): Promise<void> {
  await query(
    `UPDATE remote_object_links SET local_id = NULL, status = 'deleted', updated_at = NOW()
      WHERE collection_id = $1 AND user_id = $2 AND object_remote_id = $3`,
    [input.target.collectionId, input.userId, input.providerContactId],
  );
}

/** The People identity and version a local contact row is linked to. */
export async function googlePersonLinkForLocalRow(userId: string, collectionId: string, localId: string): Promise<{ resourceName: string; etag: string | null } | null> {
  const result = await query<{ object_remote_id: string | null; remote_version: string | null }>(
    `SELECT object_remote_id, remote_version FROM remote_object_links
      WHERE collection_id = $1 AND user_id = $2 AND local_id = $3 AND object_type = 'contact' AND status = 'active'`,
    [collectionId, userId, localId],
  );
  const row = result.rows[0];
  if (!row?.object_remote_id) return null;
  return { resourceName: row.object_remote_id, etag: row.remote_version ?? null };
}

/** The local uid a provider-created contact must carry so a later sync updates this row. */
export function localUidForGoogleContact(providerContactId: string): string {
  return contactUidForPerson(providerContactId);
}
