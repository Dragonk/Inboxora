// Pull-only external CalDAV/iCalendar import. Remote data is never modified and
// failures are recorded per source so one unavailable server cannot block others.
import crypto from 'crypto';
import { XMLParser } from 'fast-xml-parser';
import { query } from './db.js';
import { decrypt } from './encryption.js';
import { safeFetch } from './safeFetch.js';
import { getConnectionPolicy } from './connectionPolicy.js';
import { parseCalendarEvent } from '../routes/caldav.js';

const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, trimValues: false });
const syncing = new Set();
const timers = new Map();
const inFlight = new Map();
const stopped = new Set();
const toArray = (value) => (Array.isArray(value) ? value : value == null ? [] : [value]);
const textOf = (value) => typeof value === 'string' ? value : value?.['#text'] || '';
const basicAuth = (username, password) => `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

function calendarPayloads(raw) {
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
  return eventBlocks.map((block) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${context}${block}\r\nEND:VCALENDAR\r\n`);
}
function propsOf(response) {
  return toArray(response.propstat).reduce((result, propstat) => {
    if (!propstat.status || /\b2\d\d\b/.test(textOf(propstat.status))) Object.assign(result, propstat.prop || {});
    return result;
  }, {});
}

async function remoteFetch(source, options, policy, signal, secretSink) {
  const headers = { ...options.headers };
  if (source.kind === 'caldav') headers.Authorization = basicAuth(source.username, decrypt(source.password));
  const url = decrypt(source.url);
  if (!url) throw new Error('Stored calendar source URL is unavailable');
  secretSink?.push(url);
  const timeout = AbortSignal.timeout(30_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await safeFetch(url, { ...options, headers, redirect: 'follow', signal: requestSignal }, { allowPrivate: policy.allowPrivateHosts });
  if (!response.ok && response.status !== 207) throw new Error(`Remote calendar request failed (${response.status})`);
  return response.text();
}

async function fetchEvents(source, policy, signal, secretSink) {
  if (source.kind === 'ical_url') {
    const sourceDocument = await remoteFetch(source, { headers: { Accept: 'text/calendar' } }, policy, signal, secretSink);
    return { payloads: calendarPayloads(sourceDocument), sourceDocument };
  }
  const body = `<?xml version="1.0" encoding="utf-8"?><C:calendar-query xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><prop><getetag/><C:calendar-data/></prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"/></C:comp-filter></C:filter></C:calendar-query>`;
  const xml = parser.parse(await remoteFetch(source, { method: 'REPORT', headers: { 'Content-Type': 'application/xml; charset=utf-8', Depth: '1' }, body }, policy, signal, secretSink));
  const payloads = [];
  for (const response of toArray(xml?.multistatus?.response)) {
    const data = textOf(propsOf(response)['calendar-data']);
    if (data) payloads.push(data);
  }
  return { payloads, sourceDocument: null };
}

function throwIfRemoved(state) {
  if (state.removed) throw new Error('Calendar source removed');
}

async function calendarFor(source, state) {
  const externalUrl = `source:${source.id}`;
  const found = await query('SELECT id FROM calendars WHERE user_id = $1 AND external_url = $2', [source.user_id, externalUrl]);
  throwIfRemoved(state);
  if (found.rows[0]) return found.rows[0].id;
  for (let attempt = 0; attempt < 20; attempt++) {
    throwIfRemoved(state);
    const name = attempt ? `${source.display_name} (${attempt + 1})` : source.display_name;
    try {
      const inserted = await query(
        `INSERT INTO calendars (user_id, name, color, source, external_url, read_only)
         VALUES ($1, $2, $3, $4, $5, true) RETURNING id`,
        [source.user_id, name, source.color, source.kind, externalUrl],
      );
      return inserted.rows[0].id;
    } catch (error) {
      if (error.code !== '23505') throw error;
    }
  }
  throw new Error(`Could not create a calendar for "${source.display_name}"`);
}

async function syncSource(source) {
  if (syncing.has(source.id)) return { ok: false, error: 'A sync is already in progress' };
  syncing.add(source.id);
  const outboundSecrets = [];
  const state = { controller: new AbortController(), removed: false };
  inFlight.set(source.id, state);
  try {
    const { payloads, sourceDocument } = await fetchEvents(source, await getConnectionPolicy(), state.controller.signal, outboundSecrets);
    throwIfRemoved(state);
    const parsedEvents = payloads.map((raw, index) => ({ raw, index, event: parseCalendarEvent(raw) }));
    const events = parsedEvents.filter(({ event }) => event).map(({ event }) => event);
    const skipped = parsedEvents.filter(({ event }) => !event).map(({ raw, index }) => {
      const uid = raw.match(/(?:^|\r\n|\n|\r)UID(?:;[^:]*)?:([^\r\n]*)/i)?.[1]?.trim() || `event-${index + 1}`;
      return { uid, reason: 'unsupported or malformed VEVENT' };
    });
    // An empty or wholly unsupported response must never delete a healthy
    // projection. In a mixed response, retain only the explicitly skipped
    // UIDs; other rows are known to be absent from the feed and are stale.
    if (!events.length) throw new Error('Remote calendar contains an unsupported event');
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
      throwIfRemoved(state);
      seen.push(event.uid);
      const etag = crypto.createHash('sha256').update(event.raw).digest('hex');
      await query(
        `INSERT INTO calendar_events (calendar_id, user_id, uid, raw_ical, etag, summary, starts_at, ends_at, all_day, timezone)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (calendar_id, uid, recurrence_id) DO UPDATE SET raw_ical = EXCLUDED.raw_ical,
           etag = EXCLUDED.etag, summary = EXCLUDED.summary, starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at,
           all_day = EXCLUDED.all_day, timezone = EXCLUDED.timezone, updated_at = NOW()`,
        [calendarId, source.user_id, event.uid, event.raw, etag, event.summary, event.startsAt, event.endsAt, event.allDay, event.timeZone],
      );
    }
    throwIfRemoved(state);
    const retainedUids = [...seen, ...skipped.map(({ uid }) => uid)];
    await query('DELETE FROM calendar_events WHERE calendar_id = $1 AND uid <> ALL($2::text[])', [calendarId, retainedUids.length ? retainedUids : ['']]);
    if (skipped.length) {
      throwIfRemoved(state);
      const warning = skipped.map(({ uid, reason }) => `${uid}: ${reason}`).join('; ');
      await query('UPDATE calendar_import_sources SET last_sync_at = NOW(), last_error = $2 WHERE id = $1', [source.id, warning]);
      return { ok: true, eventCount: events.length, skipped };
    }
    throwIfRemoved(state);
    await query('UPDATE calendar_import_sources SET last_sync_at = NOW(), last_error = NULL WHERE id = $1', [source.id]);
    return { ok: true, eventCount: events.length };
  } catch (error) {
    if (state.removed) return { ok: false, error: 'Calendar source removed' };
    const secrets = [source.url, ...outboundSecrets].filter(value => typeof value === 'string' && value);
    const safeError = secrets.reduce((message, secret) => message.replaceAll(secret, '[redacted]'), String(error.message || 'Calendar source sync failed'));
    await query('UPDATE calendar_import_sources SET last_sync_at = NOW(), last_error = $2 WHERE id = $1', [source.id, safeError]);
    return { ok: false, error: safeError };
  } finally {
    syncing.delete(source.id);
    inFlight.delete(source.id);
  }
}

