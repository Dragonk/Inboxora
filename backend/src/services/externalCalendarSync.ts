import { calendarResources } from '../utils/calendarRecurrence.js';
import { requireCompleteMultistatus, decodeDavCharRefs } from '../utils/davXml.js';
// Pull-only external CalDAV/iCalendar import. Remote data is never modified and
// failures are recorded per source so one unavailable server cannot block others.
import crypto from 'crypto';
import { XMLParser } from 'fast-xml-parser';
import { query } from './db.js';
import { decrypt } from './encryption.js';
import { safeFetch } from './safeFetch.js';
import { getConnectionPolicy } from './connectionPolicy.js';
import { parseCalendarEvent } from '../utils/ical.js';
import { toAppError } from '../utils/errors.js';
import { ensureExternalCollectionLink, type ExternalSourceKind } from './providers/externalCollectionLinks.js';

/** A decrypted external calendar source row. */
interface CalendarSyncState { removed?: boolean; promise?: Promise<unknown>; controller?: AbortController }

interface ExternalCalendarSource {
  id?: string;
  kind?: string;
  url?: string;
  username?: string;
  password?: string;
  user_id?: string;
  interval_min?: number;
  [key: string]: unknown;
}

/** The subset of the connection policy these fetches read. */
type ExternalCalendarPolicy = { allowPrivateHosts?: boolean; [key: string]: unknown };

/** Fetch options with plain-string headers (this module owns every header it sends). */
type ExternalFetchOptions = Omit<RequestInit, 'headers'> & { headers?: Record<string, string> };

/** The three external source kinds the schema admits; anything else is treated as a read-only ICS feed. */
function externalSourceKind(kind: unknown): ExternalSourceKind {
  return kind === 'caldav' || kind === 'carddav' ? kind : 'ical_url';
}

const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, trimValues: false });
const syncing = new Set<string>();
const timers = new Map<string, NodeJS.Timeout>();
const inFlight = new Map<string, CalendarSyncState>();
const stopped = new Set<string>();
const toArray = <T>(value: T | T[] | null | undefined): T[] => (Array.isArray(value) ? value : value == null ? [] : [value]);
const textOf = (value: unknown): string => typeof value === 'string' ? value : String((value as Record<string, unknown> | null | undefined)?.['#text'] ?? '');
const basicAuth = (username: string, password: string): string => `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

function calendarPayloads(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('Remote calendar did not contain any VEVENT components');
  }
  const lineBreak = '(?:\\r\\n|\\n|\\r)';
  const eventBlocks = raw.match(new RegExp(`BEGIN:VEVENT${lineBreak}[\\s\\S]*?END:VEVENT`, 'gi')) || [];
  // TZID values in VEVENT are meaningful only with their VTIMEZONE context.
  // Keep that context alongside every independently stored event while leaving
  // unrelated components (VTODO/VJOURNAL/VFREEBUSY) out of the event resource.
  const timeZoneBlocks = raw.match(new RegExp(`BEGIN:VTIMEZONE${lineBreak}[\\s\\S]*?END:VTIMEZONE`, 'gi')) || [];
  const context = timeZoneBlocks.length ? `${timeZoneBlocks.join('\r\n')}\r\n` : '';
  try { return calendarResources(raw); } catch {
    if (!eventBlocks.length) throw new Error('Remote calendar contains an unsupported event');
    return eventBlocks.map((block) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${context}${block}\r\nEND:VCALENDAR\r\n`);
  }
}
function propsOf(response: { propstat?: Record<string, unknown> | Array<Record<string, unknown>> }): Record<string, unknown> {
  return toArray(response.propstat).reduce((result, propstat) => {
    if (!propstat.status || /\b2\d\d\b/.test(textOf(propstat.status))) Object.assign(result, propstat.prop || {});
    return result;
  }, {});
}

