import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { XMLParser } from 'fast-xml-parser';
import { decodeDavCharRefs, requireCompleteMultistatus } from '../../utils/davXml.js';
import { parseCalendarEvent } from '../../utils/ical.js';
import type { ParsedICalendarEvent } from '../../utils/ical.js';
import { davAuthenticatedFetch } from '../davHttpAuth.js';
import { DavProjectionGuardError, executeDavWriteBack, joinDavUrl } from './davWriteBack.js';
import type {
  DavProjectionCommit,
  DavRemoteResource,
  DavSource,
  DavWriteBackDeps,
  DavWriteBackRouteResult,
  DavWriteBackSpec,
} from './davWriteBack.js';

/**
 * CalDAV write-back (P10): a DAV `PUT`/`DELETE` on an imported calendar reaches the server the
 * calendar was imported from.
 *
 * The remote resource is located the way the read client addresses it: the `remote_object_links`
 * row written by the provider projection when one exists, and otherwise a `calendar-query` REPORT
 * matched on the event UID — the UID is the only identity both sides agree on, and a filename can
 * be chosen by a client. Only a confirmed source answer becomes a local projection, in one
 * transaction with the link's new version.
 */

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  trimValues: false,
  processEntities: { maxTotalExpansions: 10_000_000, maxExpansionDepth: 10 },
});

interface DavPropStat { status?: unknown; prop?: Record<string, unknown> }

const toArray = <T>(value: T | T[] | null | undefined): T[] => (Array.isArray(value) ? value : value == null ? [] : [value]);

function textOf(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'object' && node !== null && '#text' in node) {
    return String((node as Record<string, unknown>)['#text']);
  }
  return '';
}

function propsOf(response: { propstat?: DavPropStat | DavPropStat[] }): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const propstat of toArray(response.propstat)) {
    const status = textOf(propstat.status);
    if (status && !/\b2\d\d\b/.test(status)) continue;
    Object.assign(merged, propstat.prop ?? {});
  }
  return merged;
}

function absolute(href: string, baseUrl: string): string {
  try { return new URL(href, baseUrl).href; }
  catch { return href; }
}

export interface CaldavRemoteEvent {
  href: string;
  version: string | null;
  uid: string | null;
  raw: string;
}

/** Pure: extract the calendar resources of a `calendar-query` multistatus. Exported for testing. */
export function parseCaldavCollectionResources(xmlText: unknown, baseUrl: string): CaldavRemoteEvent[] {
  const raw = String(xmlText ?? '');
  const xml = parser.parse(raw);
  requireCompleteMultistatus(raw, xml);
  const events: CaldavRemoteEvent[] = [];
  for (const response of toArray(xml?.multistatus?.response)) {
    const props = propsOf(response);
    const ical = decodeDavCharRefs(textOf(props['calendar-data']));
    if (!ical) continue;
    const parsed = parseCalendarEvent(ical);
    events.push({
      href: absolute(textOf(response.href) || String(response.href ?? ''), baseUrl),
      version: textOf(props.getetag).replace(/"/g, '') || null,
      uid: parsed?.uid ?? null,
      raw: ical,
    });
  }
  return events;
}

const CALDAV_QUERY_BODY = '<?xml version="1.0" encoding="utf-8"?><C:calendar-query xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><prop><getetag/><C:calendar-data/></prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"/></C:comp-filter></C:filter></C:calendar-query>';

/** Read the remote collection and find the resource whose UID is `uid`. */
export async function resolveRemoteCaldavEvent(source: DavSource, uid: string): Promise<DavRemoteResource | null> {
  const response = await davAuthenticatedFetch(source.collectionUrl, {
    method: 'REPORT',
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      Depth: '1',
    },
    body: CALDAV_QUERY_BODY,
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  }, { username: source.username, password: source.password }, { allowPrivate: source.allowPrivate });
  if (!response.ok && response.status !== 207) {
    if (response.status === 401 || response.status === 403) {
      throw Object.assign(new Error('CalDAV source refused the credentials'), { status: response.status, code: 'PROVIDER_AUTH_REQUIRED' });
    }
    throw Object.assign(new Error(`CalDAV source read failed (${response.status})`), { status: response.status });
  }
  const events = parseCaldavCollectionResources(await response.text(), source.collectionUrl);
  const match = events.find(event => event.uid === uid);
  return match ? { href: match.href, version: match.version } : null;
}

