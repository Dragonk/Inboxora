import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { listeningPort } from '../test/net.js';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

// The ceiling the authenticating device password imposes; read_write by default.
const credential = { maxDavMode: 'read_write' as 'read_only' | 'read_write' };

vi.mock('../services/db.js', () => ({ query }));
vi.mock('../services/authLimiter.js', () => ({ authLimiterConfig: { maxRequests: 500, windowMs: 60_000 } }));
vi.mock('../services/rateLimiter.js', () => ({ consume: vi.fn(async () => ({ limited: false })) }));
vi.mock('../services/authEvents.js', () => ({ logAuthEvent: vi.fn() }));
vi.mock('../services/davServerAuth.js', () => ({
  createDavAuthMiddleware: () => (req: { davUserId?: string; davCredentialId?: string; davMaxMode?: 'read_only' | 'read_write' }, _res: unknown, next: () => void) => {
    req.davUserId = 'user-1';
    req.davCredentialId = 'credential-1';
    req.davMaxMode = credential.maxDavMode;
    next();
  },
}));

import caldavRouter from './caldav.js';
import carddavRouter from './carddav.js';

const AUTH = { authorization: `Basic ${Buffer.from('sam@example.test:secret').toString('base64')}` };

let server: Server;
let base = '';

function queryCallsMatching(fragment: string): unknown[][] {
  return query.mock.calls.filter(([sql]) => String(sql).includes(fragment));
}

