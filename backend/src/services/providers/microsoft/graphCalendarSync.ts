import type { PoolClient } from 'pg';
import { withSavepoint, withTransaction } from '../../db.js';
import { toAppError } from '../../../utils/errors.js';
import { lockCalendarCollection, isCalendarCollectionDeleted, assertCalendarCollectionPresent, withCalendarCollectionSyncFence, CalendarCollectionDeletedError } from '../../calendarCollectionFence.js';
import {
  acquireSyncLease,
  commitSyncCheckpoint,
  ensureSyncState,
  failSyncRun,
  finishSyncRun,
  readSyncState,
  releaseSyncLease,
  SyncLeaseLostError,
} from '../../syncCoordinator.js';
import { GraphApiError } from './graphApiClient.js';
import type { GraphApiOptions } from './graphApiClient.js';
import {
  buildGraphSeriesICalendar,
  fetchGraphCalendarEventsPage,
  fetchGraphCalendarsPage,
  graphCalendarAllowsWrites,
  graphCalendarColor,
  graphEventIsCancelled,
  groupGraphEvents,
} from './graphCalendar.js';
import type { GraphCalendar, GraphEvent } from './graphCalendar.js';
import {
  applyProviderCalendarEventGroup,
  reconcileProviderCalendarCollection,
  type CalendarProjectionContext,
  type CalendarResourceAdapters,
} from '../providerCalendarProjection.js';
import { ProviderAuthError } from '../../providerAuthService.js';
import type { FetchLike } from '../../providerAuthService.js';
import type { MicrosoftConfig } from '../../providerAuthService.js';

/**
 * Microsoft Graph **calendar read sync** (P07d).
 *
 * The shape is the Google one, deliberately: one local calendar per provider calendar, created read-only
 * with DAV access off, linked through `integration_collections`, synced under the P03 lease with a
 * per-collection delta cursor stored only after every group was applied, and rebuilt from a baseline when
 * the provider rejects the cursor. What differs is the provider: Graph's cursor is an absolute
 * `@odata.deltaLink` rather than a sync token, so the stored cursor is that link, and its `@removed`
 * tombstones are how a deletion in Outlook reaches Inboxora.
 *
 * Permission mapping is a stored fact rather than a guess: a calendar Graph marks `canEdit: false` can
 * never be offered for write-back, and the collection's `source_access` records whether the provider
 * allows writes at all.
 */

const MAX_PAGES = 1000;
const PAGE_SIZE = 100;

export interface GraphCalendarSyncResult {
  collections: number;
  created: number;
  updated: number;
  deleted: number;
  skipped: number;
  fullSync: boolean;
  errors: Array<{ calendarId: string; code: string }>;
  /** Collections whose delta or baseline did not reach its end within one run (SYNC-04). */
  incompleteCollections: number;
}

interface CalendarCollection {
  id: string;
  remoteId: string;
  localCalendarId: string;
}

type ApplyContext = CalendarProjectionContext;

/** The adapter hooks the shared projection needs for a Graph batch. */
const GRAPH_PROJECTION: CalendarResourceAdapters<GraphEvent> = {
  buildResource: (group, context) => buildGraphSeriesICalendar({
    master: group.master,
    overrides: group.overrides,
    defaultTimeZone: context.defaultTimeZone,
  }),
  isCancelled: graphEventIsCancelled,
  fallbackUid: remoteId => `${remoteId}@microsoft.com`,
  // Graph's own version of the item, not a local hash (CAL-05).
  remoteVersion: group => group.master?.changeKey ?? null,
};

/**
 * Find or create the local calendar and collection link for one Graph calendar.
 *
 * A calendar the provider refuses to edit is stored with `source_access = 'read_only'`; one it allows is
 * still pulled read-only, but the link records that the source permits writes, which is what a later
 * write-back can consult instead of asking Inboxora's own column.
 */