function runSync(source) {
  if (stopped.has(source.id)) return Promise.resolve({ ok: false, error: 'Calendar source removed' });
  if (inFlight.has(source.id)) return syncSource(source);
  const promise = syncSource(source);
  const state = inFlight.get(source.id);
  if (state) state.promise = promise;
  return promise;
}

export async function syncCalendarSource(userId, sourceId) {
  const result = await query('SELECT * FROM calendar_import_sources WHERE id = $1 AND user_id = $2 AND enabled = true', [sourceId, userId]);
  if (!result.rows[0]) return { ok: false, error: 'Calendar source not found' };
  return runSync(result.rows[0]);
}
export async function syncAllCalendarSources() {
  const result = await query('SELECT * FROM calendar_import_sources WHERE enabled = true');
  return Promise.allSettled(result.rows.map(runSync));
}
export function scheduleCalendarSource(source) {
  const previous = timers.get(source.id); if (previous) clearInterval(previous);
  timers.set(source.id, setInterval(() => runSync(source).catch(() => {}), source.interval_min * 60_000));
}
export async function stopCalendarSource(id) {
  stopped.add(id);
  const timer = timers.get(id); if (timer) clearInterval(timer); timers.delete(id);
  const state = inFlight.get(id);
  if (!state) return;
  state.removed = true;
  state.controller.abort(new Error('Calendar source removed'));
  await state.promise;
}
export async function startExternalCalendarScheduler() {
  const result = await query('SELECT * FROM calendar_import_sources WHERE enabled = true');
  result.rows.forEach(scheduleCalendarSource);
}
