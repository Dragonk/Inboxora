// CalDAV server — RFC 4791 discovery surface for DAVx5 and compatible clients.
// Auth: HTTP Basic with dedicated, revocable DAV application passwords only.

import { Router } from 'express';
import { query } from '../services/db.js';
import { authLimiterConfig } from '../services/authLimiter.js';
import { createDavAuthMiddleware } from '../services/davServerAuth.js';

const router = Router();
const caldavBuckets = new Map();
const CALDAV_MAX_REQUESTS = 500;
const DAV_NS = 'DAV:';
const CALDAV_NS = 'urn:ietf:params:xml:ns:caldav';

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of caldavBuckets) {
    if (now > bucket.resetAt) caldavBuckets.delete(key);
  }
}, 5 * 60 * 1000).unref();

function xmlEscape(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sendXml(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/xml; charset=utf-8').send(body);
}

function rawBody(req) {
  return new Promise((resolve, reject) => {
    if (typeof req.body === 'string') return resolve(req.body);
    if (Buffer.isBuffer(req.body)) return resolve(req.body.toString('utf8'));
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function unfoldICalendarLines(raw) {
  const lines = [];
  for (const physicalLine of raw.split(/\r\n|\n|\r/)) {
    if (/^[ \t]/.test(physicalLine) && lines.length) lines[lines.length - 1] += physicalLine.slice(1);
    else if (physicalLine) lines.push(physicalLine);
  }
  return lines;
}

function propertyFromLine(line) {
  const separator = line.indexOf(':');
  if (separator < 1) return null;
  const [name, ...parameterParts] = line.slice(0, separator).split(';');
  const parameters = Object.fromEntries(parameterParts.map((part) => {
    const parameterSeparator = part.indexOf('=');
    if (parameterSeparator < 1) return [part.toUpperCase(), ''];
    return [part.slice(0, parameterSeparator).toUpperCase(), part.slice(parameterSeparator + 1).replace(/^"|"$/g, '')];
  }));
  return { name: name.toUpperCase(), parameters, value: line.slice(separator + 1) };
}

function unescapeICalendarText(value) {
  return value.replace(/\\([\\;,nN])/g, (_match, escaped) => (escaped.toLowerCase() === 'n' ? '\n' : escaped));
}

function utcDate(year, month, day, hour = 0, minute = 0, second = 0) {
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    && date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second ? date : null;
}

function timeZoneParts(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(date);
    return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
  } catch {
    return null;
  }
}

function localDateInTimeZone(year, month, day, hour, minute, second, timeZone) {
  const wallTime = utcDate(year, month, day, hour, minute, second);
  if (!wallTime) return null;
  let instant = wallTime;
  for (let attempt = 0; attempt < 3; attempt++) {
    const parts = timeZoneParts(instant, timeZone);
    if (!parts) return null;
    const offset = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - instant.getTime();
    instant = new Date(wallTime.getTime() - offset);
  }
  const resolved = timeZoneParts(instant, timeZone);
  return resolved && resolved.year === year && resolved.month === month && resolved.day === day
    && resolved.hour === hour && resolved.minute === minute && resolved.second === second ? instant : null;
}

function parseUtc(value) {
  if (!/^\d{8}T\d{6}Z$/.test(value || '')) return null;
  return utcDate(Number(value.slice(0, 4)), Number(value.slice(4, 6)), Number(value.slice(6, 8)), Number(value.slice(9, 11)), Number(value.slice(11, 13)), Number(value.slice(13, 15)));
}

function parseICalendarDate(property) {
  const { value, parameters } = property;
  const dateOnly = parameters.VALUE?.toUpperCase() === 'DATE' || /^\d{8}$/.test(value);
  if (dateOnly) {
    if (!/^\d{8}$/.test(value)) return null;
    const date = utcDate(Number(value.slice(0, 4)), Number(value.slice(4, 6)), Number(value.slice(6, 8)));
    return date && { date, allDay: true, timeZone: null };
  }
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!match || parameters.VALUE) return null;
  const [, year, month, day, hour, minute, second, utc] = match;
  const numeric = [year, month, day, hour, minute, second].map(Number);
  if (utc) {
    if (parameters.TZID) return null;
    const date = utcDate(...numeric);
    return date && { date, allDay: false, timeZone: null };
  }
  const timeZone = parameters.TZID;
  if (!timeZone) return null;
  const date = localDateInTimeZone(...numeric, timeZone);
  return date && { date, allDay: false, timeZone };
}

function parseDuration(value) {
  const match = value.match(/^P(?:(\d+)W|(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?)$/);
  if (!match) return null;
  const milliseconds = ((Number(match[1] || 0) * 7 + Number(match[2] || 0)) * 24 * 60 * 60
    + Number(match[3] || 0) * 60 * 60 + Number(match[4] || 0) * 60 + Number(match[5] || 0)) * 1000;
  return milliseconds > 0 ? milliseconds : null;
}

export function parseCalendarEvent(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 1024 * 1024) return null;
  const lines = unfoldICalendarLines(raw);
  const componentLines = lines.map((line) => line.toUpperCase());
  const starts = componentLines.filter((line) => line === 'BEGIN:VEVENT');
  const ends = componentLines.filter((line) => line === 'END:VEVENT');
  const start = componentLines.indexOf('BEGIN:VEVENT');
  const end = componentLines.indexOf('END:VEVENT');
  if (starts.length !== 1 || ends.length !== 1 || start < 0 || end <= start) return null;
  const properties = lines.slice(start + 1, end).map(propertyFromLine);
  if (properties.some((property) => !property) || properties.some((property) => ['RRULE', 'RDATE', 'EXDATE', 'RECURRENCE-ID'].includes(property.name))) return null;
  const named = (name) => properties.filter((property) => property.name === name);
  const [uid] = named('UID');
  const [startProperty] = named('DTSTART');
  const [endProperty] = named('DTEND');
  const [durationProperty] = named('DURATION');
  if (!uid || named('UID').length !== 1 || !startProperty || named('DTSTART').length !== 1
    || named('DTEND').length > 1 || named('DURATION').length > 1 || (endProperty && durationProperty)) return null;
  const startsAt = parseICalendarDate(startProperty);
  if (!startsAt) return null;
  let endsAt;
  if (endProperty) {
    endsAt = parseICalendarDate(endProperty);
    if (!endsAt || endsAt.allDay !== startsAt.allDay) return null;
  } else if (durationProperty) {
    const duration = parseDuration(durationProperty.value);
    if (!duration || (startsAt.allDay && duration % (24 * 60 * 60 * 1000))) return null;
    endsAt = { date: new Date(startsAt.date.getTime() + duration), allDay: startsAt.allDay };
  } else return null;
  if (endsAt.date <= startsAt.date) return null;
  const [summary] = named('SUMMARY');
  return {
    uid: uid.value,
    startsAt: startsAt.date,
    endsAt: endsAt.date,
    allDay: startsAt.allDay,
    timeZone: startsAt.timeZone,
    summary: summary ? unescapeICalendarText(summary.value) : null,
    raw,
  };
}

function uidFromCalendarHref(href) {
  try {
    return decodeURIComponent(href.trim().replace(/^.*\//, '').replace(/\.ics$/i, '')) || null;
  } catch {
    return null;
  }
}

function etagMatches(header, etag) {
  return header === '*' || header.split(',').some((value) => value.trim().replace(/^W\//, '').replaceAll('"', '') === etag);
}

function multistatus(responses) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<D:multistatus xmlns:D="${DAV_NS}" xmlns:C="${CALDAV_NS}">`,
    ...responses,
    '</D:multistatus>',
  ].join('');
}

function response(href, properties, status = '200 OK') {
  return [
    '<D:response>',
    `<D:href>${xmlEscape(href)}</D:href>`,
    '<D:propstat><D:prop>',
    ...properties,
    `</D:prop><D:status>HTTP/1.1 ${status}</D:status></D:propstat>`,
    '</D:response>',
  ].join('');
}

function caldavRateLimit(req, res, next) {
  const { windowMs } = authLimiterConfig;
  const now = Date.now();
  const bucket = caldavBuckets.get(req.ip);
  if (!bucket || now > bucket.resetAt) {
    caldavBuckets.set(req.ip, { count: 1, resetAt: now + windowMs });
    return next();
  }
  if (bucket.count >= CALDAV_MAX_REQUESTS) {
    res.setHeader('Retry-After', Math.ceil((bucket.resetAt - now) / 1000));
    return res.status(429).end();
  }
  bucket.count++;
  next();
}

router.use(caldavRateLimit);
router.use(createDavAuthMiddleware({ realm: 'Inboxora CalDAV', eventType: 'caldav_auth_fail' }));
router.use((req, _res, next) => {
  req.caldavUserId = req.davUserId;
  req.caldavCredentialId = req.davCredentialId;
  next();
});

router.options('*', (_req, res) => {
  res.set({
    Allow: 'OPTIONS, GET, PUT, DELETE, PROPFIND, REPORT',
    DAV: '1, 2, 3, calendar-access',
  }).status(200).end();
});

router.propfind('/', (req, res) => {
  const principalPath = `/caldav/${req.caldavUserId}/`;
  sendXml(res, 207, multistatus([
    response('/caldav/', [
      '<D:resourcetype><D:collection/></D:resourcetype>',
      `<D:current-user-principal><D:href>${xmlEscape(principalPath)}</D:href></D:current-user-principal>`,
    ]),
  ]));
});

router.propfind('/:userId/', async (req, res) => {
  if (req.params.userId !== req.caldavUserId) return res.status(403).end();

  const calendars = await query(
    'SELECT id, name, sync_token FROM calendars WHERE user_id = $1 ORDER BY created_at ASC',
    [req.caldavUserId],
  );
  const principalPath = `/caldav/${req.caldavUserId}/`;
  const calendarHome = calendars.rows[0]
    ? `/caldav/${req.caldavUserId}/${calendars.rows[0].id}/`
    : principalPath;

  sendXml(res, 207, multistatus([
    response(principalPath, [
      '<D:resourcetype><D:principal/><D:collection/></D:resourcetype>',
      `<D:displayname>${xmlEscape(req.caldavUserId)}</D:displayname>`,
      `<D:current-user-principal><D:href>${xmlEscape(principalPath)}</D:href></D:current-user-principal>`,
      `<C:calendar-home-set><D:href>${xmlEscape(calendarHome)}</D:href></C:calendar-home-set>`,
    ]),
  ]));
});

router.propfind('/:userId/:calendarId/', async (req, res) => {
  if (req.params.userId !== req.caldavUserId) return res.status(403).end();

  const result = await query(
    'SELECT id, name, sync_token FROM calendars WHERE id = $1 AND user_id = $2',
    [req.params.calendarId, req.caldavUserId],
  );
  const calendar = result.rows[0];
  if (!calendar) return res.status(404).end();

  const calendarPath = `/caldav/${req.caldavUserId}/${calendar.id}/`;
  sendXml(res, 207, multistatus([
    response(calendarPath, [
      '<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>',
      `<D:displayname>${xmlEscape(calendar.name)}</D:displayname>`,
      `<D:sync-token>${xmlEscape(calendar.sync_token)}</D:sync-token>`,
    ]),
  ]));
});

router.report('/:userId/:calendarId/', async (req, res) => {
  if (req.params.userId !== req.caldavUserId) return res.status(403).end();
  const calendarResult = await query(
    'SELECT id, sync_token, sync_version FROM calendars WHERE id = $1 AND user_id = $2',
    [req.params.calendarId, req.caldavUserId],
  );
  const calendar = calendarResult.rows[0];
  if (!calendar) return res.status(404).end();

  const body = await rawBody(req);
  const isSyncCollection = body.includes('sync-collection');
  const isCalendarQuery = body.includes('calendar-query');
  const isCalendarMultiget = body.includes('calendar-multiget');
  if (!isSyncCollection && !isCalendarQuery && !isCalendarMultiget) return res.status(400).end();

  const basePath = `/caldav/${req.caldavUserId}/${calendar.id}/`;
  let events;
  if (isSyncCollection) {
    const requestedToken = body.match(/<(?:[A-Za-z][\w.-]*:)?sync-token(?:\s[^>]*)?>([^<]*)<\/(?:[A-Za-z][\w.-]*:)?sync-token>/)?.[1]?.trim();
    const match = requestedToken?.match(/^sync-(\d+)$/);
    const requestedVersion = match ? Number(match[1]) : null;
    if (requestedToken && (!Number.isSafeInteger(requestedVersion) || requestedVersion > calendar.sync_version)) {
      return sendXml(res, 409, `<?xml version="1.0" encoding="UTF-8"?><D:error xmlns:D="${DAV_NS}"><D:valid-sync-token/></D:error>`);
    }
    if (requestedToken) {
      const changes = await query(
        `SELECT DISTINCT ON (uid, recurrence_id) uid, recurrence_id, etag, deleted, raw_ical
         FROM calendar_sync_changes
         WHERE calendar_id = $1 AND version > $2
         ORDER BY uid, recurrence_id, version DESC`,
        [calendar.id, requestedVersion],
      );
      events = changes.rows;
    } else {
      const current = await query(
        "SELECT uid, recurrence_id, etag, false AS deleted, raw_ical FROM calendar_events WHERE calendar_id = $1 AND recurrence_id = $2 ORDER BY uid ASC",
        [calendar.id, ''],
      );
      events = current.rows;
    }
  } else if (isCalendarMultiget) {
    const requestedUids = [...body.matchAll(/<(?:[A-Za-z][\w.-]*:)?href(?:\s[^>]*)?>([^<]+)<\/(?:[A-Za-z][\w.-]*:)?href>/g)]
      .map((match) => uidFromCalendarHref(match[1]))
      .filter(Boolean);
    if (!requestedUids.length) return res.status(400).end();
    const current = await query(
      "SELECT uid, recurrence_id, etag, raw_ical FROM calendar_events WHERE calendar_id = $1 AND recurrence_id = $2 AND uid = ANY($3) ORDER BY uid ASC",
      [calendar.id, '', requestedUids],
    );
    events = current.rows;
  } else {
    const timeRange = body.match(/<(?:[A-Za-z][\w.-]*:)?time-range\b[^>]*\bstart=["'](\d{8}T\d{6}Z)["'][^>]*\bend=["'](\d{8}T\d{6}Z)["'][^>]*\/?\s*>/i);
    const start = timeRange && parseUtc(timeRange[1]);
    const end = timeRange && parseUtc(timeRange[2]);
    if (timeRange && (!start || !end || end <= start)) return res.status(400).end();
    const current = start
      ? await query(
        "SELECT uid, recurrence_id, etag, raw_ical FROM calendar_events WHERE calendar_id = $1 AND recurrence_id = $2 AND starts_at < $4 AND ends_at > $3 ORDER BY uid ASC",
        [calendar.id, '', start, end],
      )
      : await query(
        "SELECT uid, recurrence_id, etag, raw_ical FROM calendar_events WHERE calendar_id = $1 AND recurrence_id = $2 ORDER BY uid ASC",
        [calendar.id, ''],
      );
    events = current.rows;
  }

  const responses = events.map((event) => response(`${basePath}${encodeURIComponent(event.uid)}.ics`, event.deleted
    ? ['<D:resourcetype/>']
    : [
      '<D:resourcetype/>', `<D:getetag>"${xmlEscape(event.etag)}"</D:getetag>`,
      '<D:getcontenttype>text/calendar;charset=utf-8</D:getcontenttype>', `<C:calendar-data>${xmlEscape(event.raw_ical || '')}</C:calendar-data>`,
    ], event.deleted ? '404 Not Found' : '200 OK'));
  const xml = multistatus(responses).replace('</D:multistatus>', `<D:sync-token>${xmlEscape(calendar.sync_token)}</D:sync-token></D:multistatus>`);
  sendXml(res, 207, xml);
});

router.get('/:userId/:calendarId/:filename', async (req, res) => {
  if (req.params.userId !== req.caldavUserId) return res.status(403).end();
  const uid = req.params.filename.replace(/\.ics$/i, '');
  const result = await query(
    `SELECT e.raw_ical, e.etag FROM calendar_events e
     JOIN calendars c ON c.id = e.calendar_id
     WHERE c.id = $1 AND c.user_id = $2 AND e.uid = $3`,
    [req.params.calendarId, req.caldavUserId, uid],
  );
  if (!result.rows[0]) return res.status(404).end();
  const event = result.rows[0];
  res.set({ ETag: `"${event.etag}"`, 'Content-Type': 'text/calendar; charset=utf-8' }).send(event.raw_ical);
});

router.put('/:userId/:calendarId/:filename', async (req, res) => {
  if (req.params.userId !== req.caldavUserId) return res.status(403).end();
  const calendarResult = await query(
    'SELECT id, source, read_only FROM calendars WHERE id = $1 AND user_id = $2',
    [req.params.calendarId, req.caldavUserId],
  );
  const calendar = calendarResult.rows[0];
  if (!calendar) return res.status(404).end();
  if (calendar.source !== 'local' || calendar.read_only) return res.status(403).end();
  const event = parseCalendarEvent(await rawBody(req));
  const filenameUid = req.params.filename.replace(/\.ics$/i, '');
  if (!event || event.uid !== filenameUid) return res.status(400).end();
  const currentResult = await query(
    'SELECT etag, invite_account_id FROM calendar_events WHERE calendar_id = $1 AND uid = $2 AND recurrence_id = $3',
    [calendar.id, event.uid, ''],
  );
  const current = currentResult.rows[0];
  if (current?.invite_account_id) return res.status(409).end();
  if (req.headers['if-none-match'] === '*' && current) return res.status(412).end();
  if (req.headers['if-match'] && (!current || !etagMatches(req.headers['if-match'], current.etag))) return res.status(412).end();
  const stored = await query(
    `INSERT INTO calendar_events (calendar_id, user_id, uid, raw_ical, etag, summary, starts_at, ends_at, all_day, timezone)
     VALUES ($1, $2, $3, $4, gen_random_uuid()::text, $5, $6, $7, $8, $9)
     ON CONFLICT (calendar_id, uid, recurrence_id) DO UPDATE SET
       raw_ical = EXCLUDED.raw_ical, etag = gen_random_uuid()::text, summary = EXCLUDED.summary,
       starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at, all_day = EXCLUDED.all_day,
       timezone = EXCLUDED.timezone, updated_at = NOW()
     WHERE calendar_events.invite_account_id IS NULL
     RETURNING uid, etag`,
     [calendar.id, req.caldavUserId, event.uid, event.raw, event.summary, event.startsAt, event.endsAt, event.allDay, event.timeZone],
     );
     if (!stored.rows[0]) return res.status(409).end();
     res.setHeader('ETag', `"${stored.rows[0].etag}"`).status(current ? 204 : 201).end();
});

router.delete('/:userId/:calendarId/:filename', async (req, res) => {
  if (req.params.userId !== req.caldavUserId) return res.status(403).end();
  const calendarResult = await query('SELECT id, source, read_only FROM calendars WHERE id = $1 AND user_id = $2', [req.params.calendarId, req.caldavUserId]);
  const calendar = calendarResult.rows[0];
  if (!calendar) return res.status(404).end();
  if (calendar.source !== 'local' || calendar.read_only) return res.status(403).end();
  const uid = req.params.filename.replace(/\.ics$/i, '');
  const currentResult = await query('SELECT etag, invite_account_id FROM calendar_events WHERE calendar_id = $1 AND uid = $2 AND recurrence_id = $3', [calendar.id, uid, '']);
  const current = currentResult.rows[0];
  if (!current) return res.status(404).end();
  if (current.invite_account_id) return res.status(409).end();
  if (req.headers['if-match'] && !etagMatches(req.headers['if-match'], current.etag)) return res.status(412).end();
  const deleted = await query(
    'DELETE FROM calendar_events WHERE calendar_id = $1 AND uid = $2 AND recurrence_id = $3 AND invite_account_id IS NULL RETURNING id',
    [calendar.id, uid, ''],
  );
  if (!deleted.rows[0]) return res.status(409).end();
  res.status(204).end();
});

export default router;
