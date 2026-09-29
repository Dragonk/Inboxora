import { outlookCalendar } from '../test/fixtures/outlookCalendar.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { DbQueryResult, DbRow } from './db.js';
import type { SafeFetchOptions } from './safeFetch.js';
import type * as ConnectionPolicyModule from './connectionPolicy.js';

type QueryMock = (text: string, params?: unknown[]) => Promise<DbQueryResult<DbRow>>;
type SafeFetchMock = (url: string, options: RequestInit, policy: SafeFetchOptions) => Promise<Response>;
type ConnectionPolicyMock = () => ReturnType<typeof ConnectionPolicyModule.getConnectionPolicy>;

const { query, safeFetch, getConnectionPolicy, captureDavSourceFence, withDavSourceProjection, isDavCollectionBlocked, retireDavCalendarSource, inspectDavCollection, discoverDavWriteAccess } = vi.hoisted(() => ({
  query: vi.fn<QueryMock>(),
  captureDavSourceFence: vi.fn(),
  withDavSourceProjection: vi.fn(),
  isDavCollectionBlocked: vi.fn(),
  retireDavCalendarSource: vi.fn(),
  inspectDavCollection: vi.fn(),
  discoverDavWriteAccess: vi.fn(),
  safeFetch: vi.fn<SafeFetchMock>(),
  getConnectionPolicy: vi.fn<ConnectionPolicyMock>(),
}));

function successfulResponse(body: string): Response {
  return new Response(body, { status: 200 });
}

function queryCallContaining(fragment: string): [string, unknown[]] {
  const call = query.mock.calls.find(([sql]) => sql.includes(fragment));
  expect(call).toBeDefined();
  if (!call) throw new Error(`Expected a query containing "${fragment}"`);
  const [sql, params] = call;
  expect(params).toBeDefined();
  if (!params) throw new Error(`Expected parameters for query containing "${fragment}"`);
  return [sql, params];
}

function lastQueryCall(): [string, unknown[]] {
  const call = query.mock.calls.at(-1);
  expect(call).toBeDefined();
  if (!call) throw new Error('Expected at least one query');
  const [sql, params] = call;
  expect(params).toBeDefined();
  if (!params) throw new Error('Expected parameters for last query');
  return [sql, params];
}
vi.mock('./db.js', () => ({ query }));
vi.mock('./davCollectionLifecycle.js', () => ({ captureDavSourceFence, withDavSourceProjection, isDavCollectionBlocked, retireDavCalendarSource }));
vi.mock('./davCollectionClient.js', async importOriginal => ({ ...await importOriginal<typeof import('./davCollectionClient.js')>(), inspectDavCollection, davCollectionRequest: (input: { url: string; allowPrivate?: boolean }, options: RequestInit) => safeFetch(input.url, options, { allowPrivate: input.allowPrivate }) }));
vi.mock('./carddavClient.js', () => ({ discoverDavWriteAccess }));
vi.mock('./safeFetch.js', () => ({ safeFetch }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy }));
vi.mock('./encryption.js', () => ({ decrypt: (value: string) => value.startsWith('enc:v1:') ? value.slice('enc:v1:'.length) : value, encrypt: (value: string) => `enc:v1:${value}` }));

import { stopCalendarSource, syncCalendarSource } from './externalCalendarSync.js';

const source = {
  id: 'source-1', user_id: 'user-1', kind: 'ical_url', url: 'enc:v1:https://calendar.example/events.ics',
  display_name: 'Holiday calendar', color: null, interval_min: 60, enabled: true,
};
const ical = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:event-1\r\nDTSTART:20260901T090000Z\r\nDTEND:20260901T100000Z\r\nSUMMARY:Planning\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';

function configureQuery(currentSource = source, existingCalendar: string | null = null): void {
  query.mockImplementation(async sql => {
    if (sql.includes('FROM calendar_import_sources')) return { rows: [currentSource] };
    if (sql.includes('FROM calendars')) return { rows: existingCalendar ? [{ id: existingCalendar }] : [] };
    if (sql.includes('INSERT INTO calendars')) return { rows: [{ id: 'calendar-1' }] };
    if (sql.includes('INSERT INTO source_connections')) return { rows: [{ id: 'source-conn-1' }] };
    if (sql.includes('INSERT INTO integration_collections')) return { rows: [{ id: 'collection-1' }] };
    return { rows: [] };
  });
}

