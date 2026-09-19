import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { withTransaction } from '../../db.js';
import { toAppError } from '../../../utils/errors.js';
import { parseCalendarEvent } from '../../../utils/ical.js';
import {
  acquireSyncLease,
  commitSyncCheckpoint,
  ensureSyncState,
  failSyncRun,
  readSyncState,
  releaseSyncLease,
} from '../../syncCoordinator.js';
import { GoogleApiError } from './googleApiClient.js';
import type { GoogleApiOptions } from './googleApiClient.js';
import { fetchCalendarEvents, fetchCalendarList, buildGoogleSeriesICalendar } from './googleCalendar.js';
import type { GoogleCalendarEvent, GoogleCalendarListEntry } from './googleCalendar.js';
import { mergeGoogleCalendarResource } from './googleCalendarMerge.js';
import { ProviderAuthError } from '../../providerAuthService.js';
import type { FetchLike, GoogleConfig } from '../../providerAuthService.js';

/**
 * Google Calendar read sync (P09).
 *
 * One local calendar per Google calendar, created read-only with DAV access
 * disabled. A Google event id is the remote identity; the local resource keeps the
 * whole series (the plan forbids fragmenting it), so Google's master and its
 * instance overrides are merged into the single resource DAV requires.
 *
 * The per-collection cursor is stored under the P03 lease: only one sync runs per
 * collection, and a restarted worker cannot advance the cursor out of order. A
 * cursor the provider rejects (HTTP 410) rebuilds that collection from a baseline.
 */

const MAX_PAGES = 1000;
const PAGE_SIZE = 1000;
const DEFAULT_COLOR = '#4285f4';

export interface GoogleCalendarSyncResult {
  collections: number;
  created: number;
  updated: number;
  deleted: number;
  skipped: number;
  fullSync: boolean;
  errors: Array<{ calendarId: string; code: string }>;
}

interface CalendarCollection {
  id: string;
  remoteId: string;
  localCalendarId: string;
}

interface ApplyContext {
  userId: string;
  connectionId: string;
  collectionId: string;
  /** The provider's own calendar id, stored as the remote collection reference. */
  remoteCalendarId: string;
  calendarId: string;
  defaultTimeZone: string | null;
}

function calendarColor(entry: GoogleCalendarListEntry): string {
  return typeof entry.backgroundColor === 'string' && /^#[0-9a-f]{6}$/i.test(entry.backgroundColor)
    ? entry.backgroundColor
    : DEFAULT_COLOR;
}

