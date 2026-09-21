import type { PoolClient } from 'pg';
import { withSavepoint, withTransaction } from '../../db.js';
import { toAppError } from '../../../utils/errors.js';
import {
  acquireSyncLease,
  commitSyncCheckpoint,
  ensureSyncState,
  failSyncRun,
  finishSyncRun,
  readSyncState,
  releaseSyncLease,
} from '../../syncCoordinator.js';
import { GoogleApiError } from './googleApiClient.js';
import type { GoogleApiOptions } from './googleApiClient.js';
import { fetchCalendarEvents, fetchCalendarList, buildGoogleSeriesICalendar } from './googleCalendar.js';
import type { GoogleCalendarEvent, GoogleCalendarListEntry } from './googleCalendar.js';
import {
  applyProviderCalendarEventGroup,
  reconcileProviderCalendarCollection,
  type CalendarProjectionContext,
  type CalendarResourceAdapters,
} from '../providerCalendarProjection.js';
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

type ApplyContext = CalendarProjectionContext;

/** The adapter hooks the shared projection needs for a Google batch. */
const GOOGLE_PROJECTION: CalendarResourceAdapters<GoogleCalendarEvent> = {
  buildResource: (group, context) => buildGoogleSeriesICalendar({
    master: group.master,
    overrides: group.overrides,
    defaultTimeZone: context.defaultTimeZone,
  }),
  isCancelled: event => event.status === 'cancelled',
  fallbackUid: remoteId => `${remoteId}@google.com`,
};

function calendarColor(entry: GoogleCalendarListEntry): string {
  return typeof entry.backgroundColor === 'string' && /^#[0-9a-f]{6}$/i.test(entry.backgroundColor)
    ? entry.backgroundColor
    : DEFAULT_COLOR;
}

/**
 * What the provider itself permits for one calendar.
 *
 * Google states it as the calendar's `accessRole`: `owner` and `writer` may be written, `reader` and
 * `freeBusyReader` may not. This is the same fact Graph's `canEdit` carries, and it is what the
 * write-back switch consults before enabling writes, so a shared read-only calendar can never be offered
 * as writable and a role that changes (a share upgraded to writer) is picked up at the next discovery.
 */
export function googleCalendarSourceAccess(entry: GoogleCalendarListEntry): 'read_only' | 'read_write' {
  return entry.accessRole === 'owner' || entry.accessRole === 'writer' ? 'read_write' : 'read_only';
}

/** Find or create the local calendar and collection link for one Google calendar. */
export async function ensureGoogleCalendarCollection(client: PoolClient, input: {
  userId: string;
  connectionId: string;
  entry: GoogleCalendarListEntry;
}): Promise<void> {
  const sourceAccess = googleCalendarSourceAccess(input.entry);
  const linkQuery = `SELECT id, local_calendar_id FROM integration_collections
     WHERE connection_id = $1 AND kind = 'calendar' AND remote_id = $2`;
  const existing = await client.query<{ id: string; local_calendar_id: string | null }>(
    linkQuery,
    [input.connectionId, input.entry.id],
  );
  if (existing.rows[0]?.local_calendar_id) {
    // Already linked. `enabled` and `user_access` are **not** re-asserted — switching a collection the
    // user disabled back on, or undoing their write-back choice, would both be wrong. `source_access` is
    // the provider's own fact rather than the user's, and it can change (a share upgraded to writer), so
    // it is refreshed and nothing else is touched.
    await client.query(
      `UPDATE integration_collections SET source_access = $2, updated_at = NOW()
        WHERE id = $1 AND source_access IS DISTINCT FROM $2`,
      [existing.rows[0].id, sourceAccess],
    );
    return;
  }

  const label = input.entry.summary?.trim() || input.entry.id;
  for (let attempt = 0; attempt < 20; attempt++) {
    const name = attempt === 0 ? label : `${label} (${attempt + 1})`;
    try {
      // Each attempt runs under its own savepoint: a `23505` on the local name aborts the surrounding
      // transaction, so retrying the INSERT on the same client could only have failed with `25P02` (DB-01).
      await withSavepoint(client, `google_calendar_${attempt}`, async () => {
        const calendar = await client.query<{ id: string }>(
          // A provider calendar starts read-only and hidden from DAV devices.
          `INSERT INTO calendars (user_id, owner_user_id, name, color, source, read_only, dav_mode)
           VALUES ($1, $1, $2, $3, 'google', true, 'off') RETURNING id`,
          [input.userId, name, calendarColor(input.entry)],
        );
        const calendarId = calendar.rows[0]?.id;
        if (!calendarId) throw new Error('Could not create the Google calendar');

        if (existing.rows[0]) {
          await client.query(
            `UPDATE integration_collections
                SET local_calendar_id = $2, enabled = true, source_access = $3, user_access = 'source',
                    dav_mode = 'off', updated_at = NOW()
              WHERE id = $1`,
            [existing.rows[0].id, calendarId, sourceAccess],
          );
          return;
        }

        const collection = await client.query<{ id: string }>(
          `INSERT INTO integration_collections
             (user_id, connection_id, kind, remote_id, local_calendar_id, enabled, source_access, user_access, dav_mode)
           VALUES ($1, $2, 'calendar', $3, $4, true, $5, 'source', 'off')
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [input.userId, input.connectionId, input.entry.id, calendarId, sourceAccess],
        );
        const collectionId = collection.rows[0]?.id
          ?? (await client.query<{ id: string }>(linkQuery, [input.connectionId, input.entry.id])).rows[0]?.id;
        if (!collectionId) throw new Error('Could not link the Google calendar');
      });
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

/**
 * Apply one Google master group through the shared provider projection, so Google and Microsoft
 * cannot drift in how a recurring set becomes one local resource.
 */
export async function applyGoogleEventGroup(client: PoolClient, context: ApplyContext, remoteId: string, group: {
  master: GoogleCalendarEvent | null;
  overrides: GoogleCalendarEvent[];
}): Promise<'created' | 'updated' | 'deleted' | 'skipped'> {
  return applyProviderCalendarEventGroup(client, context, remoteId, group, GOOGLE_PROJECTION);
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
    let rebuilt = false;
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
          rebuilt = true;
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
    const groups = groupGoogleEvents(events);
    for (const [remoteId, group] of groups) {
      const applied = await withTransaction(client => applyGoogleEventGroup(client, applyContext, remoteId, group));
      totals[applied] += 1;
    }
    // A rebuild read a complete baseline, so a resource it omits was deleted while the cursor was
    // unusable; an incremental batch must never be reconciled this way.
    if (rebuilt) {
      const removed = await withTransaction(client => reconcileProviderCalendarCollection(
        client, { userId: context.userId, collectionId: collection.id }, new Set(groups.keys()),
      ));
      totals.deleted += removed;
    }

    // The cursor advances only after every group was applied, so a crash mid-run
    // re-reads from the previous cursor instead of skipping changes.
    const committed = await withTransaction(async client => {
      const saved = await commitSyncCheckpoint(client, {
        syncStateId,
        generation: lease.generation,
        cursor: nextSyncToken ?? cursor,
        clearPageCheckpoint: true,
        lastErrorCode: null,
      });
      if (!saved) return false;
      // The run applied every group it was asked for, so it may claim a successful synchronisation (SYNC-02).
      return finishSyncRun(client, { syncStateId, generation: lease.generation, lastErrorCode: null });
    });
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
