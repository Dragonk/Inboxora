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
const toArray = (value) => (Array.isArray(value) ? value : value == null ? [] : [value]);
const textOf = (value) => typeof value === 'string' ? value : value?.['#text'] || '';
const basicAuth = (username, password) => `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

function calendarPayloads(raw) {
  const blocks = raw.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || [];
  return blocks.map((block) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${block}\r\nEND:VCALENDAR\r\n`);
}
function propsOf(response) {
  return toArray(response.propstat).reduce((result, propstat) => {
    if (!propstat.status || /\b2\d\d\b/.test(textOf(propstat.status))) Object.assign(result, propstat.prop || {});
    return result;
  }, {});
}

async function remoteFetch(source, options, policy) {
  const headers = { ...options.headers };
  if (source.kind === 'caldav') headers.Authorization = basicAuth(source.username, decrypt(source.password));
  const response = await safeFetch(source.url, { ...options, headers, redirect: 'follow', signal: AbortSignal.timeout(30_000) }, { allowPrivate: policy.allowPrivateHosts });
  if (!response.ok && response.status !== 207) throw new Error(`Remote calendar request failed (${response.status})`);
  return response.text();
}

async function fetchEvents(source, policy) {
  if (source.kind === 'ical_url') return calendarPayloads(await remoteFetch(source, { headers: { Accept: 'text/calendar' } }, policy));
  const body = `<?xml version="1.0" encoding="utf-8"?><C:calendar-query xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><prop><getetag/><C:calendar-data/></prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"/></C:comp-filter></C:filter></C:calendar-query>`;
  const xml = parser.parse(await remoteFetch(source, { method: 'REPORT', headers: { 'Content-Type': 'application/xml; charset=utf-8', Depth: '1' }, body }, policy));
  const payloads = [];
  for (const response of toArray(xml?.multistatus?.response)) {
    const data = textOf(propsOf(response)['calendar-data']);
    if (data) payloads.push(data);
  }
  return payloads;
}

async function calendarFor(source) {
  const externalUrl = `source:${source.id}`;
  const found = await query('SELECT id FROM calendars WHERE user_id = $1 AND external_url = $2', [source.user_id, externalUrl]);
  if (found.rows[0]) return found.rows[0].id;
  for (let attempt = 0; attempt < 20; attempt++) {
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
  try {
    const payloads = await fetchEvents(source, await getConnectionPolicy());
    const parsedEvents = payloads.map(parseCalendarEvent);
    // Do not mistake a malformed or unsupported response for an empty/partial
    // remote calendar: that could delete a previously healthy local projection.
    if (parsedEvents.some((event) => !event)) throw new Error('Remote calendar contains an unsupported event');
    const events = parsedEvents;
    const calendarId = await calendarFor(source);
    const seen = [];
    for (const event of events) {
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
    await query('DELETE FROM calendar_events WHERE calendar_id = $1 AND uid <> ALL($2::text[])', [calendarId, seen.length ? seen : ['']]);
    await query('UPDATE calendar_import_sources SET last_sync_at = NOW(), last_error = NULL WHERE id = $1', [source.id]);
    return { ok: true, eventCount: events.length };
  } catch (error) {
    await query('UPDATE calendar_import_sources SET last_sync_at = NOW(), last_error = $2 WHERE id = $1', [source.id, error.message]);
    return { ok: false, error: error.message };
  } finally { syncing.delete(source.id); }
}

export async function syncCalendarSource(userId, sourceId) {
  const result = await query('SELECT * FROM calendar_import_sources WHERE id = $1 AND user_id = $2 AND enabled = true', [sourceId, userId]);
  if (!result.rows[0]) return { ok: false, error: 'Calendar source not found' };
  return syncSource(result.rows[0]);
}
export async function syncAllCalendarSources() {
  const result = await query('SELECT * FROM calendar_import_sources WHERE enabled = true');
  return Promise.allSettled(result.rows.map(syncSource));
}
export function scheduleCalendarSource(source) {
  const previous = timers.get(source.id); if (previous) clearInterval(previous);
  timers.set(source.id, setInterval(() => syncSource(source).catch(() => {}), source.interval_min * 60_000));
}
export function stopCalendarSource(id) { const timer = timers.get(id); if (timer) clearInterval(timer); timers.delete(id); }
export async function startExternalCalendarScheduler() {
  const result = await query('SELECT * FROM calendar_import_sources WHERE enabled = true');
  result.rows.forEach(scheduleCalendarSource);
}