export async function ensureGraphCalendarCollection(client: PoolClient, input: {
  userId: string;
  connectionId: string;
  entry: GraphCalendar;
}): Promise<void> {
  const identity = { userId: input.userId, connectionId: input.connectionId, remoteCalendarId: input.entry.id };
  await lockCalendarCollection(client, identity);
  if (await isCalendarCollectionDeleted(client, identity)) return;
  const linkQuery = `SELECT id, local_calendar_id FROM integration_collections
     WHERE connection_id = $1 AND kind = 'calendar' AND remote_id = $2 AND user_id = $3`;
  const existing = await client.query<{ id: string; local_calendar_id: string | null }>(
    linkQuery,
    [input.connectionId, input.entry.id, input.userId],
  );
  const sourceAccess = graphCalendarAllowsWrites(input.entry) ? 'read_write' : 'read_only';
  if (existing.rows[0]?.local_calendar_id) {
    // Already linked. Refresh only the provider's own fact: `source_access` really can change when a share
    // gains or loses write permission, and the card and the writers read it. `enabled` and `user_access` are
    // the user's choices — re-asserting `enabled` here would switch a collection they disabled back on at the
    // next refresh (SYNC-09). Google already did this; Graph did not, so a revoked write permission stayed in
    // the local description.
    await client.query(
      `UPDATE integration_collections SET source_access = $2, updated_at = NOW()
        WHERE id = $1 AND source_access IS DISTINCT FROM $2`,
      [existing.rows[0].id, sourceAccess],
    );
    return;
  }

  const label = input.entry.name?.trim() || input.entry.id;
  for (let attempt = 0; attempt < 20; attempt++) {
    const name = attempt === 0 ? label : `${label} (${attempt + 1})`;
    try {
      // Each attempt runs under its own savepoint, so a `23505` on the local name can actually be retried
      // instead of aborting the transaction with `25P02` (DB-01).
      await withSavepoint(client, `graph_calendar_${attempt}`, async () => {
        const created = await client.query<{ id: string }>(
          // A provider calendar starts read-only and hidden from DAV devices.
          `INSERT INTO calendars (user_id, owner_user_id, name, color, source, read_only, dav_mode)
           VALUES ($1, $1, $2, $3, 'microsoft', true, 'off') RETURNING id`,
          [input.userId, name, graphCalendarColor(input.entry)],
        );
        const calendarId = created.rows[0]?.id;
        if (!calendarId) throw new Error('Could not create the Microsoft calendar');

        if (existing.rows[0]) {
          // A link row without a local calendar is a half-finished link, not a user choice: fill in the local
          // side and the provider's own fact, but leave `enabled` and `user_access` as they are (SYNC-09).
          await client.query(
            `UPDATE integration_collections
                SET local_calendar_id = $2, source_access = $3, dav_mode = 'off', updated_at = NOW()
              WHERE id = $1`,
            [existing.rows[0].id, calendarId, sourceAccess],
          );
          return;
        }

        const collection = await client.query<{ id: string }>(
          `INSERT INTO integration_collections
             (user_id, connection_id, kind, remote_id, local_calendar_id, enabled, source_access, user_access, dav_mode)
           VALUES ($1, $2, 'calendar', $3, $4, true, $5, 'source', 'off')
           RETURNING id`,
          [input.userId, input.connectionId, input.entry.id, calendarId, sourceAccess],
        );
        const collectionId = collection.rows[0]?.id;
        if (!collectionId) throw new Error('Could not link the Microsoft calendar');
      });
      return;
    } catch (caught) {
      if (toAppError(caught).code === '23505') continue; // name taken — try the next suffix
      throw caught;
    }
  }
  throw new Error('Could not create the Microsoft calendar');
}

/** Apply one Graph master group through the shared provider projection. */
export async function applyGraphEventGroup(client: PoolClient, context: ApplyContext, remoteId: string, group: {
  master: GraphEvent | null;
  overrides: GraphEvent[];
}): Promise<'created' | 'updated' | 'deleted' | 'skipped'> {
  return applyProviderCalendarEventGroup(client, context, remoteId, group, GRAPH_PROJECTION);
}

async function listAllCalendars(api: GraphApiOptions): Promise<GraphCalendar[]> {
  const calendars: GraphCalendar[] = [];
  let link: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await fetchGraphCalendarsPage(api, { link, pageSize: PAGE_SIZE });
    calendars.push(...result.calendars);
    link = result.nextLink;
    if (!link) break;
  }
  return calendars;
}