/** Find or create the local calendar and collection link for one Google calendar. */
export async function ensureGoogleCalendarCollection(client: PoolClient, input: {
  userId: string;
  connectionId: string;
  entry: GoogleCalendarListEntry;
}): Promise<void> {
  const linkQuery = `SELECT id, local_calendar_id FROM integration_collections
     WHERE connection_id = $1 AND kind = 'calendar' AND remote_id = $2`;
  const existing = await client.query<{ id: string; local_calendar_id: string | null }>(
    linkQuery,
    [input.connectionId, input.entry.id],
  );
  if (existing.rows[0]?.local_calendar_id) {
    await client.query(
      `UPDATE integration_collections
          SET enabled = true, source_access = 'read_only', user_access = 'source', dav_mode = 'off', updated_at = NOW()
        WHERE id = $1`,
      [existing.rows[0].id],
    );
    return;
  }

  const label = input.entry.summary?.trim() || input.entry.id;
  for (let attempt = 0; attempt < 20; attempt++) {
    const name = attempt === 0 ? label : `${label} (${attempt + 1})`;
    try {
      const created = await client.query<{ id: string }>(
        // A provider calendar starts read-only and hidden from DAV devices.
        `INSERT INTO calendars (user_id, owner_user_id, name, color, source, read_only, dav_mode)
         VALUES ($1, $1, $2, $3, 'google', true, 'off') RETURNING id`,
        [input.userId, name, calendarColor(input.entry)],
      );
      const calendarId = created.rows[0]?.id;
      if (!calendarId) throw new Error('Could not create the Google calendar');

      if (existing.rows[0]) {
        await client.query(
          `UPDATE integration_collections
              SET local_calendar_id = $2, enabled = true, source_access = 'read_only', user_access = 'source',
                  dav_mode = 'off', updated_at = NOW()
            WHERE id = $1`,
          [existing.rows[0].id, calendarId],
        );
        return;
      }

      const collection = await client.query<{ id: string }>(
        `INSERT INTO integration_collections
           (user_id, connection_id, kind, remote_id, local_calendar_id, enabled, source_access, user_access, dav_mode)
         VALUES ($1, $2, 'calendar', $3, $4, true, 'read_only', 'source', 'off')
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [input.userId, input.connectionId, input.entry.id, calendarId],
      );
      const collectionId = collection.rows[0]?.id
        ?? (await client.query<{ id: string }>(linkQuery, [input.connectionId, input.entry.id])).rows[0]?.id;
      if (!collectionId) throw new Error('Could not link the Google calendar');
      return;
    } catch (caught) {
      if (toAppError(caught).code === '23505') continue; // name taken — try the next suffix
      throw caught;
    }
  }
  throw new Error('Could not create the Google calendar');
}

/** Group a batch by remote master id: overrides travel with their master. */
export function groupGoogleEvents(events: readonly GoogleCalendarEvent[]): Map<string, { master: GoogleCalendarEvent | null; overrides: GoogleCalendarEvent[] }> {
  const groups = new Map<string, { master: GoogleCalendarEvent | null; overrides: GoogleCalendarEvent[] }>();
  const ensure = (id: string) => {
    if (!groups.has(id)) groups.set(id, { master: null, overrides: [] });
    return groups.get(id)!;
  };
  for (const event of events) {
    if (event.recurringEventId) ensure(event.recurringEventId).overrides.push(event);
    else ensure(event.id).master = event;
  }
  return groups;
}

async function upsertLink(client: PoolClient, context: ApplyContext, remoteId: string, input: {
  localId: string | null;
  etag: string | null;
  status: 'active' | 'deleted';
}): Promise<void> {
  await client.query(
    `INSERT INTO remote_object_links
       (user_id, connection_id, collection_id, object_type, local_id, collection_remote_id, object_remote_id, remote_href, remote_version, status)
     VALUES ($1,$2,$3,'calendar_event',$4,$5,$6,$7,$8,$9)
     ON CONFLICT (collection_id, object_remote_id) DO UPDATE SET
       local_id = EXCLUDED.local_id, remote_version = EXCLUDED.remote_version,
       status = EXCLUDED.status, updated_at = NOW()`,
    [
      context.userId, context.connectionId, context.collectionId, input.localId,
      context.remoteCalendarId, remoteId, context.remoteCalendarId, input.etag, input.status,
    ],
  );
}

/**
 * Apply one master group: delete a cancelled master, otherwise merge the batch into
 * the stored resource and update the projection columns.
 */
export async function applyGoogleEventGroup(client: PoolClient, context: ApplyContext, remoteId: string, group: {
  master: GoogleCalendarEvent | null;
  overrides: GoogleCalendarEvent[];
}): Promise<'created' | 'updated' | 'deleted' | 'skipped'> {
  const link = await client.query<{ id: string; local_id: string | null }>(
    `SELECT id, local_id FROM remote_object_links WHERE collection_id = $1 AND object_remote_id = $2`,
    [context.collectionId, remoteId],
  );
  let localId = link.rows[0]?.local_id ?? null;

  if (group.master?.status === 'cancelled') {
    if (localId) await client.query('DELETE FROM calendar_events WHERE id = $1 AND user_id = $2', [localId, context.userId]);
    await upsertLink(client, context, remoteId, { localId: null, etag: null, status: 'deleted' });
    return localId ? 'deleted' : 'skipped';
  }

  const incoming = buildGoogleSeriesICalendar({
    master: group.master,
    overrides: group.overrides,
    defaultTimeZone: context.defaultTimeZone,
  });
  if (!incoming) return 'skipped';

  let existingRaw: string | null = null;
  if (localId) {
    const stored = await client.query<{ raw_ical: string | null }>(
      'SELECT raw_ical FROM calendar_events WHERE id = $1 AND user_id = $2',
      [localId, context.userId],
    );
    existingRaw = stored.rows[0]?.raw_ical ?? null;
  }
  // A batch that carries only overrides cannot create the resource on its own.
  if (!existingRaw && !group.master) return 'skipped';

  const mergedRaw = mergeGoogleCalendarResource(existingRaw, incoming);
  if (!mergedRaw) return 'skipped';
  const parsed = parseCalendarEvent(mergedRaw);
  if (!parsed) return 'skipped';

  const etag = crypto.createHash('sha256').update(mergedRaw).digest('hex');
  const uid = parsed.uid || `${remoteId}@google.com`;
  const columns = [
    parsed.summary ?? null, parsed.description ?? null, parsed.location ?? null, parsed.url ?? null,
    parsed.organizer ?? null, parsed.startsAt, parsed.endsAt, parsed.allDay, parsed.timeZone,
  ];

  let outcome: 'created' | 'updated' = 'updated';
  if (localId) {
    const updated = await client.query<{ id: string }>(
      `UPDATE calendar_events
          SET raw_ical = $1, etag = $2, summary = $3, description = $4, location = $5, url = $6,
              organizer = $7, starts_at = $8, ends_at = $9, all_day = $10, timezone = $11,
              attendees = $12::jsonb, updated_at = NOW()
        WHERE id = $13 AND user_id = $14
        RETURNING id`,
      [mergedRaw, etag, ...columns, JSON.stringify(parsed.attendees), localId, context.userId],
    );
    if (!updated.rows.length) localId = null;
  }
  if (!localId) {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO calendar_events
         (calendar_id, user_id, uid, recurrence_id, raw_ical, etag, summary, description, location, url,
          organizer, starts_at, ends_at, all_day, timezone, attendees)
       VALUES ($1,$2,$3,'',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
       ON CONFLICT (calendar_id, uid, recurrence_id) DO UPDATE SET
         raw_ical = EXCLUDED.raw_ical, etag = EXCLUDED.etag, summary = EXCLUDED.summary,
         description = EXCLUDED.description, location = EXCLUDED.location, url = EXCLUDED.url,
         organizer = EXCLUDED.organizer, starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at,
         all_day = EXCLUDED.all_day, timezone = EXCLUDED.timezone, attendees = EXCLUDED.attendees,
         updated_at = NOW()
       RETURNING id`,
      [context.calendarId, context.userId, uid, mergedRaw, etag, ...columns, JSON.stringify(parsed.attendees)],
    );
    localId = inserted.rows[0]?.id ?? null;
    if (!localId) return 'skipped';
    outcome = link.rows[0] ? 'updated' : 'created';
  }

  await upsertLink(client, context, remoteId, { localId, etag, status: 'active' });
  return outcome;
}

async function listAllCalendars(api: GoogleApiOptions): Promise<GoogleCalendarListEntry[]> {
  const calendars: GoogleCalendarListEntry[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await fetchCalendarList(api, { pageToken });
    calendars.push(...result.calendars);
    pageToken = result.nextPageToken;
    if (!pageToken) break;
  }
  return calendars;
}

async function syncCollection(api: GoogleApiOptions, collection: CalendarCollection, context: Omit<ApplyContext, 'collectionId' | 'calendarId' | 'remoteCalendarId'>): Promise<{
  created: number; updated: number; deleted: number; skipped: number; fullSync: boolean;
}> {
  const syncStateId = await withTransaction(client => ensureSyncState(client, {
    userId: context.userId,
    connectionId: context.connectionId,
    feature: 'calendars',
    collectionId: collection.id,
    coverage: 'events',
  }));
  const owner = `google-calendar:${collection.id}`;
  const lease = await withTransaction(client => acquireSyncLease(client, { syncStateId, owner }));
  if (!lease) {
    throw new GoogleApiError({
      code: 'RATE_LIMITED',
      message: 'Another Google calendar sync is already running for this calendar',
      status: 409,
      retryable: true,
    });
  }

  const totals = { created: 0, updated: 0, deleted: 0, skipped: 0, fullSync: false };
  try {
    const state = await withTransaction(client => readSyncState(client, syncStateId));
    let cursor = state?.cursor ?? null;
    totals.fullSync = cursor === null;
    let pageToken: string | null = null;
    let nextSyncToken: string | null = null;
    const events: GoogleCalendarEvent[] = [];

    for (let page = 0; page < MAX_PAGES; page++) {
      let fetched;
      try {
        fetched = await fetchCalendarEvents(api, collection.remoteId, { pageToken, syncToken: cursor, maxResults: PAGE_SIZE });
      } catch (caught) {
        // Lost history: reconcile the whole calendar from a fresh baseline.
        if (caught instanceof GoogleApiError && caught.code === 'INVALID_SYNC_CURSOR' && cursor) {
          cursor = null;
          pageToken = null;
          events.length = 0;
          totals.fullSync = true;
          continue;
        }
        throw caught;
      }
      events.push(...fetched.events);
      if (fetched.nextSyncToken) nextSyncToken = fetched.nextSyncToken;
      pageToken = fetched.nextPageToken;
      if (!pageToken) break;
    }

    const applyContext: ApplyContext = {
      ...context,
      collectionId: collection.id,
      remoteCalendarId: collection.remoteId,
      calendarId: collection.localCalendarId,
    };
    for (const [remoteId, group] of groupGoogleEvents(events)) {
      const applied = await withTransaction(client => applyGoogleEventGroup(client, applyContext, remoteId, group));
      totals[applied] += 1;
    }

    // The cursor advances only after every group was applied, so a crash mid-run
    // re-reads from the previous cursor instead of skipping changes.
    const committed = await withTransaction(client => commitSyncCheckpoint(client, {
      syncStateId,
      generation: lease.generation,
      cursor: nextSyncToken ?? cursor,
      clearPageCheckpoint: true,
      lastErrorCode: null,
    }));
    if (!committed) {
      throw new GoogleApiError({
        code: 'MUTATION_OUTCOME_UNKNOWN',
        message: 'The sync lease was lost before the cursor could be stored',
        status: 409,
      });
    }
    await withTransaction(client => releaseSyncLease(client, { syncStateId, generation: lease.generation })).catch(() => {});
    return totals;
  } catch (caught) {
    const code = caught instanceof GoogleApiError || caught instanceof ProviderAuthError ? caught.code : 'INTERNAL_ERROR';
    await withTransaction(client => failSyncRun(client, { syncStateId, generation: lease.generation, errorCode: code })).catch(() => {});
    throw caught;
  }
}

/**
 * Synchronise every calendar of one Google connection. One calendar failing does
 * not stop the others; its failure is reported per collection.
 */
export async function syncGoogleCalendar(input: {
  userId: string;
  connectionId: string;
  config: GoogleConfig;
  fetchImpl?: FetchLike;
}): Promise<GoogleCalendarSyncResult> {
  const api: GoogleApiOptions = {
    userId: input.userId,
    connectionId: input.connectionId,
    config: input.config,
    owner: `google-calendar:${input.connectionId}`,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  };
  const calendars = await listAllCalendars(api);
  await withTransaction(async client => {
    // One client, so the discovery writes run in sequence on the same connection.
    for (const entry of calendars) {
      await ensureGoogleCalendarCollection(client, { userId: input.userId, connectionId: input.connectionId, entry });
    }
  });

  const stored = await withTransaction(client => client.query<{ id: string; remote_id: string; local_calendar_id: string }>(
    `SELECT id, remote_id, local_calendar_id FROM integration_collections
      WHERE user_id = $1 AND connection_id = $2 AND kind = 'calendar' AND local_calendar_id IS NOT NULL
      ORDER BY created_at ASC`,
    [input.userId, input.connectionId],
  ));
  const collections: CalendarCollection[] = stored.rows.map(row => ({
    id: row.id,
    remoteId: row.remote_id,
    localCalendarId: row.local_calendar_id,
  }));
  const defaultTimeZone = calendars.find(entry => entry.primary)?.timeZone ?? calendars[0]?.timeZone ?? null;

  const result: GoogleCalendarSyncResult = {
    collections: collections.length,
    created: 0, updated: 0, deleted: 0, skipped: 0, fullSync: false, errors: [],
  };
  for (const collection of collections) {
    try {
      const totals = await syncCollection(api, collection, {
        userId: input.userId,
        connectionId: input.connectionId,
        defaultTimeZone,
      });
      result.created += totals.created;
      result.updated += totals.updated;
      result.deleted += totals.deleted;
      result.skipped += totals.skipped;
      result.fullSync = result.fullSync || totals.fullSync;
    } catch (caught) {
      result.errors.push({
        calendarId: collection.remoteId,
        code: caught instanceof GoogleApiError || caught instanceof ProviderAuthError ? caught.code : 'INTERNAL_ERROR',
      });
    }
  }
  return result;
}