async function remoteFetch(source: ExternalCalendarSource, options: ExternalFetchOptions, policy: ExternalCalendarPolicy, signal: AbortSignal | null | undefined, secretSink?: string[]): Promise<string> {
  const headers: Record<string, string> = { ...options.headers };
  if (source.kind === 'caldav') {
    const password = decrypt(source.password ?? '');
    if (!password) throw new Error('Stored calendar source password is unavailable');
    headers.Authorization = basicAuth(source.username ?? '', password);
  }
  const url = decrypt(source.url);
  if (!url) throw new Error('Stored calendar source URL is unavailable');
  secretSink?.push(url);
  const timeout = AbortSignal.timeout(30_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await safeFetch(url, { ...options, headers, redirect: 'follow', signal: requestSignal }, { allowPrivate: policy.allowPrivateHosts });
  if (!response.ok && response.status !== 207) throw new Error(`Remote calendar request failed (${response.status})`);
  return response.text();
}

async function fetchEvents(source: ExternalCalendarSource, policy: ExternalCalendarPolicy, signal: AbortSignal | null | undefined, secretSink?: string[]): Promise<{ payloads: string[]; sourceDocument: string | null }> {
  if (source.kind === 'ical_url') {
    const sourceDocument = await remoteFetch(source, { headers: { Accept: 'text/calendar' } }, policy, signal, secretSink);
    return { payloads: calendarPayloads(sourceDocument), sourceDocument };
  }
  const body = `<?xml version="1.0" encoding="utf-8"?><C:calendar-query xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><prop><getetag/><C:calendar-data/></prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"/></C:comp-filter></C:filter></C:calendar-query>`;
  const rawXml = await remoteFetch(source, { method: 'REPORT', headers: { 'Content-Type': 'application/xml; charset=utf-8', Depth: '1' }, body }, policy, signal, secretSink);
  const xml = parser.parse(rawXml);
  requireCompleteMultistatus(rawXml, xml);
  const payloads = [];
  for (const response of toArray(xml?.multistatus?.response)) {
    const data = decodeDavCharRefs(textOf(propsOf(response)['calendar-data']));
    if (data) payloads.push(data);
  }
  return { payloads, sourceDocument: null };
}

function throwIfRemoved(state: CalendarSyncState): void {
  if (state.removed) throw new Error('Calendar source removed');
}

async function calendarFor(source: ExternalCalendarSource, state: CalendarSyncState) {
  const externalUrl = `source:${source.id}`;
  const found = await query<{ id: string }>('SELECT id FROM calendars WHERE user_id = $1 AND owner_user_id = $1 AND external_url = $2', [source.user_id, externalUrl]);
  throwIfRemoved(state);
  if (found.rows[0]) {
    await linkExternalCollection(source, found.rows[0].id);
    return found.rows[0].id;
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    throwIfRemoved(state);
    const name = attempt ? `${source.display_name} (${attempt + 1})` : source.display_name;
    try {
      const inserted = await query<{ id: string }>(
        // A newly connected external calendar is not published to DAV devices
        // until the user explicitly enables it (plan §17.1).
        `INSERT INTO calendars (user_id, owner_user_id, name, color, source, external_url, read_only, dav_mode)
         VALUES ($1, $1, $2, $3, $4, $5, true, 'off') RETURNING id`,
        [source.user_id, name, source.color, source.kind, externalUrl],
      );
      await linkExternalCollection(source, inserted.rows[0].id);
      return inserted.rows[0].id;
    } catch (caught) {
      const error = toAppError(caught);
      if (error.code !== '23505') throw error;
    }
  }
  throw new Error(`Could not create a calendar for "${source.display_name}"`);
}

/**
 * Link the external collection to its source connection so the per-collection write-back switch has
 * something to enable (P02's backfill, P10's reachability).
 *
 * The link is not what this sync is for, so a failure here is reported and does not fail the import —
 * losing the events would be worse than a collection that has to be relinked on the next pass. An ICS
 * subscription is linked as `read_only`, which is what the capability model will keep refusing.
 */
async function linkExternalCollection(source: ExternalCalendarSource, calendarId: string): Promise<void> {
  try {
    await ensureExternalCollectionLink({
      userId: String(source.user_id ?? ''),
      kind: externalSourceKind(source.kind),
      url: typeof source.url === 'string' && source.url ? source.url : `source:${source.id}`,
      remoteId: `source:${source.id}`,
      label: typeof source.display_name === 'string' ? source.display_name : null,
      localCalendarId: calendarId,
    });
  } catch (caught) {
    console.warn('Linking an external calendar to its source connection failed:', toAppError(caught).message);
  }
}

async function syncSource(source: ExternalCalendarSource) {
  const sourceId = source.id;
  if (!sourceId) return { ok: false, error: 'Calendar source is incomplete' };
  if (syncing.has(sourceId)) return { ok: false, error: 'A sync is already in progress' };
  syncing.add(sourceId);
  const outboundSecrets: string[] = [];
  const state = { controller: new AbortController(), removed: false };
  inFlight.set(sourceId, state);
  try {
    const { payloads, sourceDocument } = await fetchEvents(source, await getConnectionPolicy(), state.controller.signal, outboundSecrets);
    throwIfRemoved(state);
    const parsedEvents = payloads.map((raw, index) => ({ raw, index, event: parseCalendarEvent(raw) }));
    const events = parsedEvents.filter(({ event }) => event).map(({ event }) => event);
    const skipped = parsedEvents.filter(({ event }) => !event).map(({ raw, index }) => {
      const uid = raw.match(/(?:^|\r\n|\n|\r)UID(?:;[^:]*)?:([^\r\n]*)/i)?.[1]?.trim() || `event-${index + 1}`;
      return { uid, reason: 'unsupported or malformed VEVENT' };
    });
    // A wholly unsupported response must never delete a healthy projection.
    // A validated empty collection does remove its previous projection. In a mixed response, retain only the explicitly skipped
    // UIDs; other rows are known to be absent from the feed and are stale.
    if (!events.length && skipped.length) throw new Error('Remote calendar contains an unsupported event');
    const calendarId = await calendarFor(source, state);
    if (sourceDocument) {
      throwIfRemoved(state);
      await query(
        `INSERT INTO calendar_import_documents (source_id, raw_ical)
         VALUES ($1, $2)
         ON CONFLICT (source_id) DO UPDATE SET raw_ical = EXCLUDED.raw_ical, updated_at = NOW()
         WHERE calendar_import_documents.raw_ical IS DISTINCT FROM EXCLUDED.raw_ical`,
        [source.id, sourceDocument],
      );
    }
    const seen = [];
    for (const event of events) {
      if (!event) continue;
      throwIfRemoved(state);
      seen.push(event.uid);
      const etag = crypto.createHash('sha256').update(event.raw).digest('hex');
      await query(
        `INSERT INTO calendar_events (calendar_id, user_id, uid, raw_ical, etag, summary, starts_at, ends_at, all_day, timezone, description, location, url, organizer, attendees)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
         ON CONFLICT (calendar_id, uid, recurrence_id) DO UPDATE SET raw_ical = EXCLUDED.raw_ical,
           etag = EXCLUDED.etag, summary = EXCLUDED.summary, starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at,
           all_day = EXCLUDED.all_day, timezone = EXCLUDED.timezone, description = EXCLUDED.description,
           location = EXCLUDED.location, url = EXCLUDED.url, organizer = EXCLUDED.organizer, attendees = EXCLUDED.attendees, updated_at = NOW()`,
        [calendarId, source.user_id, event.uid, event.raw, etag, event.summary, event.startsAt, event.endsAt, event.allDay, event.timeZone, event.description, event.location, event.url, event.organizer, JSON.stringify(event.attendees)],
      );
    }
    throwIfRemoved(state);
    const retainedUids = [...seen, ...skipped.map(({ uid }) => uid)];
    await query('DELETE FROM calendar_events WHERE calendar_id = $1 AND uid <> ALL($2::text[])', [calendarId, retainedUids.length ? retainedUids : ['']]);
    if (skipped.length) {
      throwIfRemoved(state);
      const warning = JSON.stringify({ code: 'unsupported_events', count: skipped.length, samples: skipped.slice(0, 3) });
      await query('UPDATE calendar_import_sources SET last_sync_at = NOW(), last_error = $2 WHERE id = $1', [source.id, warning]);
      return { ok: true, eventCount: events.length, skipped };
    }
    throwIfRemoved(state);
    await query('UPDATE calendar_import_sources SET last_sync_at = NOW(), last_error = NULL WHERE id = $1', [source.id]);
    return { ok: true, eventCount: events.length };
  } catch (caught) {
    const error = toAppError(caught);
    if (state.removed) return { ok: false, error: 'Calendar source removed' };
    const secrets = [source.url, ...outboundSecrets].filter((value): value is string => typeof value === 'string' && value !== '');
    const safeError = secrets.reduce((message, secret) => message.replaceAll(secret, '[redacted]'), String(error.message || 'Calendar source sync failed'));
    await query('UPDATE calendar_import_sources SET last_sync_at = NOW(), last_error = $2 WHERE id = $1', [source.id, safeError]);
    return { ok: false, error: safeError };
  } finally {
    syncing.delete(sourceId);
    inFlight.delete(sourceId);
  }
}

function runSync(source: ExternalCalendarSource) {
  const sourceId = source.id;
  if (!sourceId) return Promise.resolve({ ok: false, error: 'Calendar source is incomplete' });
  if (stopped.has(sourceId)) return Promise.resolve({ ok: false, error: 'Calendar source removed' });
  if (inFlight.has(sourceId)) return syncSource(source);
  const promise = syncSource(source);
  const state = inFlight.get(sourceId);
  if (state) state.promise = promise;
  return promise;
}

export async function syncCalendarSource(userId: string, sourceId: string) {
  const result = await query('SELECT * FROM calendar_import_sources WHERE id = $1 AND user_id = $2 AND enabled = true', [sourceId, userId]);
  if (!result.rows[0]) return { ok: false, error: 'Calendar source not found' };
  return runSync(result.rows[0]);
}
export async function syncAllCalendarSources() {
  const result = await query('SELECT * FROM calendar_import_sources WHERE enabled = true');
  return Promise.allSettled(result.rows.map(runSync));
}
export function scheduleCalendarSource(source: ExternalCalendarSource): void {
  const sourceId = source.id;
  const intervalMinutes = source.interval_min;
  // The cron expression only ever yields a complete row; a missing interval would otherwise
  // schedule setInterval(NaN), which fires in a tight loop.
  if (!sourceId || !intervalMinutes) return;
  const previous = timers.get(sourceId); if (previous) clearInterval(previous);
  timers.set(sourceId, setInterval(() => runSync(source).catch(() => {}), intervalMinutes * 60_000));
}
export async function stopCalendarSource(id: string): Promise<void> {
  const timer = timers.get(id); if (timer) clearInterval(timer); timers.delete(id);
  const state = inFlight.get(id);
  // Only real scheduled or active sources need a tombstone. In particular,
  // DELETE of an unknown ID must not grow this process-global set forever.
  if (!timer && !state) return;
  stopped.add(id);
  if (!state) return;
  state.removed = true;
  state.controller?.abort(new Error('Calendar source removed'));
  await state.promise;
}
export function releaseCalendarSource(id: string): void {
  stopped.delete(id);
}
export async function startExternalCalendarScheduler() {
  const result = await query('SELECT * FROM calendar_import_sources WHERE enabled = true');
  result.rows.forEach(scheduleCalendarSource);
}
