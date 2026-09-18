import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { listeningPort } from '../test/net.js';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('../services/db.js', () => ({ query }));
vi.mock('../services/authLimiter.js', () => ({ authLimiterConfig: { maxRequests: 500, windowMs: 60_000 } }));
vi.mock('../services/rateLimiter.js', () => ({ consume: vi.fn(async () => ({ limited: false })) }));
vi.mock('../services/authEvents.js', () => ({ logAuthEvent: vi.fn() }));
vi.mock('../services/davServerAuth.js', () => ({
  createDavAuthMiddleware: () => (req: { davUserId?: string; davCredentialId?: string }, _res: unknown, next: () => void) => {
    req.davUserId = 'user-1';
    req.davCredentialId = 'credential-1';
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
