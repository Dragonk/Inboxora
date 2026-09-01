import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { authenticateDavCredential, query } = vi.hoisted(() => ({
  authenticateDavCredential: vi.fn(),
  query: vi.fn(async () => ({ rows: [] })),
}));
vi.mock('../services/davCredentials.js', () => ({ authenticateDavCredential }));
vi.mock('../services/db.js', () => ({ query }));
vi.mock('../services/authLimiter.js', () => ({ authLimiterConfig: { maxRequests: 10, windowMs: 60_000 } }));
vi.mock('../services/rateLimiter.js', () => ({ consume: vi.fn(async () => ({ limited: false })) }));
vi.mock('../services/authEvents.js', () => ({ logAuthEvent: vi.fn() }));

import express from 'express';
import caldavRouter, { parseCalendarEvent } from './caldav.js';

function basic(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use('/caldav', caldavRouter);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  authenticateDavCredential.mockReset();
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
});

describe('CalDAV discovery', () => {
  it('advertises calendar access after dedicated DAV app-password authentication', async () => {
    authenticateDavCredential.mockResolvedValue({ userId: 'user-1', credentialId: 'credential-1' });

    const response = await fetch(`${base}/caldav/`, {
      method: 'OPTIONS',
      headers: { authorization: basic('sam@example.test', 'test-dav-password') },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('dav')).toContain('calendar-access');
    expect(authenticateDavCredential).toHaveBeenCalledWith('sam@example.test', 'test-dav-password');
  });

  it('returns the authenticated user principal from root PROPFIND', async () => {
    authenticateDavCredential.mockResolvedValue({ userId: 'user-1', credentialId: 'credential-1' });

    const response = await fetch(`${base}/caldav/`, {
      method: 'PROPFIND',
      headers: { authorization: basic('sam@example.test', 'test-dav-password'), depth: '0' },
    });

    expect(response.status).toBe(207);
    expect(await response.text()).toContain('/caldav/user-1/');
  });

  it('exposes only the authenticated user calendar home', async () => {
    authenticateDavCredential.mockResolvedValue({ userId: 'user-1', credentialId: 'credential-1' });
    query.mockResolvedValueOnce({ rows: [{ id: 'calendar-1', name: 'Personal', sync_token: 'token-1' }] });

    const response = await fetch(`${base}/caldav/user-1/`, {
      method: 'PROPFIND',
      headers: { authorization: basic('sam@example.test', 'test-dav-password'), depth: '0' },
    });

    expect(response.status).toBe(207);
    expect(await response.text()).toContain('/caldav/user-1/calendar-1/');
    expect(query.mock.calls[0][0]).toContain('WHERE user_id = $1');
    expect(query.mock.calls[0][1]).toEqual(['user-1']);
  });

  it('lists only calendars owned by the DAV user', async () => {
    authenticateDavCredential.mockResolvedValue({ userId: 'user-1', credentialId: 'credential-1' });
    query.mockResolvedValueOnce({ rows: [{ id: 'calendar-1', name: 'Personal', sync_token: 'token-1' }] });

    const response = await fetch(`${base}/caldav/user-1/calendar-1/`, {
      method: 'PROPFIND',
      headers: { authorization: basic('sam@example.test', 'test-dav-password'), depth: '0' },
    });

    expect(response.status).toBe(207);
    expect(await response.text()).toContain('Personal');
    expect(query.mock.calls[0][0]).toContain('WHERE id = $1 AND user_id = $2');
    expect(query.mock.calls[0][1]).toEqual(['calendar-1', 'user-1']);
  });
});

describe('CalDAV calendar objects', () => {
  it('accepts case-insensitive iCalendar component markers and properties', () => {
    const event = parseCalendarEvent('begin:vcalendar\r\nbegin:vevent\r\nuid:case-insensitive\r\ndtstart:20260901T090000Z\r\ndtend:20260901T100000Z\r\nsummary:Planning\r\nend:vevent\r\nend:vcalendar\r\n');

    expect(event).toMatchObject({ uid: 'case-insensitive', summary: 'Planning' });
    expect(event.startsAt).toEqual(new Date('2026-09-01T09:00:00.000Z'));
  });

  it('creates a local event with an ETag and returns it through GET', async () => {
    authenticateDavCredential.mockResolvedValue({ userId: 'user-1', credentialId: 'credential-1' });
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ uid: 'event-1', etag: 'etag-1' }] })
      .mockResolvedValueOnce({ rows: [] });

    const put = await fetch(`${base}/caldav/user-1/calendar-1/event-1.ics`, {
      method: 'PUT',
      headers: {
        authorization: basic('sam@example.test', 'test-dav-password'),
        'content-type': 'text/calendar; charset=utf-8',
        'if-none-match': '*',
      },
      body: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:event-1\r\nDTSTART:20260901T090000Z\r\nDTEND:20260901T100000Z\r\nSUMMARY:Planning\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
    });

    expect(put.status).toBe(201);
    expect(put.headers.get('etag')).toBe('"etag-1"');
    expect(query.mock.calls[2][0]).toContain('INSERT INTO calendar_events');

    query.mockReset();
    query.mockResolvedValueOnce({ rows: [{ raw_ical: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', etag: 'etag-1' }] });
    const get = await fetch(`${base}/caldav/user-1/calendar-1/event-1.ics`, {
      headers: { authorization: basic('sam@example.test', 'test-dav-password') },
    });

    expect(get.status).toBe(200);
    expect(get.headers.get('etag')).toBe('"etag-1"');
    expect(await get.text()).toContain('BEGIN:VCALENDAR');
  });

  it('accepts folded properties and DATE all-day values', async () => {
    authenticateDavCredential.mockResolvedValue({ userId: 'user-1', credentialId: 'credential-1' });
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ uid: 'all-day', etag: 'etag-1' }] });

    const response = await fetch(`${base}/caldav/user-1/calendar-1/all-day.ics`, {
      method: 'PUT',
      headers: { authorization: basic('sam@example.test', 'test-dav-password') },
      body: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:all-day\r\nDTSTART;VALUE=DATE:20260901\r\nDTEND;VALUE=DATE:20260903\r\nSUMMARY:Planning for the \r\n autumn release\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
    });

    expect(response.status).toBe(201);
    expect(query.mock.calls[2][1]).toEqual(expect.arrayContaining([
      'calendar-1', 'user-1', 'all-day', expect.any(String), 'Planning for the autumn release',
      new Date('2026-09-01T00:00:00.000Z'), new Date('2026-09-03T00:00:00.000Z'), true,
    ]));
  });

  it('converts TZID events and supported durations to UTC', async () => {
    authenticateDavCredential.mockResolvedValue({ userId: 'user-1', credentialId: 'credential-1' });
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ uid: 'berlin-event', etag: 'etag-1' }] });

    const response = await fetch(`${base}/caldav/user-1/calendar-1/berlin-event.ics`, {
      method: 'PUT',
      headers: { authorization: basic('sam@example.test', 'test-dav-password') },
      body: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:berlin-event\r\nDTSTART;TZID=Europe/Berlin:20260901T090000\r\nDURATION:PT90M\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
    });

    expect(response.status).toBe(201);
    expect(query.mock.calls[2][1]).toEqual(expect.arrayContaining([
      new Date('2026-09-01T07:00:00.000Z'), new Date('2026-09-01T08:30:00.000Z'), false,
    ]));
  });

  it('rejects malformed end semantics and unsupported recurrence rules before storing', async () => {
    authenticateDavCredential.mockResolvedValue({ userId: 'user-1', credentialId: 'credential-1' });
    for (const body of [
      'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:both-end-values\r\nDTSTART:20260901T090000Z\r\nDTEND:20260901T100000Z\r\nDURATION:PT1H\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
      'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:recurring\r\nDTSTART:20260901T090000Z\r\nDTEND:20260901T100000Z\r\nRRULE:FREQ=DAILY\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
    ]) {
      query.mockReset();
      query.mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] });
      const response = await fetch(`${base}/caldav/user-1/calendar-1/${body.includes('recurring') ? 'recurring' : 'both-end-values'}.ics`, {
        method: 'PUT', headers: { authorization: basic('sam@example.test', 'test-dav-password') }, body,
      });
      expect(response.status).toBe(400);
      expect(query).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects an unknown sync token before enumerating calendar objects', async () => {
    authenticateDavCredential.mockResolvedValue({ userId: 'user-1', credentialId: 'credential-1' });
    query.mockResolvedValueOnce({ rows: [{ id: 'calendar-1', sync_token: 'current-token' }] });

    const response = await fetch(`${base}/caldav/user-1/calendar-1/`, {
      method: 'REPORT',
      headers: { authorization: basic('sam@example.test', 'test-dav-password'), 'content-type': 'application/xml' },
      body: '<D:sync-collection xmlns:D="DAV:"><D:sync-token>stale-token</D:sync-token></D:sync-collection>',
    });

    expect(response.status).toBe(409);
    expect(await response.text()).toContain('valid-sync-token');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('returns only changes since a sync token, including deletion tombstones', async () => {
    authenticateDavCredential.mockResolvedValue({ userId: 'user-1', credentialId: 'credential-1' });
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', sync_token: 'sync-3', sync_version: 3 }] })
      .mockResolvedValueOnce({ rows: [
        { uid: 'updated', recurrence_id: '', etag: 'etag-2', deleted: false, raw_ical: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n' },
        { uid: 'deleted', recurrence_id: '', etag: null, deleted: true, raw_ical: null },
      ] });

    const response = await fetch(`${base}/caldav/user-1/calendar-1/`, {
      method: 'REPORT',
      headers: { authorization: basic('sam@example.test', 'test-dav-password'), 'content-type': 'application/xml' },
      body: '<D:sync-collection xmlns:D="DAV:"><D:sync-token>sync-1</D:sync-token></D:sync-collection>',
    });

    const xml = await response.text();
    expect(response.status).toBe(207);
    expect(xml).toContain('/updated.ics');
    expect(xml).toContain('/deleted.ics');
    expect(xml).toContain('404 Not Found');
    expect(xml).toContain('<D:sync-token>sync-3</D:sync-token>');
    expect(query.mock.calls[1][0]).toContain('calendar_sync_changes');
    expect(query.mock.calls[1][1]).toEqual(['calendar-1', 1]);
  });

  it('returns only explicitly requested resources for calendar-multiget', async () => {
    authenticateDavCredential.mockResolvedValue({ userId: 'user-1', credentialId: 'credential-1' });
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', sync_token: 'sync-3', sync_version: 3 }] })
      .mockResolvedValueOnce({ rows: [{ uid: 'event-1', etag: 'etag-1', raw_ical: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n' }] });

    const response = await fetch(`${base}/caldav/user-1/calendar-1/`, {
      method: 'REPORT',
      headers: { authorization: basic('sam@example.test', 'test-dav-password'), 'content-type': 'application/xml' },
      body: '<C:calendar-multiget xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:D="DAV:"><D:href>/caldav/user-1/calendar-1/event%201.ics</D:href></C:calendar-multiget>',
    });

    expect(response.status).toBe(207);
    expect(query.mock.calls[1][0]).toContain('uid = ANY($3)');
    expect(query.mock.calls[1][1]).toEqual(['calendar-1', '', ['event 1']]);
  });

  it('filters calendar-query results to the requested time range', async () => {
    authenticateDavCredential.mockResolvedValue({ userId: 'user-1', credentialId: 'credential-1' });
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', sync_token: 'sync-3', sync_version: 3 }] })
      .mockResolvedValueOnce({ rows: [{ uid: 'event-1', etag: 'etag-1', raw_ical: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n' }] });

    const response = await fetch(`${base}/caldav/user-1/calendar-1/`, {
      method: 'REPORT',
      headers: { authorization: basic('sam@example.test', 'test-dav-password'), 'content-type': 'application/xml' },
      body: '<C:calendar-query xmlns:C="urn:ietf:params:xml:ns:caldav"><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:time-range start="20260901T000000Z" end="20260902T000000Z"/></C:comp-filter></C:comp-filter></C:filter></C:calendar-query>',
    });

    expect(response.status).toBe(207);
    expect(query.mock.calls[1][0]).toContain('starts_at < $4 AND ends_at > $3');
    expect(query.mock.calls[1][1]).toEqual(['calendar-1', '', new Date('2026-09-01T00:00:00Z'), new Date('2026-09-02T00:00:00Z')]);
  });

  it('rejects a stale conditional update without mutating the event', async () => {
    authenticateDavCredential.mockResolvedValue({ userId: 'user-1', credentialId: 'credential-1' });
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [{ etag: 'current-etag' }] });

    const response = await fetch(`${base}/caldav/user-1/calendar-1/event-1.ics`, {
      method: 'PUT',
      headers: { authorization: basic('sam@example.test', 'test-dav-password'), 'if-match': '"stale-etag"' },
      body: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:event-1\r\nDTSTART:20260901T090000Z\r\nDTEND:20260901T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
    });

    expect(response.status).toBe(412);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('rejects CalDAV mutation of an event whose invitation lifecycle is managed by Inboxora', async () => {
    authenticateDavCredential.mockResolvedValue({ userId: 'user-1', credentialId: 'credential-1' });
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [{ etag: 'current-etag', invite_account_id: 'account-1' }] });

    const response = await fetch(`${base}/caldav/user-1/calendar-1/event-1.ics`, {
      method: 'PUT', headers: { authorization: basic('sam@example.test', 'test-dav-password') },
      body: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:event-1\r\nDTSTART:20260901T090000Z\r\nDTEND:20260901T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
    });

    expect(response.status).toBe(409);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('rejects CalDAV deletion of an event whose invitation lifecycle is managed by Inboxora', async () => {
    authenticateDavCredential.mockResolvedValue({ userId: 'user-1', credentialId: 'credential-1' });
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [{ etag: 'current-etag', invite_account_id: 'account-1' }] });

    const response = await fetch(`${base}/caldav/user-1/calendar-1/event-1.ics`, {
      method: 'DELETE', headers: { authorization: basic('sam@example.test', 'test-dav-password') },
    });

    expect(response.status).toBe(409);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('keeps the CalDAV write guarded when an invitation is enabled after its initial read', async () => {
    authenticateDavCredential.mockResolvedValue({ userId: 'user-1', credentialId: 'credential-1' });
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [{ etag: 'current-etag', invite_account_id: null }] })
      // A concurrent Inboxora update enabled invitations before the UPSERT locked the row.
      .mockResolvedValueOnce({ rows: [] });

    const response = await fetch(`${base}/caldav/user-1/calendar-1/event-1.ics`, {
      method: 'PUT', headers: { authorization: basic('sam@example.test', 'test-dav-password') },
      body: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:event-1\r\nDTSTART:20260901T090000Z\r\nDTEND:20260901T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
    });

    expect(response.status).toBe(409);
    expect(query.mock.calls[2][0]).toContain('WHERE calendar_events.invite_account_id IS NULL');
  });

  it('keeps the CalDAV deletion guarded when an invitation is enabled after its initial read', async () => {
    authenticateDavCredential.mockResolvedValue({ userId: 'user-1', credentialId: 'credential-1' });
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [{ etag: 'current-etag', invite_account_id: null }] })
      // A concurrent Inboxora update enabled invitations before DELETE locked the row.
      .mockResolvedValueOnce({ rows: [] });

    const response = await fetch(`${base}/caldav/user-1/calendar-1/event-1.ics`, {
      method: 'DELETE', headers: { authorization: basic('sam@example.test', 'test-dav-password') },
    });

    expect(response.status).toBe(409);
    expect(query.mock.calls[2][0]).toContain('AND invite_account_id IS NULL');
  });
});
