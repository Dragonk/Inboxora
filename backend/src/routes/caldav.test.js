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
import caldavRouter from './caldav.js';

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
});