beforeAll(async () => {
  const app = express();
  app.use('/caldav', caldavRouter);
  app.use('/carddav', carddavRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  base = `http://127.0.0.1:${listeningPort(server)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  credential.maxDavMode = 'read_write';
  query.mockReset();
  query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('CalDAV collection visibility (dav_mode)', () => {
  it('never lists a disabled calendar in discovery, even on Depth: 1', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'cal-on', name: 'On', sync_token: 'sync-1', dav_mode: 'read_write' }] });
    const response = await fetch(`${base}/caldav/user-1/`, { method: 'PROPFIND', headers: { ...AUTH, depth: '1' } });
    expect(response.status).toBe(207);
    // Off collections are filtered in SQL, so they cannot leak through the listing.
    const homeQuery = queryCallsMatching('FROM calendars WHERE user_id')[0];
    expect(String(homeQuery?.[0])).toContain("dav_mode <> 'off'");
    expect(await response.text()).not.toContain('cal-off');
  });

  it('reports a disabled calendar as missing for PROPFIND, REPORT and GET', async () => {
    // The collection lookups return the off row (the route must reject it), while the
    // resource read returns nothing because the SQL itself excludes the collection.
    query.mockImplementation(async (sql: string) => (
      String(sql).includes('JOIN calendars c')
        ? { rows: [], rowCount: 0 }
        : { rows: [{ id: 'cal-off', name: 'Off', sync_token: 'sync-1', read_only: false, source: 'local', dav_mode: 'off' }], rowCount: 1 }
    ));
    expect((await fetch(`${base}/caldav/user-1/cal-off/`, { method: 'PROPFIND', headers: { ...AUTH, depth: '0' } })).status).toBe(404);
    expect((await fetch(`${base}/caldav/user-1/cal-off/`, {
      method: 'REPORT', headers: { ...AUTH, 'content-type': 'application/xml' },
      body: '<D:calendar-query xmlns:D="DAV:"/>',
    })).status).toBe(404);
    // The single-resource read filters the collection in SQL.
    expect((await fetch(`${base}/caldav/user-1/cal-off/event.ics`, { headers: AUTH })).status).toBe(404);
    expect(String(queryCallsMatching('JOIN calendars c')[0]?.[0])).toContain("c.dav_mode <> 'off'");
  });

  it('allows reads but refuses writes for a read-only DAV mode', async () => {
    query.mockResolvedValue({ rows: [{ id: 'cal-ro', name: 'Read only', sync_token: 'sync-1', read_only: false, source: 'local', dav_mode: 'read_only' }] });
    const propfind = await fetch(`${base}/caldav/user-1/cal-ro/`, { method: 'PROPFIND', headers: { ...AUTH, depth: '0' } });
    expect(propfind.status).toBe(207);
    expect(await propfind.text()).not.toContain('<D:write');

    expect((await fetch(`${base}/caldav/user-1/cal-ro/event.ics`, {
      method: 'PUT', headers: { ...AUTH, 'content-type': 'text/calendar' },
      body: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:e1\r\nDTSTART:20260901T090000Z\r\nDTEND:20260901T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
    })).status).toBe(403);
    expect((await fetch(`${base}/caldav/user-1/cal-ro/event.ics`, { method: 'DELETE', headers: AUTH })).status).toBe(403);
  });

  it('reports a disabled calendar as missing for a write', async () => {
    query.mockResolvedValue({ rows: [{ id: 'cal-off', name: 'Off', read_only: false, source: 'local', dav_mode: 'off' }] });
    const response = await fetch(`${base}/caldav/user-1/cal-off/event.ics`, {
      method: 'PUT', headers: { ...AUTH, 'content-type': 'text/calendar' },
      body: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:e1\r\nDTSTART:20260901T090000Z\r\nDTEND:20260901T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
    });
    expect(response.status).toBe(404);
    expect(queryCallsMatching('INSERT INTO calendar_events')).toHaveLength(0);
  });

  it('keeps a local read-write calendar writable', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'cal-rw', source: 'local', read_only: false, dav_mode: 'read_write' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ uid: 'e1', etag: 'etag-1' }] });
    const response = await fetch(`${base}/caldav/user-1/cal-rw/event.ics`, {
      method: 'PUT', headers: { ...AUTH, 'content-type': 'text/calendar' },
      body: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:e1\r\nDTSTART:20260901T090000Z\r\nDTEND:20260901T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
    });
    expect(response.status).toBe(201);
  });
});

describe('CardDAV collection visibility (dav_mode)', () => {
  it('never lists a disabled address book in discovery', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'book-on', name: 'On', sync_token: 'sync-1', sync_version: 1, source: 'local', dav_mode: 'read_write' }] });
    const response = await fetch(`${base}/carddav/user-1/`, { method: 'PROPFIND', headers: { ...AUTH, depth: '1' } });
    expect(response.status).toBe(207);
    expect(String(queryCallsMatching('FROM address_books WHERE user_id')[0]?.[0])).toContain("dav_mode <> 'off'");
    expect(await response.text()).not.toContain('book-off');
  });

  it('reports a disabled address book as missing for PROPFIND, REPORT and GET', async () => {
    query.mockImplementation(async (sql: string) => (
      String(sql).includes('JOIN address_books ab')
        ? { rows: [], rowCount: 0 }
        : { rows: [{ id: 'book-off', name: 'Off', sync_token: 'sync-1', sync_version: 1, source: 'local', dav_mode: 'off' }], rowCount: 1 }
    ));
    expect((await fetch(`${base}/carddav/user-1/book-off/`, { method: 'PROPFIND', headers: { ...AUTH, depth: '0' } })).status).toBe(404);
    expect((await fetch(`${base}/carddav/user-1/book-off/`, {
      method: 'REPORT', headers: { ...AUTH, 'content-type': 'application/xml' },
      body: '<D:addressbook-query xmlns:D="DAV:"/>',
    })).status).toBe(404);
    expect((await fetch(`${base}/carddav/user-1/book-off/contact.vcf`, { headers: AUTH })).status).toBe(404);
    expect(String(queryCallsMatching('JOIN address_books ab')[0]?.[0])).toContain("ab.dav_mode <> 'off'");
  });

  it('refuses writes for a read-only DAV mode but keeps reads', async () => {
    query.mockResolvedValue({ rows: [{ id: 'book-ro', name: 'Read only', sync_token: 'sync-1', sync_version: 1, source: 'local', dav_mode: 'read_only' }] });
    const propfind = await fetch(`${base}/carddav/user-1/book-ro/`, { method: 'PROPFIND', headers: { ...AUTH, depth: '0' } });
    expect(propfind.status).toBe(207);
    expect(await propfind.text()).not.toContain('<D:write');

    const response = await fetch(`${base}/carddav/user-1/book-ro/contact.vcf`, {
      method: 'PUT', headers: { ...AUTH, 'content-type': 'text/vcard' },
      body: 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:c1\r\nFN:Ada\r\nEND:VCARD',
    });
    expect(response.status).toBe(403);
    expect(queryCallsMatching('INSERT INTO contacts')).toHaveLength(0);
  });

  it('reports a disabled address book as missing for a write', async () => {
    query.mockResolvedValue({ rows: [{ id: 'book-off', source: 'local', dav_mode: 'off' }] });
    const response = await fetch(`${base}/carddav/user-1/book-off/contact.vcf`, {
      method: 'PUT', headers: { ...AUTH, 'content-type': 'text/vcard' },
      body: 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:c1\r\nFN:Ada\r\nEND:VCARD',
    });
    expect(response.status).toBe(404);
    expect(queryCallsMatching('INSERT INTO contacts')).toHaveLength(0);
  });
});

describe('application-password ceiling (max_dav_mode)', () => {
  const eventBody = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:e1\r\nDTSTART:20260901T090000Z\r\nDTEND:20260901T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  const cardBody = 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:c1\r\nFN:Ada\r\nEND:VCARD';

  it('lets a read-only credential read a writable calendar but not write to it', async () => {
    credential.maxDavMode = 'read_only';
    query.mockResolvedValue({ rows: [{ id: 'cal-rw', name: 'Work', sync_token: 'sync-1', read_only: false, source: 'local', dav_mode: 'read_write' }] });

    const propfind = await fetch(`${base}/caldav/user-1/cal-rw/`, { method: 'PROPFIND', headers: { ...AUTH, depth: '0' } });
    expect(propfind.status).toBe(207);
    // The advertised privileges match what the server will enforce for THIS credential.
    const body = await propfind.text();
    expect(body).toContain('<D:privilege><D:read/></D:privilege>');
    expect(body).not.toContain('<D:write');

    expect((await fetch(`${base}/caldav/user-1/cal-rw/event.ics`, {
      method: 'PUT', headers: { ...AUTH, 'content-type': 'text/calendar' }, body: eventBody,
    })).status).toBe(403);
    expect((await fetch(`${base}/caldav/user-1/cal-rw/event.ics`, { method: 'DELETE', headers: AUTH })).status).toBe(403);
    expect(queryCallsMatching('INSERT INTO calendar_events')).toHaveLength(0);
  });

  it('keeps discovery intact for a read-only credential', async () => {
    credential.maxDavMode = 'read_only';
    query.mockResolvedValueOnce({ rows: [{ id: 'cal-rw', name: 'Work', sync_token: 'sync-1', read_only: false, source: 'local', dav_mode: 'read_write' }] });
    const response = await fetch(`${base}/caldav/user-1/`, { method: 'PROPFIND', headers: { ...AUTH, depth: '1' } });
    expect(response.status).toBe(207);
    // A read-only credential may still read; only writes are narrowed.
    expect(await response.text()).toContain('/caldav/user-1/cal-rw/');
  });

  it('refuses CardDAV writes for a read-only credential and advertises read only', async () => {
    credential.maxDavMode = 'read_only';
    query.mockResolvedValue({ rows: [{ id: 'book-rw', name: 'Personal', sync_token: 'sync-1', sync_version: 1, source: 'local', dav_mode: 'read_write' }] });

    const propfind = await fetch(`${base}/carddav/user-1/book-rw/`, { method: 'PROPFIND', headers: { ...AUTH, depth: '0' } });
    expect(propfind.status).toBe(207);
    expect(await propfind.text()).not.toContain('<D:write');

    const put = await fetch(`${base}/carddav/user-1/book-rw/contact.vcf`, { method: 'PUT', headers: { ...AUTH, 'content-type': 'text/vcard' }, body: cardBody });
    expect(put.status).toBe(403);
    const del = await fetch(`${base}/carddav/user-1/book-rw/contact.vcf`, { method: 'DELETE', headers: AUTH });
    expect(del.status).toBe(403);
    expect(queryCallsMatching('INSERT INTO contacts')).toHaveLength(0);
  });

  it('keeps the read-write default credential able to write', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'cal-rw', source: 'local', read_only: false, dav_mode: 'read_write' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ uid: 'e1', etag: 'etag-1' }] });
    const response = await fetch(`${base}/caldav/user-1/cal-rw/event.ics`, {
      method: 'PUT', headers: { ...AUTH, 'content-type': 'text/calendar' }, body: eventBody,
    });
    expect(response.status).toBe(201);
  });
});

describe('WebDAV If header on a write', () => {
  const eventBody = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:e1\r\nDTSTART:20260901T090000Z\r\nDTEND:20260901T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  const cardBody = 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:c1\r\nFN:Ada\r\nEND:VCARD';

  const readWriteCalendar = (syncToken = 'sync-1') => ({
    id: 'cal-rw', name: 'Work', sync_token: syncToken, read_only: false, source: 'local', dav_mode: 'read_write',
  });

  it('accepts a write whose state-token condition matches the collection', async () => {
    query
      .mockResolvedValueOnce({ rows: [readWriteCalendar()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ uid: 'e1', etag: 'etag-1' }] });
    const response = await fetch(`${base}/caldav/user-1/cal-rw/event.ics`, {
      method: 'PUT',
      headers: { ...AUTH, 'content-type': 'text/calendar', if: '(<sync-1>)' },
      body: eventBody,
    });
    expect(response.status).toBe(201);
  });

  it('refuses a write whose state-token condition is stale, and writes nothing', async () => {
    query.mockResolvedValue({ rows: [readWriteCalendar('sync-2')] });
    const response = await fetch(`${base}/caldav/user-1/cal-rw/event.ics`, {
      method: 'PUT',
      headers: { ...AUTH, 'content-type': 'text/calendar', if: '(<sync-1>)' },
      body: eventBody,
    });
    expect(response.status).toBe(412);
    expect(queryCallsMatching('INSERT INTO calendar_events')).toHaveLength(0);
  });

  it('reports a malformed If header as a client error rather than ignoring it', async () => {
    query.mockResolvedValue({ rows: [readWriteCalendar()] });
    const response = await fetch(`${base}/caldav/user-1/cal-rw/event.ics`, {
      method: 'PUT',
      headers: { ...AUTH, 'content-type': 'text/calendar', if: '(<sync-1>' },
      body: eventBody,
    });
    expect(response.status).toBe(400);
    expect(queryCallsMatching('INSERT INTO calendar_events')).toHaveLength(0);
  });

  it('fails a tagged list closed instead of treating it as no condition', async () => {
    query.mockResolvedValue({ rows: [{ id: 'book-rw', name: 'Personal', sync_token: 'sync-1', sync_version: 1, source: 'local', dav_mode: 'read_write' }] });
    const response = await fetch(`${base}/carddav/user-1/book-rw/contact.vcf`, {
      method: 'PUT',
      headers: { ...AUTH, 'content-type': 'text/vcard', if: '</carddav/user-1/book-rw/> (["etag-1"])' },
      body: cardBody,
    });
    expect(response.status).toBe(412);
    expect(queryCallsMatching('INSERT INTO contacts')).toHaveLength(0);
  });

  it('evaluates an entity-tag condition on a CardDAV write against the stored etag', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'book-rw', name: 'Personal', sync_token: 'sync-1', sync_version: 1, source: 'local', dav_mode: 'read_write' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'c1', uid: 'c1', etag: 'etag-9', dav_filename: 'contact.vcf' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'c1' }] })
      .mockResolvedValueOnce({ rows: [] });
    const response = await fetch(`${base}/carddav/user-1/book-rw/contact.vcf`, {
      method: 'PUT',
      headers: { ...AUTH, 'content-type': 'text/vcard', if: '(["etag-9"])' },
      body: cardBody,
    });
    expect(response.status).toBe(204);
  });
});
