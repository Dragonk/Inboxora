// CalDAV server — RFC 4791 discovery surface for DAVx5 and compatible clients.
// Auth: HTTP Basic with dedicated, revocable DAV application passwords only.

import { Router } from 'express';
import { parseCalendarEvent, parseUtc } from '../utils/ical.js';
import { projectCalendarResource } from '../utils/calendarRecurrence.js';
export { parseCalendarEvent } from '../utils/ical.js';
import { query } from '../services/db.js';
import { authLimiterConfig } from '../services/authLimiter.js';
import { createDavAuthMiddleware } from '../services/davServerAuth.js';
import { evaluateDavIf, ifMatchSatisfied } from '../utils/davPreconditions.js';
import { toAppError } from '../utils/errors.js';
import type { Request, Response, NextFunction } from 'express';

/**
 * Refuse a DAV write with a reason.
 *
 * `403` with no body is the least useful answer a client can get: it cannot distinguish a
 * permissions problem from a collection Inboxora keeps read-only because its source writes it, and
 * neither can a user reading a log. A `DAV:error` body is the standard place to say which.
 */
function davRefusal(res: Response, reason: string): void {
  res
    .status(403)
    .type('application/xml')
    .send(`<?xml version="1.0" encoding="utf-8"?><D:error xmlns:D="DAV:"><D:responsedescription>${xmlEscape(reason)}</D:responsedescription></D:error>`);
}

const router = Router();
const caldavBuckets = new Map();
const CALDAV_MAX_REQUESTS = 500;
const DAV_NS = 'DAV:';
const CALDAV_NS = 'urn:ietf:params:xml:ns:caldav';

/** Row shape shared by the event SELECTs below (calendar_events / calendar_sync_changes). */
interface CalendarEventRow {
  uid: string;
  etag?: string | null;
  deleted?: boolean;
  raw_ical?: string | null;
  dav_filename?: string | null;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of caldavBuckets) {
    if (now > bucket.resetAt) caldavBuckets.delete(key);
  }
}, 5 * 60 * 1000).unref();

function xmlEscape(value: unknown): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sendXml(res: Response, status: number, body: string) {
  res.status(status).setHeader('Content-Type', 'application/xml; charset=utf-8').send(body);
}

/**
 * The largest DAV body that means anything is one event or one card, and nothing else bounds this
 * stream: the application's JSON body limit does not apply to XML, calendar and vCard content types.
 * The cap belongs here, where the request is legitimately read.
 *
 * An oversized body is discarded rather than buffered, and the answer comes once the client has
 * finished sending — replying mid-upload left the exchange hanging. The rejection carries
 * body-parser's `entity.too.large` marker, so the application answers `413` with the same route-aware
 * message it already gives for an oversized JSON upload.
 */
const DAV_BODY_LIMIT_BYTES = 1_048_576;

function davBodyTooLarge(): Error & { type: string } {
  return Object.assign(new Error('DAV request body is too large'), { type: 'entity.too.large' });
}

function rawBody(req: Request) {
  return new Promise<string>((resolve, reject) => {
    if (typeof req.body === 'string') return resolve(req.body);
    if (Buffer.isBuffer(req.body)) return resolve(req.body.toString('utf8'));
    const declared = Number(req.headers['content-length'] ?? 0);
    let tooLarge = Number.isFinite(declared) && declared > DAV_BODY_LIMIT_BYTES;
    let body = '';
    let seen = 0;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      seen += Buffer.byteLength(chunk, 'utf8');
      if (seen > DAV_BODY_LIMIT_BYTES) { tooLarge = true; return; }
      body += chunk;
    });
    req.on('end', () => (tooLarge ? reject(davBodyTooLarge()) : resolve(body)));
    req.on('error', reject);
  });
}

/**
 * The report's root element name, with any namespace prefix removed.
 *
 * Dispatch used to be `body.includes('calendar-query')`, which the plan names as the wrong way: the string can
 * appear inside an href, and a multiget naming such a resource was then read as a query. The root element is what
 * the report actually is, and a declaration, comment or CDATA before it is skipped.
 */
