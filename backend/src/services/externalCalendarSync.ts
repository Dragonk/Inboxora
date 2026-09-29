import { calendarResources } from '../utils/calendarRecurrence.js';
import { requireCompleteMultistatus, decodeDavCharRefs } from '../utils/davXml.js';
// Pull-only external CalDAV/iCalendar import. Remote data is never modified and
// failures are recorded per source so one unavailable server cannot block others.
import crypto from 'crypto';
import { XMLParser } from 'fast-xml-parser';
import { query, type DbClient } from './db.js';
import { decrypt } from './encryption.js';
import { safeFetch } from './safeFetch.js';
import { davCollectionRequest, inspectDavCollection, normalizeDavCollectionUrl, resolveDavHref } from './davCollectionClient.js';
import { captureDavSourceFence, withDavSourceProjection, isDavCollectionBlocked, retireDavCalendarSource } from './davCollectionLifecycle.js';
import { getConnectionPolicy } from './connectionPolicy.js';
import { parseCalendarEvent } from '../utils/ical.js';
import { toAppError } from '../utils/errors.js';
import { ensureExternalCollectionLink, type ExternalSourceKind } from './providers/externalCollectionLinks.js';
import { discoverDavWriteAccess } from './carddavClient.js';

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

class MissingCalendarCollectionError extends Error {}

