import { query, withTransaction } from './db.js';
import { projectCalendarResources } from './calendarProjectionPool.js';

// Materialising calendar occurrences.
//
// A recurring series has to be expanded from its own start date (see the migration for why
// re-seeding the rule iterator is not equivalent). That walk costs ~10-20 us per occurrence,
// so a calendar whose series are years old spent most of a second of CPU per cold window.
// This module moves that work off the read path: the worker expands an event once, stores the
// concrete instances, and a read becomes an indexed range scan.
//
// The read path never depends on this having run. An event that is dirty, never built, or not
// covered for the requested window is expanded on the fly exactly as before (see the events
// route), so a lagging or failing worker makes the calendar slower — never wrong or incomplete.

// How far around "now" occurrences are materialised. Past is small because calendars are
// read forward; future is large enough that ordinary navigation never reaches the edge.
const HORIZON_PAST_MONTHS = 3;
const HORIZON_FUTURE_MONTHS = 18;
// Events rebuilt per tick. Bounded so a bulk import cannot monopolise the process.
const BATCH_SIZE = 25;
// How often the queue is drained.
const TICK_MS = 5000;

function envInt(name, fallback, { min, max }) {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function occurrenceHorizon(now = new Date()) {
  const past = envInt('CALENDAR_OCCURRENCE_HORIZON_PAST_MONTHS', HORIZON_PAST_MONTHS, { min: 0, max: 120 });
  const future = envInt('CALENDAR_OCCURRENCE_HORIZON_FUTURE_MONTHS', HORIZON_FUTURE_MONTHS, { min: 1, max: 120 });
  const from = new Date(now);
  from.setUTCMonth(from.getUTCMonth() - past, 1);
  from.setUTCHours(0, 0, 0, 0);
  const to = new Date(now);
  to.setUTCMonth(to.getUTCMonth() + future + 1, 1);
  to.setUTCHours(0, 0, 0, 0);
  return { from, to };
}

// Columns the projection needs from the event row. Shared with the events route's fallback
// query so the two can never disagree about what an expansion is given.
export const EVENT_COLUMNS = `e.id, e.user_id, e.calendar_id, e.uid, e.etag, e.raw_ical, e.summary, e.description,
  e.location, e.url, e.organizer, e.attendees, e.starts_at, e.ends_at, e.all_day, e.timezone`;

// The value the parent event carries, used to decide whether an occurrence overrides it.
// Storing only genuine overrides keeps a description from being duplicated across hundreds
// of instances.
function masterValue(row, field) {
  const value = row[field];
  return value === undefined ? null : value;
}

function overridesFor(event, row) {
  const pick = (field, current) => {
    const master = masterValue(row, field);
    const same = Array.isArray(master) || Array.isArray(current)
      ? JSON.stringify(master ?? []) === JSON.stringify(current ?? [])
      : master === current;
    return same ? null : (current ?? null);
  };
  return {
    summary: pick('summary', event.summary ?? null),
    description: pick('description', event.description ?? null),
    location: pick('location', event.location ?? null),
    url: pick('url', event.url ?? null),
    organizer: pick('organizer', event.organizer ?? null),
    attendees: Array.isArray(event.attendees) && JSON.stringify(event.attendees) !== JSON.stringify(row.attendees ?? [])
      ? JSON.stringify(event.attendees)
      : null,
  };
}

/**
 * Records what a build covered. Exported because it holds the guard that makes the dangerous
 * race safe, and a guard with no test is a guard that quietly disappears:
 *
 *   * `etag` is the version the occurrence rows were expanded from. If the event changed while
 *     the build was running, those rows describe the *previous* version, so `dirty` must stay
 *     set — otherwise the next read serves a calendar that silently ignores the edit.
 *   * `truncated` keeps a partial expansion dirty, so the read path keeps expanding that series
 *     on the fly instead of presenting a partial month as complete.
 */
export async function finalizeMaterialization(client, { eventId, horizon, etag, truncated }) {
  await client.query(
    `UPDATE calendar_occurrence_state s
        SET built_from = $2, built_to = $3, built_etag = $4,
            dirty = ($5 OR e.etag IS DISTINCT FROM $4),
            updated_at = NOW()
       FROM calendar_events e
      WHERE s.event_id = e.id AND s.event_id = $1`,
    [eventId, horizon.from, horizon.to, etag, truncated],
  );
}

/**
 * Expands one event over the materialisation horizon and replaces its stored occurrences.
 * Returns 'built', 'truncated' (stored what it could, still needs the on-the-fly path) or
 * 'skipped' when the event disappeared while queued.
 */
export async function materializeEvent(eventId, horizon = occurrenceHorizon()) {
  const result = await query(`SELECT ${EVENT_COLUMNS} FROM calendar_events e WHERE e.id = $1`, [eventId]);
  const row = result.rows[0];
  if (!row) return 'skipped';

  // Inline projection: this already runs off the request path on the worker's own turn, and
  // going through the worker pool again would queue behind the reads it exists to keep fast.
  const projection = await projectCalendarResources([row], horizon.from, horizon.to, {
    userId: row.user_id,
    useWorkers: false,
    cache: false,
  });

  const insertable = projection.events.map(event => ({
    recurrence_id: event.recurrence_id ?? '',
    starts_at: event.starts_at,
    ends_at: event.ends_at,
    all_day: Boolean(event.all_day),
    timezone: row.timezone ?? null,
    ...overridesFor(event, row),
  }));

  await withTransaction(async client => {
    await client.query('DELETE FROM calendar_occurrences WHERE event_id = $1', [eventId]);
    for (const occurrence of insertable) {
      await client.query(
        `INSERT INTO calendar_occurrences
           (event_id, calendar_id, user_id, recurrence_id, starts_at, ends_at, all_day, timezone,
            summary, description, location, url, organizer, attendees)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)
         ON CONFLICT (event_id, recurrence_id) DO UPDATE SET
           starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at, all_day = EXCLUDED.all_day,
           timezone = EXCLUDED.timezone, summary = EXCLUDED.summary, description = EXCLUDED.description,
           location = EXCLUDED.location, url = EXCLUDED.url, organizer = EXCLUDED.organizer,
           attendees = EXCLUDED.attendees`,
        [eventId, row.calendar_id, row.user_id, occurrence.recurrence_id, occurrence.starts_at,
          occurrence.ends_at, occurrence.all_day, occurrence.timezone, occurrence.summary,
          occurrence.description, occurrence.location, occurrence.url, occurrence.organizer,
          occurrence.attendees],
      );
    }
    await finalizeMaterialization(client, {
      eventId, horizon, etag: row.etag, truncated: projection.truncated,
    });
  });

  return projection.truncated ? 'truncated' : 'built';
}

/**
 * Drains up to `limit` queued events. Returns the ids it attempted and whether anything is
 * still queued, so a caller can report progress.
 */
export async function materializePendingOccurrences({ limit = BATCH_SIZE } = {}) {
  // Claim atomically. `FOR UPDATE SKIP LOCKED` inside the UPDATE means two API instances
  // running this worker at the same time never take the same event, and neither blocks on the
  // other. Clearing `dirty` here is what performs the claim; a failure below sets it back.
  const pending = await query(
    `UPDATE calendar_occurrence_state
        SET dirty = false, updated_at = NOW()
      WHERE event_id IN (
        SELECT event_id FROM calendar_occurrence_state
         WHERE dirty
         ORDER BY updated_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING event_id`,
    [limit],
  );
  const horizon = occurrenceHorizon();
  const outcomes = [];
  for (const { event_id: eventId } of pending.rows) {
    try {
      outcomes.push({ eventId, result: await materializeEvent(eventId, horizon) });
    } catch (error) {
      // One broken series must not stall the queue for everyone else. Re-arm it so the next
      // tick retries, and let reads keep using the on-the-fly path in the meantime.
      await query('UPDATE calendar_occurrence_state SET dirty = true, updated_at = NOW() WHERE event_id = $1', [eventId])
        .catch(() => { /* a failure to re-arm is recovered by the next full pass */ });
      console.warn('Calendar occurrence materialisation failed:', eventId, error.message);
      outcomes.push({ eventId, result: 'failed' });
    }
  }
  return { processed: outcomes.length, outcomes };
}

/** Queue an event for rebuild and (optionally) rebuild it right away, off the request path. */
export async function requestOccurrenceRebuild(eventIds) {
  const ids = (Array.isArray(eventIds) ? eventIds : [eventIds]).filter(Boolean);
  if (!ids.length) return { queued: 0 };
  const result = await query(
    `UPDATE calendar_occurrence_state SET dirty = true, updated_at = NOW()
      WHERE event_id = ANY($1::uuid[])`,
    [ids],
  );
  return { queued: result.rowCount ?? 0 };
}

/**
 * Events that are not covered for a window need the on-the-fly path regardless of whether
 * they have stored occurrences. Single place for that decision so the route and its tests
 * cannot drift apart.
 */
export function coveragePredicate(alias = 's') {
  return `(${alias}.event_id IS NULL OR ${alias}.dirty OR ${alias}.built_from > $2 OR ${alias}.built_to < $3)`;
}

let timer = null;

/** Start draining the queue in the background. Safe to call twice. */
export function startOccurrenceScheduler() {
  if (timer) return;
  const tick = () => materializePendingOccurrences()
    .then(summary => {
      if (summary.processed) {
        console.log('Calendar occurrences materialised:', JSON.stringify(summary.outcomes.filter(o => o.result !== 'built')));
      }
    })
    .catch(error => console.warn('Calendar occurrence scheduler failed:', error.message));
  timer = setInterval(tick, envInt('CALENDAR_OCCURRENCE_TICK_MS', TICK_MS, { min: 250, max: 600000 }));
  // A long-running process should not be held open by this timer alone, and the first pass
  // should not wait a full tick after a restart.
  timer.unref?.();
  tick();
}

export function stopOccurrenceScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