function davReportName(body: string): string | null {
  const withoutPreamble = body
    .replace(/<\?xml[^>]*\?>/i, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trimStart();
  return /^<\s*(?:[A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)\b/.exec(withoutPreamble)?.[1] ?? null;
}

function uidFromCalendarHref(href: string) {
  try {
    return decodeURIComponent(href.trim().replace(/^.*\//, '')) || null;
  } catch {
    return null;
  }
}

function etagMatches(header: string, etag: string): boolean {
  // Strong comparison for If-Match (RFC 9110 §13.1.1): a weak validator never
  // matches. Kept as a thin alias so the two call sites read the same as before.
  return ifMatchSatisfied(header, etag);
}

function multistatus(responses: string[]) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<D:multistatus xmlns:D="${DAV_NS}" xmlns:C="${CALDAV_NS}">`,
    ...responses,
    '</D:multistatus>',
  ].join('');
}

function response(href: string, properties: string[], status = '200 OK') {
  return [
    '<D:response>',
    `<D:href>${xmlEscape(href)}</D:href>`,
    '<D:propstat><D:prop>',
    ...properties,
    `</D:prop><D:status>HTTP/1.1 ${status}</D:status></D:propstat>`,
    '</D:response>',
  ].join('');
}

// RFC 3744 privileges this server can actually enforce. The home collection is a
// container only — MKCALENDAR is not implemented — so it advertises read; a
// calendar collection adds the write privileges only when it is not read-only.
const READ_PRIVILEGES = ['<D:read/>'];
const WRITE_PRIVILEGES = ['<D:read/>', '<D:write/>', '<D:write-content/>', '<D:bind/>', '<D:unbind/>'];

type DavMode = 'off' | 'read_only' | 'read_write';

/** An unknown/absent mode is treated as fully enabled, matching pre-0105 rows. */
function davModeOf(value: unknown): DavMode {
  return value === 'off' || value === 'read_only' || value === 'read_write' ? value : 'read_write';
}

function privilegeSet(writable: boolean) {
  const privileges = writable ? WRITE_PRIVILEGES : READ_PRIVILEGES;
  return `<D:current-user-privilege-set>${privileges.map(privilege => `<D:privilege>${privilege}</D:privilege>`).join('')}</D:current-user-privilege-set>`;
}

// Only the reports this route actually implements are advertised (RFC 3253).
function supportedReportSet() {
  const reports = ['<C:calendar-query/>', '<C:calendar-multiget/>', '<D:sync-collection/>'];
  return `<D:supported-report-set>${reports.map(report => `<D:supported-report>${report}</D:supported-report>`).join('')}</D:supported-report-set>`;
}

/** Whether the authenticating device password may write at all. */
function credentialCanWrite(req: Request): boolean {
  return req.davMaxMode !== 'read_only';
}

/** The `Depth: 1` member listing of a calendar collection (RFC 4791 §5.2). */
function calendarCollectionProperties(calendar: { id: string; name?: string | null; sync_token?: string | null; read_only?: boolean | null; source?: string | null; dav_mode?: string | null }, credentialWritable: boolean): string[] {
  // The DAV mode and the device password can only narrow what the source already
  // allows, and a local, non-read-only calendar is the only thing a DAV write is
  // accepted for today.
  const writable = credentialWritable
    && davModeOf(calendar.dav_mode) === 'read_write'
    && !calendar.read_only
    && (calendar.source ?? 'local') === 'local';
  return [
    '<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>',
    `<D:displayname>${xmlEscape(calendar.name)}</D:displayname>`,
    `<D:sync-token>${xmlEscape(calendar.sync_token)}</D:sync-token>`,
    privilegeSet(writable),
    supportedReportSet(),
  ];
}

function caldavRateLimit(req: Request, res: Response, next: NextFunction) {
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

router.options('*', (_req: Request, res: Response) => {
  // Class 2 (LOCK) and class 3 (extended MKCOL) are not implemented and must not
  // be advertised; `calendar-access` plus class 1 matches the methods below.
  res.set({
    Allow: 'OPTIONS, GET, PUT, DELETE, PROPFIND, REPORT',
    DAV: '1, calendar-access',
  }).status(200).end();
});

router.propfind('/', (req: Request, res: Response) => {
  const principalPath = `/caldav/${req.caldavUserId}/`;
  sendXml(res, 207, multistatus([
    response('/caldav/', [
      '<D:resourcetype><D:collection/></D:resourcetype>',
      `<D:current-user-principal><D:href>${xmlEscape(principalPath)}</D:href></D:current-user-principal>`,
    ]),
  ]));
});

router.propfind('/:userId/', async (req: Request, res: Response) => {
  if (req.params.userId !== req.caldavUserId) return res.status(403).end();

  const calendars = await query<{ id: string; name?: string | null; sync_token?: string | null; read_only?: boolean | null; source?: string | null; dav_mode?: string | null }>(
    // A collection turned off is not discoverable at all.
    "SELECT id, name, sync_token, read_only, source, dav_mode FROM calendars WHERE user_id = $1 AND dav_mode <> 'off' ORDER BY created_at ASC",
    [req.caldavUserId],
  );
  const principalPath = `/caldav/${req.caldavUserId}/`;
  // The home is the principal collection itself, not one of its calendars: the old
  // response pointed `calendar-home-set` at the first calendar, so a client that
  // trusted it never discovered the others (plan A07/RFC 4791 §6.2.1).
  const responses = [
    response(principalPath, [
      '<D:resourcetype><D:principal/><D:collection/></D:resourcetype>',
      `<D:displayname>${xmlEscape(req.caldavUserId)}</D:displayname>`,
      `<D:current-user-principal><D:href>${xmlEscape(principalPath)}</D:href></D:current-user-principal>`,
      `<C:calendar-home-set><D:href>${xmlEscape(principalPath)}</D:href></C:calendar-home-set>`,
      // The home is a container; creating/removing calendars over DAV is not supported.
      privilegeSet(false),
    ]),
  ];
  // Depth: 1 lists the member calendar collections; Depth: 0 (the default) returns
  // only the home itself, as RFC 4918 requires.
  if (String(req.headers.depth ?? '0') === '1') {
    for (const calendar of calendars.rows) {
      responses.push(response(`${principalPath}${calendar.id}/`, calendarCollectionProperties(calendar, credentialCanWrite(req))));
    }
  }
  sendXml(res, 207, multistatus(responses));
});

router.propfind('/:userId/:calendarId/', async (req: Request, res: Response) => {
  if (req.params.userId !== req.caldavUserId) return res.status(403).end();

  const result = await query<{ id: string; name?: string | null; sync_token?: string | null; read_only?: boolean | null; source?: string | null; dav_mode?: string | null }>(
    'SELECT id, name, sync_token, read_only, source, dav_mode FROM calendars WHERE id = $1 AND user_id = $2',
    [req.params.calendarId, req.caldavUserId],
  );
  const calendar = result.rows[0];
  // An off collection is reported as missing, so its existence is not leaked.
  if (!calendar || davModeOf(calendar.dav_mode) === 'off') return res.status(404).end();

  sendXml(res, 207, multistatus([
    response(`/caldav/${req.caldavUserId}/${calendar.id}/`, calendarCollectionProperties(calendar, credentialCanWrite(req))),
  ]));
});

router.proppatch('/:userId/:calendarId/', async (req: Request, res: Response) => {
  if (req.params.userId !== req.caldavUserId) return res.status(403).end();
  return davRefusal(res, 'Calendar properties are managed by Inboxora, not by DAV clients.');
});

router.report('/:userId/:calendarId/', async (req: Request, res: Response) => {
  if (req.params.userId !== req.caldavUserId) return res.status(403).end();
  const calendarResult = await query<{ sync_version: number; dav_mode?: string | null; [key: string]: unknown }>(
    'SELECT id, sync_token, sync_version, dav_mode FROM calendars WHERE id = $1 AND user_id = $2',
    [req.params.calendarId, req.caldavUserId],
  );
  const calendar = calendarResult.rows[0];
  if (!calendar || davModeOf(calendar.dav_mode) === 'off') return res.status(404).end();

  const body = await rawBody(req);
  // Dispatch on the report's root element, not on a substring of its body.
  const reportName = davReportName(body);
  const isSyncCollection = reportName === 'sync-collection';
  const isCalendarQuery = reportName === 'calendar-query';
  const isCalendarMultiget = reportName === 'calendar-multiget';
  if (!reportName) return res.status(400).end();
  if (!isSyncCollection && !isCalendarQuery && !isCalendarMultiget) return res.status(400).end();

  const basePath = `/caldav/${req.caldavUserId}/${calendar.id}/`;
  let events: CalendarEventRow[];
  if (isSyncCollection) {
    const requestedToken = body.match(/<(?:[A-Za-z][\w.-]*:)?sync-token(?:\s[^>]*)?>([^<]*)<\/(?:[A-Za-z][\w.-]*:)?sync-token>/)?.[1]?.trim();
    const match = requestedToken?.match(/^sync-(\d+)$/);
    const requestedVersion = match ? Number(match[1]) : null;
    if (requestedToken && (requestedVersion === null || !Number.isSafeInteger(requestedVersion) || requestedVersion > calendar.sync_version)) {
      // RFC 6578 §3.2: an unrecognised/expired sync token is the 403
      // DAV:valid-sync-token precondition, which tells the client to resynchronise.
      return sendXml(res, 403, `<?xml version="1.0" encoding="UTF-8"?><D:error xmlns:D="${DAV_NS}"><D:valid-sync-token/></D:error>`);
    }
    if (requestedToken) {
      const changes = await query<CalendarEventRow>(
        `SELECT DISTINCT ON (uid, recurrence_id) uid, recurrence_id, etag, deleted, raw_ical, dav_filename
         FROM calendar_sync_changes
         WHERE calendar_id = $1 AND version > $2
         ORDER BY uid, recurrence_id, version DESC`,
        [calendar.id, requestedVersion],
      );
      events = changes.rows;
    } else {
      const current = await query<CalendarEventRow>(
        "SELECT uid, recurrence_id, etag, false AS deleted, raw_ical, dav_filename FROM calendar_events WHERE calendar_id = $1 AND recurrence_id = $2 ORDER BY uid ASC",
        [calendar.id, ''],
      );
      events = current.rows;
    }
  } else if (isCalendarMultiget) {
    const requestedUids = [...body.matchAll(/<(?:[A-Za-z][\w.-]*:)?href(?:\s[^>]*)?>([^<]+)<\/(?:[A-Za-z][\w.-]*:)?href>/g)]
      .map((match) => uidFromCalendarHref(match[1]))
      .filter(Boolean);
    if (!requestedUids.length) return res.status(400).end();
    const current = await query<CalendarEventRow>(
      "SELECT uid, recurrence_id, etag, raw_ical, dav_filename FROM calendar_events WHERE calendar_id = $1 AND recurrence_id = $2 AND COALESCE(dav_filename, uid || '.ics') = ANY($3) ORDER BY uid ASC",
      [calendar.id, '', requestedUids],
    );
    events = current.rows;
  } else {
    const timeRange = body.match(/<(?:[A-Za-z][\w.-]*:)?time-range\b[^>]*\bstart=["'](\d{8}T\d{6}Z)["'][^>]*\bend=["'](\d{8}T\d{6}Z)["'][^>]*\/?\s*>/i);
    const start = timeRange && parseUtc(timeRange[1]);
    const end = timeRange && parseUtc(timeRange[2]);
    if (timeRange && (!start || !end || end <= start)) return res.status(400).end();
    const current = start
      ? await query<CalendarEventRow>(
        // `recurring` is the stored, indexed form of the old raw_ical regex, which could
        // not use an index and forced a scan of the calendar (see migration 0082).
        "SELECT uid, recurrence_id, etag, raw_ical, dav_filename FROM calendar_events WHERE calendar_id = $1 AND recurrence_id = $2 AND ((starts_at < $4 AND ends_at > $3) OR recurring) ORDER BY uid ASC",
        [calendar.id, '', start, end],
      )
      : await query<CalendarEventRow>(
        "SELECT uid, recurrence_id, etag, raw_ical, dav_filename FROM calendar_events WHERE calendar_id = $1 AND recurrence_id = $2 ORDER BY uid ASC",
        [calendar.id, ''],
      );
    // `OR recurring` selects candidates; it is not the final word. A series whose rule never lands inside the
    // requested window is a candidate that matches nothing, and returning it hands the client resources it did
    // not ask for — so the projection decides, which is also what makes the filter correct across DST and
    // overrides rather than approximately right.
    events = start && end
      // The row is a calendar_events record; the projection reads its raw iCalendar, which is the only
      // part of it the helper needs.
      ? current.rows.filter(row => projectCalendarResource(
        row as unknown as Parameters<typeof projectCalendarResource>[0], start, end,
      ).length > 0)
      : current.rows;
  }

  const responses = events.map((event) => response(`${basePath}${encodeURIComponent(event.dav_filename || `${event.uid}.ics`)}`, event.deleted
    ? ['<D:resourcetype/>']
    : [
      '<D:resourcetype/>', `<D:getetag>"${xmlEscape(event.etag)}"</D:getetag>`,
      '<D:getcontenttype>text/calendar;charset=utf-8</D:getcontenttype>', `<C:calendar-data>${xmlEscape(event.raw_ical || '')}</C:calendar-data>`,
    ], event.deleted ? '404 Not Found' : '200 OK'));
  const xml = multistatus(responses).replace('</D:multistatus>', `<D:sync-token>${xmlEscape(calendar.sync_token)}</D:sync-token></D:multistatus>`);
  sendXml(res, 207, xml);
});

router.get('/:userId/:calendarId/:filename', async (req: Request, res: Response) => {
  if (req.params.userId !== req.caldavUserId) return res.status(403).end();
  const uid = req.params.filename;
  const result = await query(
    `SELECT e.raw_ical, e.etag FROM calendar_events e
     JOIN calendars c ON c.id = e.calendar_id
     WHERE c.id = $1 AND c.user_id = $2 AND c.dav_mode <> 'off' AND COALESCE(e.dav_filename, e.uid || '.ics') = $3`,
    [req.params.calendarId, req.caldavUserId, uid],
  );
  if (!result.rows[0]) return res.status(404).end();
  const event = result.rows[0];
  res.set({ ETag: `"${event.etag}"`, 'Content-Type': 'text/calendar; charset=utf-8' }).send(event.raw_ical);
});

router.put('/:userId/:calendarId/:filename', async (req: Request, res: Response) => {
  if (req.params.userId !== req.caldavUserId) return res.status(403).end();
  const calendarResult = await query<{ id: string; source?: string | null; read_only?: boolean | null; dav_mode?: string | null; sync_token?: string | null }>(
    'SELECT id, source, read_only, dav_mode, sync_token FROM calendars WHERE id = $1 AND user_id = $2',
    [req.params.calendarId, req.caldavUserId],
  );
  const calendar = calendarResult.rows[0];
  if (!calendar || davModeOf(calendar.dav_mode) === 'off') return res.status(404).end();
  // A read_only DAV mode blocks writes the same way a read-only source does, and a
  // read-only device password cannot write even to a read-write calendar.
  if (calendar.source !== 'local' || calendar.read_only || davModeOf(calendar.dav_mode) === 'read_only' || !credentialCanWrite(req)) {
    return davRefusal(res, calendar.source !== 'local'
      ? 'This calendar is written by its source, so Inboxora will not accept changes to it.'
      : 'This calendar is read-only.');
  }
  const event = parseCalendarEvent(await rawBody(req));
  const filename = req.params.filename;
  if (!event) return res.status(400).end();
  const currentResult = await query<{ uid: string; dav_filename?: string | null; etag: string; invite_account_id?: string | null }>(
    "SELECT uid, dav_filename, etag, invite_account_id FROM calendar_events WHERE calendar_id = $1 AND (uid = $2 OR COALESCE(dav_filename, uid || '.ics') = $4) AND recurrence_id = $3",
    [calendar.id, event.uid, '', filename],
  );
  const current = currentResult.rows[0];
  if (current?.uid && (current.uid !== event.uid || (current.dav_filename || `${current.uid}.ics`) !== filename)) return res.status(409).end();
  if (current?.invite_account_id) return res.status(409).end();
  if (req.headers['if-none-match'] === '*' && current) return res.status(412).end();
  if (req.headers['if-match'] && (!current || !etagMatches(req.headers['if-match'], current.etag))) return res.status(412).end();
  // The `If` header is a precondition too: a form we cannot evaluate fails rather
  // than silently unprotecting the write.
  const ifDecision = evaluateDavIf(req.headers['if'], { etag: current?.etag ?? null, syncToken: calendar.sync_token ?? null });
  if (ifDecision.status === 'bad-request') return res.status(400).end();
  if (ifDecision.status === 'precondition-failed') return res.status(412).end();
  let stored;
  try {
    stored = await query(
    `INSERT INTO calendar_events (calendar_id, user_id, uid, raw_ical, etag, summary, starts_at, ends_at, all_day, timezone, description, location, url, organizer, attendees, dav_filename)
     VALUES ($1, $2, $3, $4, gen_random_uuid()::text, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15)
     ON CONFLICT (calendar_id, uid, recurrence_id) DO UPDATE SET
       raw_ical = EXCLUDED.raw_ical, etag = gen_random_uuid()::text, summary = EXCLUDED.summary,
       starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at, all_day = EXCLUDED.all_day,
       timezone = EXCLUDED.timezone, description = EXCLUDED.description, location = EXCLUDED.location,
       url = EXCLUDED.url, organizer = EXCLUDED.organizer, attendees = EXCLUDED.attendees, dav_filename = EXCLUDED.dav_filename, updated_at = NOW()
     WHERE calendar_events.invite_account_id IS NULL AND COALESCE(calendar_events.dav_filename, calendar_events.uid || '.ics') = EXCLUDED.dav_filename AND calendar_events.etag = $16
     RETURNING uid, etag`,
     [calendar.id, req.caldavUserId, event.uid, event.raw, event.summary, event.startsAt, event.endsAt, event.allDay, event.timeZone, event.description, event.location, event.url, event.organizer, JSON.stringify(event.attendees), filename, current?.etag || null],
     );
  } catch (caught) {
    const error = toAppError(caught);
    if (error.code === '23505') return res.status(req.headers['if-none-match'] === '*' ? 412 : 409).end();
    throw error;
  }
     if (!stored.rows[0]) return res.status(req.headers['if-match'] || req.headers['if-none-match'] ? 412 : 409).end();
     res.setHeader('ETag', `"${stored.rows[0].etag}"`).status(current ? 204 : 201).end();
});

router.delete('/:userId/:calendarId/:filename', async (req: Request, res: Response) => {
  if (req.params.userId !== req.caldavUserId) return res.status(403).end();
  const calendarResult = await query<{ id: string; source?: string | null; read_only?: boolean | null; dav_mode?: string | null; sync_token?: string | null }>('SELECT id, source, read_only, dav_mode, sync_token FROM calendars WHERE id = $1 AND user_id = $2', [req.params.calendarId, req.caldavUserId]);
  const calendar = calendarResult.rows[0];
  if (!calendar || davModeOf(calendar.dav_mode) === 'off') return res.status(404).end();
  if (calendar.source !== 'local' || calendar.read_only || davModeOf(calendar.dav_mode) === 'read_only' || !credentialCanWrite(req)) {
    return davRefusal(res, calendar.source !== 'local'
      ? 'This calendar is written by its source, so Inboxora will not accept changes to it.'
      : 'This calendar is read-only.');
  }
  const uid = req.params.filename;
  const currentResult = await query<{ etag: string; invite_account_id?: string | null }>("SELECT etag, invite_account_id FROM calendar_events WHERE calendar_id = $1 AND COALESCE(dav_filename, uid || '.ics') = $2 AND recurrence_id = $3", [calendar.id, uid, '']);
  const current = currentResult.rows[0];
  if (!current) return res.status(404).end();
  if (current.invite_account_id) return res.status(409).end();
  if (req.headers['if-match'] && !etagMatches(req.headers['if-match'], current.etag)) return res.status(412).end();
  // The `If` header is a precondition too: a form we cannot evaluate fails rather
  // than silently unprotecting the delete.
  const ifDecision = evaluateDavIf(req.headers['if'], { etag: current.etag, syncToken: calendar.sync_token ?? null });
  if (ifDecision.status === 'bad-request') return res.status(400).end();
  if (ifDecision.status === 'precondition-failed') return res.status(412).end();
  const deleted = await query(
    "DELETE FROM calendar_events WHERE calendar_id = $1 AND COALESCE(dav_filename, uid || '.ics') = $2 AND recurrence_id = $3 AND invite_account_id IS NULL AND etag = $4 RETURNING id",
    [calendar.id, uid, '', current.etag],
  );
  if (!deleted.rows[0]) return res.status(req.headers['if-match'] ? 412 : 409).end();
  res.status(204).end();
});

export default router;