async function remoteFetch(source: ExternalCalendarSource, options: ExternalFetchOptions, policy: ExternalCalendarPolicy, signal: AbortSignal | null | undefined, secretSink?: string[]): Promise<string> {
  const headers: Record<string, string> = { ...options.headers };
  const url = decrypt(source.url);
  if (!url) throw new Error('Stored calendar source URL is unavailable');
  secretSink?.push(url);
  const timeout = AbortSignal.timeout(30_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const request = { ...options, headers, redirect: 'follow' as const, signal: requestSignal };
  let response: Response;
  if (source.kind === 'caldav') {
    const password = decrypt(source.password ?? '');
    if (!password) throw new Error('Stored calendar source password is unavailable');
    response = await davCollectionRequest({ url, username: source.username ?? '', password, allowPrivate: policy.allowPrivateHosts }, request);
    if (response.status === 404 || response.status === 410) throw new MissingCalendarCollectionError('Remote calendar collection may be missing');
    if (response.status !== 207) throw new Error(`Remote calendar REPORT did not return a multistatus response (${response.status})`);
  } else {
    response = await safeFetch(url, request, { allowPrivate: policy.allowPrivateHosts });
  }
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
  const collectionUrl = normalizeDavCollectionUrl(String(decrypt(source.url) ?? ''));
  for (const response of toArray(xml?.multistatus?.response)) {
    const href = resolveDavHref(textOf(response.href), collectionUrl);
    if (!href.startsWith(collectionUrl) || href === collectionUrl) throw new Error('DAV calendar resource is outside the requested collection');
    const data = decodeDavCharRefs(textOf(propsOf(response)['calendar-data']));
    if (!textOf(response.href).trim() || !data.trim()) throw new Error('DAV server returned an incomplete calendar resource');
    payloads.push(data);
  }
  return { payloads, sourceDocument: null };
}

function throwIfRemoved(state: CalendarSyncState): void {
  if (state.removed) throw new Error('Calendar source removed');
}

async function calendarFor(source: ExternalCalendarSource, state: CalendarSyncState, client: DbClient) {
  const externalUrl = `source:${source.id}`;
  const found = await client.query<{ id: string }>('SELECT id FROM calendars WHERE user_id = $1 AND owner_user_id = $1 AND external_url = $2 AND source = $3', [source.user_id, externalUrl, source.kind]);
  throwIfRemoved(state);
  if (found.rows[0]) return found.rows[0].id;
  for (let attempt = 0; attempt < 20; attempt++) {
    throwIfRemoved(state);
    const name = attempt ? `${source.display_name} (${attempt + 1})` : source.display_name;
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO calendars (user_id, owner_user_id, name, color, source, external_url, read_only, dav_mode)
       VALUES ($1, $1, $2, $3, $4, $5, true, 'off') ON CONFLICT DO NOTHING RETURNING id`,
      [source.user_id, name, source.color, source.kind, externalUrl],
    );
    if (inserted.rows[0]) return inserted.rows[0].id;
  }
  throw new Error(`Could not create a calendar for "${source.display_name}"`);
}

async function linkExternalCollection(source: ExternalCalendarSource, calendarId: string, discoveredAccess: 'read_only' | 'read_write', client: DbClient): Promise<void> {
  const linked = await ensureExternalCollectionLink({
    userId: String(source.user_id ?? ''),
    kind: externalSourceKind(source.kind),
    url: typeof source.url === 'string' && source.url ? source.url : `source:${source.id}`,
    remoteId: `source:${source.id}`,
    label: typeof source.display_name === 'string' ? source.display_name : null,
    localCalendarId: calendarId,
    discoveredAccess,
  }, client);
  if (!linked) throw new Error('The calendar source connection could not be linked');
}

async function syncSource(source: ExternalCalendarSource): Promise<{ ok: boolean; error?: string; eventCount?: number; skipped?: Array<{ uid: string; reason: string }>; removed?: boolean }> {
  const sourceId = source.id;
  if (!sourceId) return { ok: false, error: 'Calendar source is incomplete' };
  if (syncing.has(sourceId)) return { ok: false, error: 'A sync is already in progress' };
  syncing.add(sourceId);
  const outboundSecrets: string[] = [];
  const state = { controller: new AbortController(), removed: false };
  inFlight.set(sourceId, state);
  let generation: string | undefined;
  try {
    const userId = String(source.user_id ?? '');
    generation = await captureDavSourceFence(userId, 'calendar', sourceId);
    // Scheduled jobs carry identifiers, never authority to use stale credentials/configuration.
    const current = await query<ExternalCalendarSource>('SELECT * FROM calendar_import_sources WHERE id = $1 AND user_id = $2 AND enabled = true', [sourceId, userId]);
    if (!current.rows[0]) throw new Error('Calendar source removed');
    source = current.rows[0];
    const policy = await getConnectionPolicy();
    let fetched;
    try {
      fetched = await fetchEvents(source, policy, state.controller.signal, outboundSecrets);
    } catch (error) {
      if (!(error instanceof MissingCalendarCollectionError)) throw error;
      const presence = await inspectDavCollection({
        kind: 'calendar',
        url: String(decrypt(source.url) ?? ''), username: source.username ?? '',
        password: String(decrypt(source.password ?? '') ?? ''), allowPrivate: policy.allowPrivateHosts,
      });
      if (presence !== 'missing') throw new Error('Remote calendar collection absence could not be verified', { cause: error });
      throwIfRemoved(state);
      await retireDavCalendarSource(userId, sourceId, generation);
      return { ok: true, removed: true, eventCount: 0 };
    }
    const { payloads, sourceDocument } = fetched;
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
    const discoveredAccess = source.kind === 'caldav' ? await discoverDavWriteAccess({
      url: String(decrypt(source.url) ?? ''), username: source.username ?? '',
      password: String(decrypt(source.password ?? '') ?? ''), allowPrivate: policy.allowPrivateHosts,
    }) ?? 'read_only' : 'read_only';
    return await withDavSourceProjection(userId, 'calendar', sourceId, generation, async client => {
      throwIfRemoved(state);
      if (source.kind === 'caldav' && await isDavCollectionBlocked(client, userId, 'calendar', sourceId, String(decrypt(source.url) ?? ''))) {
        throw new Error('Calendar collection deletion is pending');
      }
      const calendarId = await calendarFor(source, state, client);
      await linkExternalCollection(source, calendarId, discoveredAccess, client);
      if (sourceDocument) {
        throwIfRemoved(state);
        await client.query(
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
        await client.query(
          `INSERT INTO calendar_events (calendar_id, user_id, uid, raw_ical, etag, summary, starts_at, ends_at, all_day, timezone, description, location, url, organizer, attendees)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
           ON CONFLICT (calendar_id, uid, recurrence_id) DO UPDATE SET raw_ical = EXCLUDED.raw_ical,
             etag = EXCLUDED.etag, summary = EXCLUDED.summary, starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at,
             all_day = EXCLUDED.all_day, timezone = EXCLUDED.timezone, description = EXCLUDED.description,
             location = EXCLUDED.location, url = EXCLUDED.url, organizer = EXCLUDED.organizer, attendees = EXCLUDED.attendees, updated_at = NOW()
           WHERE (calendar_events.raw_ical, calendar_events.etag, calendar_events.summary, calendar_events.starts_at, calendar_events.ends_at, calendar_events.all_day, calendar_events.timezone, calendar_events.description, calendar_events.location, calendar_events.url, calendar_events.organizer, calendar_events.attendees)
             IS DISTINCT FROM (EXCLUDED.raw_ical, EXCLUDED.etag, EXCLUDED.summary, EXCLUDED.starts_at, EXCLUDED.ends_at, EXCLUDED.all_day, EXCLUDED.timezone, EXCLUDED.description, EXCLUDED.location, EXCLUDED.url, EXCLUDED.organizer, EXCLUDED.attendees)`,
          [calendarId, source.user_id, event.uid, event.raw, etag, event.summary, event.startsAt, event.endsAt, event.allDay, event.timeZone, event.description, event.location, event.url, event.organizer, JSON.stringify(event.attendees)],
        );
      }
      throwIfRemoved(state);
      const retainedUids = [...seen, ...skipped.map(({ uid }) => uid)];
      await client.query('DELETE FROM calendar_events WHERE calendar_id = $1 AND uid <> ALL($2::text[])', [calendarId, retainedUids.length ? retainedUids : ['']]);
      if (skipped.length) {
        throwIfRemoved(state);
        const warning = JSON.stringify({ code: 'unsupported_events', count: skipped.length, samples: skipped.slice(0, 3) });
        await client.query('UPDATE calendar_import_sources SET last_sync_at = NOW(), last_error = $2 WHERE id = $1 AND user_id = $3', [source.id, warning, userId]);
        return { ok: true, eventCount: events.length, skipped };
      }
      throwIfRemoved(state);
      await client.query('UPDATE calendar_import_sources SET last_sync_at = NOW(), last_error = NULL WHERE id = $1 AND user_id = $2', [source.id, userId]);
      return { ok: true, eventCount: events.length };
    });
  } catch (caught) {
    const error = toAppError(caught);
    if (state.removed) return { ok: false, error: 'Calendar source removed' };
    const secrets = [source.url, ...outboundSecrets].filter((value): value is string => typeof value === 'string' && value !== '');
    const safeError = secrets.reduce((message, secret) => message.replaceAll(secret, '[redacted]'), String(error.message || 'Calendar source sync failed'));
    if (generation) {
      try {
        await withDavSourceProjection(String(source.user_id ?? ''), 'calendar', sourceId, generation, async client => {
          await client.query('UPDATE calendar_import_sources SET last_sync_at = NOW(), last_error = $2 WHERE id = $1 AND user_id = $3', [source.id, safeError, source.user_id]);
        });
      } catch (fenceError) {
        console.warn('Calendar sync failure could not be recorded for its original source generation:', toAppError(fenceError).message);
      }
    }
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
  return runSync({ id: sourceId, user_id: userId });
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
  timers.set(sourceId, setInterval(() => {
    void syncCalendarSource(String(source.user_id ?? ''), sourceId).catch(error => {
      console.warn('Scheduled calendar sync failed:', toAppError(error).message);
    });
  }, intervalMinutes * 60_000));
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