beforeEach(() => {
  captureDavSourceFence.mockReset().mockResolvedValue('generation-1');
  withDavSourceProjection.mockReset().mockImplementation(async (_userId: string, _kind: string, _sourceId: string, _generation: string, callback: (client: { query: QueryMock }) => Promise<unknown>) => callback({ query }));
  isDavCollectionBlocked.mockReset().mockResolvedValue(false);
  retireDavCalendarSource.mockReset().mockResolvedValue(undefined);
  inspectDavCollection.mockReset().mockResolvedValue('present');
  discoverDavWriteAccess.mockReset().mockResolvedValue('read_only');
});

describe('external calendar imports', () => {
  beforeEach(() => {
    query.mockReset(); safeFetch.mockReset(); getConnectionPolicy.mockReset();
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: false, allowInsecureTls: false, allowNonstandardPorts: false });
  });

  it('pulls an ICS source into a read-only calendar and removes stale imported events', async () => {
    configureQuery();
    safeFetch.mockResolvedValue(successfulResponse(ical));

    const result = await syncCalendarSource('user-1', 'source-1');

    expect(result).toEqual({ ok: true, eventCount: 1 });
    expect(safeFetch).toHaveBeenCalledWith('https://calendar.example/events.ics', expect.objectContaining({ headers: { Accept: 'text/calendar' } }), { allowPrivate: false });
    expect(query.mock.calls[2][1]).toEqual(['user-1', 'Holiday calendar', null, 'ical_url', 'source:source-1']);
    const eventInsert = queryCallContaining('INSERT INTO calendar_events');
    const staleDelete = queryCallContaining('DELETE FROM calendar_events');
    expect(eventInsert[1]).toContain('event-1');
    expect(staleDelete[1]).toEqual(['calendar-1', ['event-1']]);
  });

  it('links the external collection to its source connection so write-back has something to enable', async () => {
    // P02/P10: without this link the per-collection write-back switch has no collection id and the client
    // is never offered it, which made the external DAV write-back unreachable for real collections.
    query.mockImplementation(async (sql: unknown) => {
      const text = String(sql);
      if (text.includes('FROM calendar_import_sources')) return { rows: [source] };
      if (text.includes('FROM calendars')) return { rows: [{ id: 'calendar-1' }] };
      if (text.includes('INSERT INTO source_connections')) return { rows: [{ id: 'source-conn-1' }] };
      if (text.includes('INSERT INTO integration_collections')) return { rows: [{ id: 'collection-1' }] };
      return { rows: [] };
    });
    safeFetch.mockResolvedValue(successfulResponse(ical));

    const result = await syncCalendarSource('user-1', 'source-1');
    expect(result.ok).toBe(true);
    const link = query.mock.calls.find(call => String(call[0]).includes('INSERT INTO integration_collections'));
    expect(link).toBeDefined();
    // The link names the local calendar, the source's own remote id, and the source's own permission: an
    // ICS subscription is read-only at the source, so the switch can be offered but a write stays refused.
    expect(link?.[1]).toEqual([
      'user-1', 'source-conn-1', 'calendar', 'source:source-1', 'calendar-1', null, 'read_only',
    ]);
    // The CalDAV/CardDAV kind maps to `read_write` at the source; that mapping and the link's shape for a
    // writable source are pinned in `providers/externalCollectionLinks.test.ts`, which drives the helper
    // directly rather than a second DAV multistatus fixture here.
  });

  it('synchronizes Exchange timezone events without replacing calendar appearance', async () => {
    configureQuery(source, 'calendar-work');
    safeFetch.mockResolvedValue(successfulResponse(outlookCalendar()));
    expect(await syncCalendarSource('user-1', 'source-1')).toEqual({ ok: true, eventCount: 1 });
    const inserted = queryCallContaining('INSERT INTO calendar_events');
    const startsAt = inserted[1][6];
    expect(startsAt).toBeInstanceOf(Date);
    if (!(startsAt instanceof Date)) throw new Error('Expected an event start date');
    expect(startsAt.toISOString()).toBe('2026-09-10T07:00:00.000Z');
    expect(query.mock.calls.some(([sql]) => /UPDATE calendars|INSERT INTO calendars/.test(sql))).toBe(false);
  });
  it('imports a recurring VEVENT without discarding its VCALENDAR context or non-event siblings', async () => {
    const richIcal = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTIMEZONE\r\nTZID:Europe/Berlin\r\nEND:VTIMEZONE\r\nBEGIN:VEVENT\r\nUID:weekly-planning\r\nDTSTART;TZID=Europe/Berlin:20260901T090000\r\nDURATION:PT1H\r\nRRULE:FREQ=WEEKLY;COUNT=4\r\nATTENDEE;CN=Sam:mailto:sam@example.test\r\nATTENDEE;CN=Taylor:mailto:taylor@example.test\r\nX-INBOXORA-EXAMPLE:kept\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT15M\r\nDESCRIPTION:Reminder\r\nEND:VALARM\r\nEND:VEVENT\r\nBEGIN:VTODO\r\nUID:todo-1\r\nSUMMARY:Not an event projection\r\nEND:VTODO\r\nBEGIN:VJOURNAL\r\nUID:journal-1\r\nEND:VJOURNAL\r\nBEGIN:VFREEBUSY\r\nUID:freebusy-1\r\nEND:VFREEBUSY\r\nEND:VCALENDAR\r\n';
    configureQuery();
    safeFetch.mockResolvedValue(successfulResponse(richIcal));

    const result = await syncCalendarSource('user-1', 'source-1');

    expect(result).toEqual({ ok: true, eventCount: 1 });
    const eventInsert = queryCallContaining('INSERT INTO calendar_events');
    const storedRaw = eventInsert[1][3];
    expect(storedRaw).toContain('BEGIN:VTIMEZONE');
    expect(storedRaw).toContain('RRULE:FREQ=WEEKLY;COUNT=4');
    expect(storedRaw).toContain('ATTENDEE;CN=Sam:mailto:sam@example.test');
    expect(storedRaw).toContain('BEGIN:VALARM');
    expect(storedRaw).toContain('X-INBOXORA-EXAMPLE:kept');
    expect(storedRaw).not.toContain('BEGIN:VTODO');
    const storedDocument = queryCallContaining('calendar_import_documents');
    expect(storedDocument[1]).toEqual(['source-1', richIcal]);
    expect(lastQueryCall()[0]).toContain('last_error = NULL');
    expect(lastQueryCall()[1]).toEqual(['source-1', 'user-1']);
  });

  it('imports a valid legacy ICS feed that uses bare CR line endings', async () => {
    const crOnly = 'BEGIN:VCALENDAR\rVERSION:2.0\rBEGIN:VEVENT\rUID:cr-only\rDTSTART:20260901T090000Z\rDTEND:20260901T100000Z\rEND:VEVENT\rEND:VCALENDAR\r';
    configureQuery();
    safeFetch.mockResolvedValue(successfulResponse(crOnly));

    const result = await syncCalendarSource('user-1', 'source-1');

    expect(result).toEqual({ ok: true, eventCount: 1 });
    const eventInsert = queryCallContaining('INSERT INTO calendar_events');
    expect(eventInsert[1][3]).toContain('UID:cr-only\r');
  });

  it('imports an all-day DATE event without DTEND as a one-day event', async () => {
    const fixture = await readFile(new URL('./fixtures/remote-calendar-all-day-no-end.ics', import.meta.url), 'utf8');
    configureQuery();
    safeFetch.mockResolvedValue(successfulResponse(fixture));
    const result = await syncCalendarSource('user-1', 'source-1');
    expect(result).toEqual({ ok: true, eventCount: 1 });
    const eventInsert = queryCallContaining('INSERT INTO calendar_events');
    expect(eventInsert[1]).toEqual(expect.arrayContaining(['all-day-no-end', true, new Date('2026-09-01T00:00:00.000Z'), new Date('2026-09-02T00:00:00.000Z')]));
  });

  it('keeps the prior projection when a non-empty ICS response has no supported events', async () => {
    query.mockResolvedValueOnce({ rows: [source] }).mockResolvedValueOnce({ rows: [] });
    safeFetch.mockResolvedValue(successfulResponse('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:broken\r\nEND:VEVENT\r\nEND:VCALENDAR'));

    const result = await syncCalendarSource('user-1', 'source-1');

    expect(result).toEqual({ ok: false, error: 'Remote calendar contains an unsupported event' });
    expect(query.mock.calls.some(([sql]) => sql.includes('DELETE FROM calendar_events'))).toBe(false);
  });

  it('keeps the prior projection when an ICS source returns an empty body', async () => {
    query.mockResolvedValueOnce({ rows: [source] }).mockImplementation(async (sql: string) => (
      sql.includes('INSERT INTO calendars') ? { rows: [{ id: 'calendar-1' }] } : { rows: [] }
    ));
    safeFetch.mockResolvedValue(successfulResponse('   \r\n\t'));

    const result = await syncCalendarSource('user-1', 'source-1');

    expect(result).toEqual({ ok: false, error: 'Remote calendar did not contain any VEVENT components' });
    expect(query.mock.calls.some(([sql]) => sql.includes('DELETE FROM calendar_events'))).toBe(false);
  });

  it('imports valid events while retaining skipped UIDs and reporting a warning', async () => {
    const mixedIcal = [ical, 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:broken-event\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'].join('');
    configureQuery();
    safeFetch.mockResolvedValue(successfulResponse(mixedIcal));
    const result = await syncCalendarSource('user-1', 'source-1');
    expect(result).toEqual({ ok: true, eventCount: 1, skipped: [{ uid: 'broken-event', reason: 'unsupported or malformed VEVENT' }] });
    const staleDelete = queryCallContaining('DELETE FROM calendar_events');
    expect(staleDelete[1]).toEqual(['calendar-1', ['event-1', 'broken-event']]);
    const warning = lastQueryCall()[1][1];
    expect(typeof warning).toBe('string');
    if (typeof warning !== 'string') throw new Error('Expected a serialized warning');
    expect(JSON.parse(warning)).toEqual({ code: 'unsupported_events', count: 1, samples: [{ uid: 'broken-event', reason: 'unsupported or malformed VEVENT' }] });
  });

  it('records a source-specific failure instead of throwing and does not import partial data', async () => {
    query.mockResolvedValueOnce({ rows: [source] }).mockResolvedValueOnce({ rows: [] });
    safeFetch.mockRejectedValue(new Error(`request failed for ${'https://calendar.example/events.ics'} (${source.url})`));

    const result = await syncCalendarSource('user-1', 'source-1');

    expect(result).toEqual({ ok: false, error: 'request failed for [redacted] ([redacted])' });
    expect(query.mock.calls[1][0]).toContain('last_error');
    expect(query.mock.calls[1][1]).toEqual(['source-1', 'request failed for [redacted] ([redacted])', 'user-1']);
  });

  it('does not retain a removal tombstone for a nonexistent source', async () => {
    await stopCalendarSource('missing-source');
    const replacement = { ...source, id: 'missing-source' };
    configureQuery(replacement);
    safeFetch.mockResolvedValue(successfulResponse(ical));

    await expect(syncCalendarSource('user-1', replacement.id)).resolves.toEqual({ ok: true, eventCount: 1 });
  });


it('persists the full visible metadata on external synchronization', async () => {
  configureQuery(source, 'calendar-work');
  safeFetch.mockResolvedValue(successfulResponse(outlookCalendar('09', 'DESCRIPTION:Agenda\r\nLOCATION:Office\r\nURL:https://example.test/join\r\nORGANIZER:mailto:team@example.test\r\nATTENDEE:mailto:jane@example.test\r\n')));
  expect((await syncCalendarSource('user-1', 'source-1')).ok).toBe(true);
  const insert = queryCallContaining('INSERT INTO calendar_events');
  expect(insert[1].slice(-5)).toEqual(['Agenda', 'Office', 'https://example.test/join', 'team@example.test', '["jane@example.test"]']);
  expect(insert[0]).toContain('description = EXCLUDED.description');
});

  it('aborts an in-flight fetch when the source is stopped without persisting removal as an error', async () => {
    query.mockResolvedValueOnce({ rows: [source] }).mockResolvedValue({ rows: [] });
    safeFetch.mockImplementation((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const { signal } = options;
      if (!(signal instanceof AbortSignal)) {
        reject(new Error('Expected an AbortSignal'));
        return;
      }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));

    const sync = syncCalendarSource('user-1', 'source-1');
    await new Promise((resolve) => setImmediate(resolve));
    await expect(Promise.race([
      stopCalendarSource('source-1'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('stop timed out')), 100)),
    ])).resolves.toBeUndefined();

    await expect(sync).resolves.toEqual({ ok: false, error: 'Calendar source removed' });
    expect(query.mock.calls.slice(2).some(([sql]) => /INSERT|UPDATE|DELETE/i.test(sql))).toBe(false);
  });
});

