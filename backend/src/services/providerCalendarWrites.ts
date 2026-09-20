import { collectionIsWritable } from './providerAccess.js';
import { runProviderMutation } from './providerMutationService.js';
import { microsoftConfigFromEnv } from './providerAuthService.js';
import { query } from './db.js';
import { providerWriteFailure } from './providerWriteFailure.js';
import {
  graphCalendarEventMutationAdapter,
  type GraphCalendarEventWritePayload,
  type LocalEventWriteInput,
} from './providers/microsoft/graphCalendarWrites.js';
import {
  createGraphEvent,
  deleteGraphEvent,
  patchGraphEvent,
  type GraphEvent,
} from './providers/microsoft/graphCalendar.js';
import type { ParsedRecurrence } from '../utils/calendarRecurrenceRule.js';

/**
 * Which writer a local calendar's events belong to (P09 calendar CRUD), and how a provider answer becomes
 * a response. The contact path answers the same two questions through `providerContactWrites.ts`; the
 * failure mapping itself lives in `providerWriteFailure.ts` so both answer identically.
 */

export type CalendarWriteTarget =
  | { kind: 'local' }
  | { kind: 'graph'; connectionId: string; collectionId: string; providerCalendarId: string; calendarId: string }
  /**
   * An external CalDAV collection the user enabled write-back for. The writer is the **source**, which
   * `providers/caldavWriteBack.ts` forwards to; the target carries what that client needs to address it.
   */
  | { kind: 'caldav'; collectionId: string; calendarId: string; externalUrl: string | null }
  | { kind: 'refused'; status: number; error: string };

export async function resolveCalendarWriteTarget(userId: string, calendarId: string): Promise<CalendarWriteTarget> {
  const result = await query<{
    id: string; source: string | null; collection_id: string | null; remote_id: string | null;
    connection_id: string | null; source_access: string | null; user_access: string | null;
    external_url: string | null;
  }>(
    `SELECT c.id, c.source, c.external_url, ic.id AS collection_id, ic.remote_id, ic.connection_id,
            ic.source_access, ic.user_access
       FROM calendars c
       LEFT JOIN integration_collections ic
              ON ic.local_calendar_id = c.id AND ic.kind = 'calendar' AND ic.user_id = c.user_id
      WHERE c.id = $1 AND c.user_id = $2 AND c.owner_user_id = $2`,
    [calendarId, userId],
  );
  const row = result.rows[0];
  if (!row) return { kind: 'refused', status: 404, error: 'Calendar not found' };
  if (!collectionIsWritable({
    source: row.source,
    source_access: row.source_access,
    user_access: row.user_access,
  }, 'calendars')) {
    return { kind: 'refused', status: 403, error: 'This calendar is read-only' };
  }
  if ((row.source ?? 'local') === 'local') return { kind: 'local' };
  if (row.source === 'caldav') {
    // The capability model above already answered whether this collection may be written at all: its source
    // must permit writes (recorded from the CalDAV server by the collection link) and the user must have
    // enabled write-back for it. An ICS subscription never reaches here — its registration declares no
    // write-through, so the model refuses it first.
    return {
      kind: 'caldav',
      collectionId: row.collection_id ?? '',
      calendarId: row.id,
      externalUrl: row.external_url ?? null,
    };
  }
  if (row.source === 'microsoft') {
    if (!row.connection_id || !row.collection_id) {
      return { kind: 'refused', status: 409, error: 'This calendar is not linked to a Microsoft connection' };
    }
    return {
      kind: 'graph',
      connectionId: row.connection_id,
      collectionId: row.collection_id,
      providerCalendarId: row.remote_id || 'calendar',
      calendarId: row.id,
    };
  }
  return { kind: 'refused', status: 403, error: 'This calendar is written by its source and is read-only' };
}

export type CalendarWriteOutcome =
  | { status: 'confirmed'; providerEventId: string; event: GraphEvent | null }
  | { status: 'failed'; failure: { status: number; error: string; code?: string; retryAfterSeconds?: number } };

export async function writeGraphCalendarEvent(input: {
  userId: string;
  target: Extract<CalendarWriteTarget, { kind: 'graph' }>;
  operation: 'create' | 'update' | 'delete';
  providerEventId?: string | null;
  /**
   * The **local** `calendar_events.id` this operation belongs to.
   *
   * `provider_operations.resource_id` is a UUID column, and the journal is about Inboxora's own resource:
   * the provider's id (`AAMkAD-…`) travels in the payload and in `remote_object_links`, never in that
   * column — binding it there fails the INSERT with `invalid input syntax for type uuid` before any
   * provider call. A create has no local row yet and passes null.
   */
  localResourceId?: string | null;
  event?: LocalEventWriteInput;
  idempotencyKey?: string | null;
  /** Injected in tests, so the journal and the local writes can be exercised without a provider. */
  providerCalls?: { create?: typeof createGraphEvent; patch?: typeof patchGraphEvent; remove?: typeof deleteGraphEvent };
}): Promise<CalendarWriteOutcome> {
  const api = {
    userId: input.userId,
    connectionId: input.target.connectionId,
    config: microsoftConfigFromEnv(),
  };
  const payload: GraphCalendarEventWritePayload = {
    operation: input.operation,
    calendarId: input.target.providerCalendarId,
    eventId: input.providerEventId ?? null,
    ...(input.event ? { event: input.event } : {}),
    ...(input.idempotencyKey ? { transactionId: input.idempotencyKey } : {}),
  };
  const result = await runProviderMutation(
    {
      userId: input.userId,
      channel: 'web',
      operation: input.operation,
      connectionId: input.target.connectionId,
      collectionId: input.target.collectionId,
      resourceId: input.localResourceId ?? null,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      payload,
      timeoutMs: 20_000,
    },
    graphCalendarEventMutationAdapter({ api, ...(input.providerCalls ?? {}) }),
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
export async function recordGraphCalendarEventLink(input: {
  userId: string;
  target: Extract<CalendarWriteTarget, { kind: 'graph' }>;
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
export async function removeGraphCalendarEventLink(input: {
  userId: string;
  target: Extract<CalendarWriteTarget, { kind: 'graph' }>;
  providerEventId: string;
}): Promise<void> {
  await query(
    `UPDATE remote_object_links SET local_id = NULL, status = 'deleted', updated_at = NOW()
      WHERE collection_id = $1 AND user_id = $2 AND object_remote_id = $3`,
    [input.target.collectionId, input.userId, input.providerEventId],
  );
}

/** The provider event id a local event row is linked to. */
export async function graphEventIdForLocalRow(userId: string, collectionId: string, localId: string): Promise<string | null> {
  const result = await query<{ object_remote_id: string | null }>(
    `SELECT object_remote_id FROM remote_object_links
      WHERE collection_id = $1 AND user_id = $2 AND local_id = $3 AND object_type = 'calendar_event' AND status = 'active'`,
    [collectionId, userId, localId],
  );
  return result.rows[0]?.object_remote_id ?? null;
}

/** The recurrence structure the route validated, for the adapter. Exported for the route's convenience. */
export type { ParsedRecurrence };