export interface CaldavWriteBackInput {
  method: 'PUT' | 'DELETE';
  userId: string;
  calendar: { id: string; external_url?: string | null; source?: string | null };
  filename: string;
  uid: string;
  /** The complete iCalendar resource, for a PUT. Empty for a DELETE. */
  raw: string;
  /** The parsed projection fields, for a PUT. Null for a DELETE. */
  parsed: ParsedICalendarEvent | null;
  exists: boolean;
  localObjectId: string | null;
  localRevision: string | null;
  credentialId?: string | null;
}

function specFor(input: CaldavWriteBackInput): DavWriteBackSpec {
  return {
    method: input.method,
    kind: 'caldav',
    objectType: 'calendar_event',
    userId: input.userId,
    localCollectionId: input.calendar.id,
    externalUrl: input.calendar.external_url ?? null,
    localObjectId: input.localObjectId,
    uid: input.uid,
    filename: input.filename,
    exists: input.exists,
    localRevision: input.localRevision,
    body: input.raw,
    contentType: 'text/calendar; charset=utf-8',
    credentialId: input.credentialId ?? null,
  };
}

/**
 * Apply the confirmed CalDAV answer to `calendar_events` and return the new local entity-tag.
 *
 * A guarded upsert/delete rather than an unconditional one: if the local row changed between the
 * client's precondition and this commit, nothing is written and the caller reports a conflict
 * instead of silently overwriting a newer local edit.
 */
export async function commitCaldavProjection(
  client: PoolClient,
  input: CaldavWriteBackInput,
  _commit: DavProjectionCommit,
): Promise<string> {
  const etag = crypto.createHash('sha256').update(input.raw).digest('hex');
  if (input.method === 'DELETE') {
    const deleted = await client.query(
      `DELETE FROM calendar_events
        WHERE calendar_id = $1 AND COALESCE(dav_filename, uid || '.ics') = $2 AND recurrence_id = $3
          AND invite_account_id IS NULL AND etag = $4
        RETURNING id`,
      [input.calendar.id, input.filename, '', input.localRevision],
    );
    if (!deleted.rows.length) throw new DavProjectionGuardError();
    return etag;
  }

  const event = input.parsed;
  if (!event) throw new Error('A CalDAV PUT cannot be projected without a parsed event');
  const stored = await client.query<{ id: string; etag: string }>(
    `INSERT INTO calendar_events (calendar_id, user_id, uid, raw_ical, etag, summary, starts_at, ends_at, all_day, timezone, description, location, url, organizer, attendees, dav_filename)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16)
     ON CONFLICT (calendar_id, uid, recurrence_id) DO UPDATE SET
       raw_ical = EXCLUDED.raw_ical, etag = EXCLUDED.etag, summary = EXCLUDED.summary,
       starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at, all_day = EXCLUDED.all_day,
       timezone = EXCLUDED.timezone, description = EXCLUDED.description, location = EXCLUDED.location,
       url = EXCLUDED.url, organizer = EXCLUDED.organizer, attendees = EXCLUDED.attendees,
       dav_filename = EXCLUDED.dav_filename, updated_at = NOW()
     WHERE calendar_events.invite_account_id IS NULL
       AND COALESCE(calendar_events.dav_filename, calendar_events.uid || '.ics') = EXCLUDED.dav_filename
       AND calendar_events.etag = $17
     RETURNING id, etag`,
    [
      input.calendar.id, input.userId, event.uid, input.raw, etag,
      event.summary, event.startsAt, event.endsAt, event.allDay,
      event.timeZone, event.description, event.location, event.url,
      event.organizer, JSON.stringify(event.attendees), input.filename,
      input.localRevision,
    ],
  );
  if (!stored.rows.length) throw new DavProjectionGuardError();
  return stored.rows[0].etag;
}

/** Forward a CalDAV PUT (create or update) to the imported calendar's source. */
export async function putCaldavEvent(input: CaldavWriteBackInput): Promise<DavWriteBackRouteResult> {
  return executeDavWriteBack(specFor(input), caldavDeps(input));
}

/** Forward a CalDAV DELETE to the imported calendar's source. */
export async function deleteCaldavEvent(input: CaldavWriteBackInput): Promise<DavWriteBackRouteResult> {
  return executeDavWriteBack(specFor(input), caldavDeps(input));
}

function caldavDeps(input: CaldavWriteBackInput): DavWriteBackDeps {
  return {
    resolveRemote: (source, current) => resolveRemoteCaldavEvent(source, current.uid),
    remoteHrefForCreate: (source, current) => joinDavUrl(source.collectionUrl, current.filename),
    commit: (client, _spec, projection) => commitCaldavProjection(client, input, projection),
  };
}