it.each(['ical_url', 'caldav'])('removes the previous projection for a validated empty %s collection', async kind => {
  const credentials = kind === 'caldav' ? { username: 'calendar-user', password: 'enc:v1:calendar-password' } : {};
  query.mockReset(); configureQuery({ ...source, ...credentials, id: `empty-${kind}`, kind }, 'calendar-1');
  getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: false, allowInsecureTls: false, allowNonstandardPorts: false });
  safeFetch.mockImplementation(async () => kind === 'caldav' ? new Response('<D:multistatus xmlns:D="DAV:"/>', { status: 207 }) : successfulResponse('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n'));
  expect(await syncCalendarSource('user-1', `empty-${kind}`)).toEqual({ ok: true, eventCount: 0 });
  expect(queryCallContaining('DELETE FROM calendar_events')[1]).toEqual(['calendar-1', ['']]);
});

it('does not treat an HTML error page as an empty calendar', async () => {
  query.mockReset(); query.mockResolvedValue({ rows: [] }).mockResolvedValueOnce({ rows: [{ ...source, id: 'html-source' }] });
  getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: false, allowInsecureTls: false, allowNonstandardPorts: false });
  safeFetch.mockResolvedValue(successfulResponse('<html>Service unavailable</html>'));
  expect(await syncCalendarSource('user-1', 'html-source')).toMatchObject({ ok: false });
  expect(query.mock.calls.some(([sql]) => sql.includes('DELETE FROM calendar_events'))).toBe(false);
});