async function syncCollection(api: GraphApiOptions, collection: CalendarCollection, context: Omit<ApplyContext, 'collectionId' | 'calendarId' | 'remoteCalendarId'>, maxPages?: number): Promise<{
  created: number; updated: number; deleted: number; skipped: number; fullSync: boolean; incomplete: boolean;
}> {
  const collectionIdentity = { userId: context.userId, connectionId: context.connectionId, remoteCalendarId: collection.remoteId };
  const syncStateId = await withTransaction(client => ensureSyncState(client, {
    userId: context.userId,
    connectionId: context.connectionId,
    feature: 'calendars',
    collectionId: collection.id,
    coverage: 'events',
  }));
  const owner = `microsoft-calendar:${collection.id}`;
  const lease = await withTransaction(client => acquireSyncLease(client, { syncStateId, owner }));
  if (!lease) {
    throw new GraphApiError({
      code: 'SYNC_ALREADY_RUNNING',
      message: 'Another Microsoft calendar sync is already running for this calendar',
      status: 409,
      retryable: true,
    });
  }

  const totals = { created: 0, updated: 0, deleted: 0, skipped: 0, fullSync: false };
  try {
    const state = await withTransaction(client => readSyncState(client, syncStateId));
    let cursor = state?.cursor ?? null;
    totals.fullSync = cursor === null;
    // A resumed run follows the stored delta link; a first run (or a rebuild) starts from the endpoint.
    let link: string | null = cursor;
    let rebuilt = false;
    let complete = false;
    const events: GraphEvent[] = [];

    for (let page = 0; page < (maxPages ?? MAX_PAGES); page++) {
      let fetched;
      try {
        // A resumed run starts from the stored delta link; a first run starts from the endpoint.
        fetched = await fetchGraphCalendarEventsPage(api, collection.remoteId, { link, pageSize: PAGE_SIZE });
      } catch (caught) {
        // A delta link Graph rejects (410, or a cursor it no longer honours) means the history is gone:
        // reconcile the whole calendar from a fresh baseline instead of trusting a partial batch.
        if (caught instanceof GraphApiError && caught.code === 'INVALID_SYNC_CURSOR' && (link ?? cursor)) {
          link = null;
          cursor = null;
          events.length = 0;
          totals.fullSync = true;
          rebuilt = true;
          continue;
        }
        throw caught;
      }
      events.push(...fetched.events);
      if (fetched.deltaLink) cursor = fetched.deltaLink;
      link = fetched.nextLink;
      if (!link) { complete = true; break; }
    }

    const applyContext: ApplyContext = {
      ...context,
      collectionId: collection.id,
      remoteCalendarId: collection.remoteId,
      calendarId: collection.localCalendarId,
    };
    const groups = groupGraphEvents(events);
    for (const [remoteId, group] of groups) {
      const applied = await withCalendarCollectionSyncFence(collectionIdentity, { syncStateId, generation: lease.generation, run: client => applyGraphEventGroup(client, applyContext, remoteId, group) });
      totals[applied] += 1;
    }
    // A rebuild read a complete baseline, so anything it does not mention was deleted at the provider
    // while the cursor was unusable. An incremental batch must never be reconciled this way: there,
    // omission means "unchanged". A capped run read only a prefix, so it must not reconcile either (SYNC-04).
    if (rebuilt && complete) {
      const removed = await withCalendarCollectionSyncFence(collectionIdentity, { syncStateId, generation: lease.generation, run: client => reconcileProviderCalendarCollection(
        client, { userId: context.userId, collectionId: collection.id }, new Set(groups.keys()),
      ) });
      totals.deleted += removed;
    }

    if (!complete) {
      // The page cap was reached before the end. Leave the stored cursor untouched — it still points at the
      // start of this batch — and do not claim a successful synchronisation; the next run re-reads and finishes.
      await withTransaction(client => releaseSyncLease(client, { syncStateId, generation: lease.generation })).catch(() => {});
      return { ...totals, incomplete: true };
    }

    // The cursor advances only after every group was applied, so a crash mid-run re-reads from the
    // previous link instead of skipping changes.
    const committed = await withTransaction(async client => {
      await assertCalendarCollectionPresent(client, collectionIdentity);
      const saved = await commitSyncCheckpoint(client, {
        syncStateId,
        generation: lease.generation,
        cursor,
        clearPageCheckpoint: true,
        lastErrorCode: null,
      });
      if (!saved) return false;
      // Every group was applied, so the run completed its declared scope (SYNC-02).
      return finishSyncRun(client, { syncStateId, generation: lease.generation, lastErrorCode: null });
    });
    if (!committed) {
      throw new GraphApiError({
        code: 'MUTATION_OUTCOME_UNKNOWN',
        message: 'The sync lease was lost before the cursor could be stored',
        status: 409,
      });
    }
    await withTransaction(client => releaseSyncLease(client, { syncStateId, generation: lease.generation })).catch(() => {});
    return { ...totals, incomplete: false };
  } catch (caught) {
    const code = caught instanceof GraphApiError || caught instanceof ProviderAuthError || caught instanceof SyncLeaseLostError || caught instanceof CalendarCollectionDeletedError ? caught.code : 'INTERNAL_ERROR';
    await withTransaction(client => failSyncRun(client, { syncStateId, generation: lease.generation, errorCode: code })).catch(() => {});
    throw caught;
  }
}

