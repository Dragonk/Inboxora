import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../services/db.js', () => ({ query }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'owner-1' }; next(); } }));

import express from 'express';
import calendarFeedRouter from './calendarFeed.js';
import { reset } from '../services/rateLimiter.js';

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/', calendarFeedRouter);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise(resolve => server.close(resolve)));
beforeEach(async () => {
  query.mockReset();
  await reset('calendar-feed:::ffff:127.0.0.1');
});

describe('secret calendar feeds', () => {
  it('returns a private RFC calendar with security headers for a valid token', async () => {
    query.mockResolvedValue({ rows: [{ calendar_ids: ['cal-1'], calendar_name: 'Personal', id: 'event-1', uid: 'uid-1', summary: 'Planning', starts_at: '2026-09-01T09:00:00.000Z', ends_at: '2026-09-01T10:00:00.000Z', all_day: false }] });
    const responses = await Promise.all(Array.from({ length: 31 }, () => fetch(`${base}/calendar/feeds/${'a'.repeat(43)}.ics`)));
    expect(responses.every(response => response.status === 200)).toBe(true);
    const body = await responses[30].text();
    expect(responses[30].headers.get('content-type')).toContain('text/calendar');
    expect(responses[30].headers.get('cache-control')).toContain('no-store');
    expect(responses[30].headers.get('x-content-type-options')).toBe('nosniff');
    expect(body).toContain('BEGIN:VCALENDAR\r\n');
    expect(body).toMatch(/DTSTAMP:\d{8}T\d{6}Z\r\n/);
    expect(body).toContain('SUMMARY:Planning\r\n');
    expect(body).not.toContain('a'.repeat(43));
  });

  it('uses the same non-enumerating response for malformed and random tokens', async () => {
    query.mockResolvedValue({ rows: [] });
    const malformed = await fetch(`${base}/calendar/feeds/not-a-token.ics`);
    const random = await fetch(`${base}/calendar/feeds/${'b'.repeat(43)}.ics`);
    expect(malformed.status).toBe(404);
    expect(random.status).toBe(404);
    expect(await malformed.text()).toBe(await random.text());
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('throttles repeated invalid links after the failure budget is exhausted', async () => {
    const responses = await Promise.all(Array.from({ length: 31 }, () => fetch(`${base}/calendar/feeds/not-a-token.ics`)));
    expect(responses.every(response => response.status === 404)).toBe(true);
    expect(responses[30].headers.get('retry-after')).toMatch(/^\d+$/);
    expect(query).not.toHaveBeenCalled();
  });

  it('throttles only failures, while revoked feeds fail immediately after revocation', async () => {
    let revoked = false;
    query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT f.calendar_ids')) return { rows: revoked ? [] : [{ calendar_name: 'Personal', id: 'event-1', uid: 'uid-1', summary: 'Planning', starts_at: '2026-09-01T09:00:00.000Z', ends_at: '2026-09-01T10:00:00.000Z', all_day: false }] };
      if (sql.startsWith('SELECT id, name FROM calendars')) return { rows: [{ id: 'cal-1', name: 'Personal' }] };
      if (sql.startsWith('INSERT INTO calendar_secret_feeds')) return { rows: [{ id: 'feed-1', calendar_ids: ['cal-1'], created_at: '2026-09-01T00:00:00.000Z' }] };
      if (sql.startsWith('UPDATE calendar_secret_feeds')) { revoked = true; return { rows: [{ id: 'feed-1' }] }; }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const created = await fetch(`${base}/api/calendar/feeds`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ calendarIds: ['cal-1'] }) });
    const { secret } = await created.json();
    const url = `${base}/calendar/feeds/${secret}.ics`;
    expect((await fetch(url)).status).toBe(200);
    expect((await fetch(`${base}/api/calendar/feeds/feed-1`, { method: 'DELETE' })).status).toBe(204);
    const revokedResponse = await fetch(url);
    expect(revokedResponse.status).toBe(404);
    expect(await revokedResponse.text()).toBe('Not found');
  });

  it('reveals the raw secret only in the create response and never in the persistence query', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'cal-1', name: 'Personal' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'feed-1', calendar_ids: ['cal-1'], created_at: '2026-09-01T00:00:00.000Z' }] });
    const response = await fetch(`${base}/api/calendar/feeds`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ calendarIds: ['cal-1'] }) });
    const json = await response.json();
    expect(response.status).toBe(201);
    expect(json.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(query.mock.calls[1][1]).not.toContain(json.secret);
    expect(JSON.stringify(json.feed)).toContain('/calendar/feeds/');
  });

  it('revokes only an owned feed', async () => {
    query.mockResolvedValue({ rows: [{ id: 'feed-1' }] });
    const response = await fetch(`${base}/api/calendar/feeds/feed-1`, { method: 'DELETE' });
    expect(response.status).toBe(204);
    expect(query.mock.calls[0][0]).toContain('owner_user_id = $2');
    expect(query.mock.calls[0][1]).toEqual(['feed-1', 'owner-1']);
  });
});
