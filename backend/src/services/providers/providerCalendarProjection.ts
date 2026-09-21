import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { parseCalendarEvent } from '../../utils/ical.js';
import { mergeProviderCalendarResource } from './calendarResourceMerge.js';

/**
 * The one place a provider calendar master/override batch becomes a local resource (P09/P07d).
 *
 * RFC 4791 requires a recurring set — the master and its `RECURRENCE-ID` overrides — to live in one
 * calendar object resource, and every provider adapter has to honour that the same way: find the stored
 * resource through the remote link, merge the batch into it, re-project the columns the calendar view
 * reads, and record the link. Google's and Microsoft's batches differ only in how the batch is rendered
 * and in the fallback UID, so the apply is shared and the adapters supply those two.
 *
 * The stored resource, not the batch, is the source of truth for anything the batch does not mention: the
 * merge preserves alarms and extension properties, and a `cancelled` master removes the resource.
 */

export interface CalendarEventGroup<Event> {
  master: Event | null;
  overrides: Event[];
}

export interface CalendarProjectionContext {
  userId: string;
  connectionId: string;
  collectionId: string;
  /** The provider's own calendar id, stored as the remote collection reference. */
  remoteCalendarId: string;
  calendarId: string;
  defaultTimeZone: string | null;
}

export interface CalendarResourceAdapters<Event> {
  /** Render the batch as one VCALENDAR, or null when it cannot be rendered. */
  buildResource(group: CalendarEventGroup<Event>, context: CalendarProjectionContext): string | null;
  /** True when the batch's master is cancelled at the provider. */
  isCancelled(event: Event): boolean;
  /** The UID to use when the rendered event carries none. */
  fallbackUid?(remoteId: string): string;
  /**
   * The **provider's own** version of the resource (`etag`, `changeKey`), or null when it does not expose one.
   *
   * This is what belongs in `remote_object_links.remote_version`. The projection used to write the hash of the
   * locally merged iCalendar there, which is a *local* fingerprint: it changes when local formatting or local
   * components change, so it cannot be compared with a provider version, and a DAV write-back that treated it
   * as one could send a precondition the provider never issued (CAL-05).
   */
  remoteVersion?(group: CalendarEventGroup<Event>): string | null;
}

async function upsertLink(client: PoolClient, context: CalendarProjectionContext, remoteId: string, input: {
  localId: string | null;
  /** The provider's own version, or null when it exposes none — never the local hash (CAL-05). */
  remoteVersion: string | null;
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
      context.remoteCalendarId, remoteId, context.remoteCalendarId, input.remoteVersion, input.status,
    ],
  );
}

/**
 * Apply one master group: delete a cancelled master, otherwise merge the batch into
 * the stored resource and update the projection columns.
 */
export async function applyProviderCalendarEventGroup<Event>(
  client: PoolClient,
  context: CalendarProjectionContext,
  remoteId: string,
  group: CalendarEventGroup<Event>,
  adapters: CalendarResourceAdapters<Event>,
): Promise<'created' | 'updated' | 'deleted' | 'skipped'> {
  const link = await client.query<{ id: string; local_id: string | null }>(
    `SELECT id, local_id FROM remote_object_links WHERE collection_id = $1 AND object_remote_id = $2`,
    [context.collectionId, remoteId],
  );
  let localId = link.rows[0]?.local_id ?? null;

  if (group.master && adapters.isCancelled(group.master)) {
    if (localId) await client.query('DELETE FROM calendar_events WHERE id = $1 AND user_id = $2', [localId, context.userId]);
    await upsertLink(client, context, remoteId, { localId: null, remoteVersion: null, status: 'deleted' });
    return localId ? 'deleted' : 'skipped';
  }

  const incoming = adapters.buildResource(group, context);
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

  const mergedRaw = mergeProviderCalendarResource(existingRaw, incoming);
  if (!mergedRaw) return 'skipped';
  const parsed = parseCalendarEvent(mergedRaw);
  if (!parsed) return 'skipped';

  const etag = crypto.createHash('sha256').update(mergedRaw).digest('hex');
  const uid = parsed.uid || adapters.fallbackUid?.(remoteId) || `${remoteId}@provider`;
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

  await upsertLink(client, context, remoteId, {
    localId,
    remoteVersion: adapters.remoteVersion?.(group) ?? null,
    status: 'active',
  });
  return outcome;
}

/**
 * Remove the local events of a collection whose remote resource a **rebuild** no longer lists.
 *
 * A rebuild reads a complete baseline, so a resource it does not mention was deleted while the cursor was
 * unusable. Without this the local copy would keep an event the provider no longer has, forever — the
 * incremental path cannot repair it, because a delta only carries what changed. The remote link is kept
 * as a tombstone so the identity is not reused by a later event with the same provider id.
 *
 * It must not run for an incremental batch: omission there means "unchanged", not "deleted".
 */
export async function reconcileProviderCalendarCollection(
  client: PoolClient,
  context: { userId: string; collectionId: string },
  seenRemoteIds: ReadonlySet<string>,
): Promise<number> {
  const seen = [...seenRemoteIds];
  const removed = await client.query(
    `DELETE FROM calendar_events e
      USING remote_object_links l
      WHERE l.collection_id = $1 AND l.user_id = $2 AND l.status = 'active'
        AND e.id = l.local_id AND e.user_id = $2
        AND l.object_remote_id <> ALL($3::text[])`,
    [context.collectionId, context.userId, seen],
  );
  await client.query(
    `UPDATE remote_object_links
        SET local_id = NULL, status = 'deleted', updated_at = NOW()
      WHERE collection_id = $1 AND user_id = $2 AND status = 'active'
        AND object_remote_id <> ALL($3::text[])`,
    [context.collectionId, context.userId, seen],
  );
  return removed.rowCount ?? 0;
}