/**
 * Synchronise every calendar of one Microsoft connection. One calendar failing does not stop the others;
 * its failure is reported per collection.
 */
export async function syncGraphCalendar(input: {
  userId: string;
  connectionId: string;
  config: MicrosoftConfig;
  fetchImpl?: FetchLike;
  /** The page cap for one calendar; injectable so the "limited run is not complete" path is provable. */
  maxPages?: number;
}): Promise<GraphCalendarSyncResult> {
  const api: GraphApiOptions = {
    userId: input.userId,
    connectionId: input.connectionId,
    config: input.config,
    owner: `microsoft-calendar:${input.connectionId}`,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  };
  const calendars = await listAllCalendars(api);
  await withTransaction(async client => {
    // One client, so the discovery writes run in sequence on the same connection.
    for (const entry of [...calendars].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
      await ensureGraphCalendarCollection(client, { userId: input.userId, connectionId: input.connectionId, entry });
    }
  });

  const stored = await withTransaction(client => client.query<{ id: string; remote_id: string; local_calendar_id: string }>(
    // Only enabled calendars are synchronised: a calendar the user disabled is their choice, not an absent
    // collection (SYNC-09).
    `SELECT id, remote_id, local_calendar_id FROM integration_collections
      WHERE user_id = $1 AND connection_id = $2 AND kind = 'calendar' AND local_calendar_id IS NOT NULL
        AND enabled = true
         AND NOT EXISTS (SELECT 1 FROM calendar_collection_tombstones tombstone
           WHERE tombstone.user_id = integration_collections.user_id
             AND tombstone.connection_id = integration_collections.connection_id
             AND tombstone.remote_calendar_id = integration_collections.remote_id)
      ORDER BY created_at ASC, remote_id ASC`,
    [input.userId, input.connectionId],
  ));
  const collections: CalendarCollection[] = stored.rows.map(row => ({
    id: row.id,
    remoteId: row.remote_id,
    localCalendarId: row.local_calendar_id,
  }));
  // Graph stamps each event with its own zone; a calendar-level zone is only a fallback and is read from
  // the user's mailbox settings lazily. `null` means "trust the event's zone", which is what Graph sends.
  const defaultTimeZone = null;

  const result: GraphCalendarSyncResult = {
    collections: collections.length,
    created: 0, updated: 0, deleted: 0, skipped: 0, fullSync: false, errors: [], incompleteCollections: 0,
  };
  for (const collection of collections) {
    try {
      const totals = await syncCollection(api, collection, {
        userId: input.userId,
        connectionId: input.connectionId,
        defaultTimeZone,
      }, input.maxPages);
      result.created += totals.created;
      result.updated += totals.updated;
      result.deleted += totals.deleted;
      result.skipped += totals.skipped;
      result.fullSync = result.fullSync || totals.fullSync;
      if (totals.incomplete) result.incompleteCollections += 1;
    } catch (caught) {
      result.errors.push({
        calendarId: collection.remoteId,
        code: caught instanceof GraphApiError || caught instanceof ProviderAuthError || caught instanceof SyncLeaseLostError || caught instanceof CalendarCollectionDeletedError ? caught.code : 'INTERNAL_ERROR',
      });
    }
  }
  return result;
}