describe('CalDAV collection lifecycle', () => {
  const davSource = { ...source, id: 'dav-source', kind: 'caldav', username: 'synthetic', password: 'enc:v1:synthetic-password' };
  beforeEach(() => {
    query.mockReset(); safeFetch.mockReset();
    configureQuery(davSource, 'calendar-1');
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: false, allowInsecureTls: false, allowNonstandardPorts: false });
  });

  it.each([404, 410])('retires only verified missing collections after REPORT %s', async status => {
    safeFetch.mockResolvedValue(new Response(null, { status }));
    inspectDavCollection.mockResolvedValue('missing');
    expect(await syncCalendarSource('user-1', 'dav-source')).toEqual({ ok: true, removed: true, eventCount: 0 });
    expect(retireDavCalendarSource).toHaveBeenCalledWith('user-1', 'dav-source', 'generation-1');
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO calendar'))).toBe(false);
  });

  it.each(['present', 'unknown'])('preserves local data when missing REPORT readback is %s', async presence => {
    safeFetch.mockResolvedValue(new Response(null, { status: 404 }));
    inspectDavCollection.mockResolvedValue(presence);
    expect((await syncCalendarSource('user-1', 'dav-source')).ok).toBe(false);
    expect(retireDavCalendarSource).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => sql.includes('DELETE FROM'))).toBe(false);
  });

  it.each([200, 202, 401, 403, 500])('preserves collections on HTTP %s', async status => {
    safeFetch.mockResolvedValue(new Response(null, { status }));
    expect((await syncCalendarSource('user-1', 'dav-source')).ok).toBe(false);
    expect(inspectDavCollection).not.toHaveBeenCalled();
    expect(retireDavCalendarSource).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => sql.includes('DELETE FROM'))).toBe(false);
  });

  it.each(['HTTP/1.1 401 Unauthorized', 'HTTP/1.1 403 Forbidden', 'HTTP/1.1 404 Not Found', 'HTTP/1.1 429 Too Many Requests', ''])('rejects incomplete resource status %s without replacing events', async status => {
    safeFetch.mockResolvedValue(new Response(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/events.ics/event.ics</d:href><d:propstat><d:prop><c:calendar-data>${ical}</c:calendar-data></d:prop>${status ? `<d:status>${status}</d:status>` : ''}</d:propstat></d:response></d:multistatus>`, { status: 207 }));
    expect((await syncCalendarSource('user-1', 'dav-source')).ok).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.includes('DELETE FROM') || sql.includes('INSERT INTO calendar_events'))).toBe(false);
  });

  it('rejects a successful resource response with absent calendar-data', async () => {
    safeFetch.mockResolvedValue(new Response('<d:multistatus xmlns:d="DAV:"><d:response><d:href>/events.ics/event.ics</d:href><d:propstat><d:prop><d:getetag>etag</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>', { status: 207 }));
    expect((await syncCalendarSource('user-1', 'dav-source')).ok).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.includes('DELETE FROM'))).toBe(false);
  });

  it('imports a complete calendar resource with unknown write privileges as read-only', async () => {
    discoverDavWriteAccess.mockResolvedValue(null);
    safeFetch.mockResolvedValue(new Response(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/events.ics/event.ics</d:href><d:propstat><d:prop><c:calendar-data>${ical}</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`, { status: 207 }));
    expect(await syncCalendarSource('user-1', 'dav-source')).toEqual({ ok: true, eventCount: 1 });
    expect(queryCallContaining('INSERT INTO integration_collections')[1].at(-1)).toBe('read_only');
  });

  it.each(['https://other.example/events.ics/event.ics', '/another-home/event.ics'])('rejects calendar resources outside their source: %s', async href => {
    safeFetch.mockResolvedValue(new Response(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>${href}</d:href><d:propstat><d:prop><c:calendar-data>${ical}</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`, { status: 207 }));
    expect((await syncCalendarSource('user-1', 'dav-source')).ok).toBe(false);
    expect(query.mock.calls.some(([sql]) => /INSERT|DELETE/.test(sql))).toBe(false);
  });

  it('does not fetch or write stale scheduled configuration after source retirement', async () => {
    safeFetch.mockResolvedValue(new Response(null, { status: 404 }));
    inspectDavCollection.mockResolvedValue('missing');
    expect(await syncCalendarSource('user-1', 'dav-source')).toEqual({ ok: true, removed: true, eventCount: 0 });
    query.mockClear(); safeFetch.mockClear();
    captureDavSourceFence.mockRejectedValue(new Error('DAV source was removed or disabled'));
    expect(await syncCalendarSource('user-1', 'dav-source')).toEqual({ ok: false, error: 'DAV source was removed or disabled' });
    expect(safeFetch).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('refuses projection after its source generation has changed', async () => {
    safeFetch.mockResolvedValue(new Response('<d:multistatus xmlns:d="DAV:"/>', { status: 207 }));
    withDavSourceProjection.mockRejectedValue(new Error('DAV source generation changed'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(await syncCalendarSource('user-1', 'dav-source')).toEqual({ ok: false, error: 'DAV source generation changed' });
      expect(query.mock.calls.some(([sql]) => /INSERT|UPDATE|DELETE/.test(sql))).toBe(false);
    } finally { warning.mockRestore(); }
  });

  it('refuses to recreate a collection with a pending deletion journal', async () => {
    safeFetch.mockResolvedValue(new Response('<d:multistatus xmlns:d="DAV:"/>', { status: 207 }));
    isDavCollectionBlocked.mockResolvedValue(true);
    expect(await syncCalendarSource('user-1', 'dav-source')).toEqual({ ok: false, error: 'Calendar collection deletion is pending' });
    expect(query.mock.calls.some(([sql]) => /INSERT|DELETE/.test(sql))).toBe(false);
  });
});
