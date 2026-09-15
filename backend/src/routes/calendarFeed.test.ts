import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { listeningPort } from '../test/net.js';
import type { Server } from 'node:http';
import type { DbQueryResult, DbRow, query as queryContract } from '../services/db.js';
import { createHash } from 'crypto';

const { query } = vi.hoisted(() => ({ query: vi.fn<typeof queryContract>() }));
vi.mock('../services/db.js', () => ({ query }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req: { headers: Record<string, string>; session?: { userId?: string } }, _res: unknown, next: () => void) => { req.session = { userId: 'owner-1' }; next(); } }));

type CalendarFeedEventRow = DbRow & {
  calendar_ids?: string[];
  calendar_name: string;
  id: string;
  uid: string;
  summary: string;
  starts_at: string;
  ends_at: string;
  all_day: boolean;
};

type CalendarRow = DbRow & { id: string; name: string };
type FeedRow = DbRow & { id: string; calendar_ids: string[]; created_at: string };
type RevokedFeedRow = DbRow & { id: string };

type CalendarFeedResponse = {
  secret: string;
  feed: { id: string; calendarIds: string[]; createdAt: string; url: string };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCalendarFeedResponse(value: unknown): value is CalendarFeedResponse {
  if (!isRecord(value) || typeof value.secret !== 'string' || !isRecord(value.feed)) return false;
  const { feed } = value;
  return typeof feed.id === 'string'
    && Array.isArray(feed.calendarIds)
    && feed.calendarIds.every(calendarId => typeof calendarId === 'string')
    && typeof feed.createdAt === 'string'
    && typeof feed.url === 'string';
}

function feedResponse(value: unknown): CalendarFeedResponse {
  if (!isCalendarFeedResponse(value)) throw new Error('Expected a calendar feed response');
  return value;
}

function queryText(call: number): string {
  const text = query.mock.calls[call]?.[0];
  if (typeof text !== 'string') throw new Error(`Expected query ${call} to have SQL text`);
  return text;
}

function queryParameters(call: number): unknown[] {
  const parameters = query.mock.calls[call]?.[1];
  if (!Array.isArray(parameters)) throw new Error(`Expected query ${call} to have parameters`);
  return parameters;
}

function queryRows<T extends DbRow>(rows: T[]): DbQueryResult<T> {
  return { rows };
}

import express from 'express';
import calendarFeedRouter from './calendarFeed.js';
import { reset } from '../services/rateLimiter.js';

let server: Server;
let base = '';
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/', calendarFeedRouter);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${listeningPort(server)}`;
});
afterAll(() => new Promise(resolve => server.close(resolve)));
beforeEach(async () => {
  query.mockReset();
  await reset('calendar-feed:::ffff:127.0.0.1');
});

describe('secret calendar feeds', () => {
  it('returns a private RFC calendar with security headers for a valid token', async () => {
    const rows: CalendarFeedEventRow[] = [{ calendar_ids: ['cal-1'], calendar_name: 'Personal', id: 'event-1', uid: 'uid-1', summary: 'Planning', starts_at: '2026-09-01T09:00:00.000Z', ends_at: '2026-09-01T10:00:00.000Z', all_day: false }];
    query.mockResolvedValue(queryRows(rows));
    const responses = await Promise.all(Array.from({ length: 31 }, () => fetch(`${base}/calendar/feeds/${'a'.repeat(43)}.ics`)));
    expect(responses.every(response => response.status === 200)).toBe(true);
    const body = await responses[30].text();
    expect(responses[30].headers.get('content-type')).toContain('text/calendar');
    expect(responses[30].headers.get('cache-control')).toBe('private, no-cache, must-revalidate');
    expect(responses[30].headers.get('x-content-type-options')).toBe('nosniff');
    expect(body).toContain('BEGIN:VCALENDAR\r\n');
    expect(body).toMatch(/DTSTAMP:\d{8}T\d{6}Z\r\n/);
    expect(body).toContain('SUMMARY:Planning\r\n');
    expect(body).not.toContain('a'.repeat(43));
  });

  it('uses the same non-enumerating response for malformed and random tokens', async () => {
    query.mockResolvedValue(queryRows([]));
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
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT f.calendar_ids')) {
        const rows: CalendarFeedEventRow[] = revoked ? [] : [{ calendar_name: 'Personal', id: 'event-1', uid: 'uid-1', summary: 'Planning', starts_at: '2026-09-01T09:00:00.000Z', ends_at: '2026-09-01T10:00:00.000Z', all_day: false }];
        return queryRows(rows);
      }
      if (sql.startsWith('SELECT id, name FROM calendars')) return queryRows<CalendarRow>([{ id: 'cal-1', name: 'Personal' }]);
      if (sql.startsWith('INSERT INTO calendar_secret_feeds')) return queryRows<FeedRow>([{ id: 'feed-1', calendar_ids: ['cal-1'], created_at: '2026-09-01T00:00:00.000Z' }]);
      if (sql.startsWith('UPDATE calendar_secret_feeds')) { revoked = true; return queryRows<RevokedFeedRow>([{ id: 'feed-1' }]); }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const created = await fetch(`${base}/api/calendar/feeds`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ calendarIds: ['cal-1'] }) });
    const { secret } = feedResponse(await created.json());
    const url = `${base}/calendar/feeds/${secret}.ics`;
    expect((await fetch(url)).status).toBe(200);
    expect((await fetch(`${base}/api/calendar/feeds/feed-1`, { method: 'DELETE' })).status).toBe(204);
    const revokedResponse = await fetch(url);
    expect(revokedResponse.status).toBe(404);
    expect(await revokedResponse.text()).toBe('Not found');
  });

  it('reveals the raw secret only in the create response and never in the persistence query', async () => {
    query
      .mockResolvedValueOnce(queryRows<CalendarRow>([{ id: 'cal-1', name: 'Personal' }]))
      .mockResolvedValueOnce(queryRows<FeedRow>([{ id: 'feed-1', calendar_ids: ['cal-1'], created_at: '2026-09-01T00:00:00.000Z' }]));
    const response = await fetch(`${base}/api/calendar/feeds`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ calendarIds: ['cal-1'] }) });
    const json = feedResponse(await response.json());
    expect(response.status).toBe(201);
    expect(json.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(queryParameters(1)).not.toContain(json.secret);
    expect(JSON.stringify(json.feed)).toContain('/calendar/feeds/');
  });

  it('revokes only an owned feed', async () => {
    query.mockResolvedValue(queryRows<RevokedFeedRow>([{ id: 'feed-1' }]));
    const response = await fetch(`${base}/api/calendar/feeds/feed-1`, { method: 'DELETE' });
    expect(response.status).toBe(204);
    expect(queryText(0)).toContain('owner_user_id = $2');
    expect(queryParameters(0)).toEqual(['feed-1', 'owner-1']);
  });

  it('returns 304 for exact, weak, and wildcard validators using the exact body hash', async () => {
    const rows: CalendarFeedEventRow[] = [{ calendar_name: 'Personal', id: 'event-1', uid: 'uid-1', summary: 'Planning', starts_at: '2026-09-01T09:00:00.000Z', ends_at: '2026-09-01T10:00:00.000Z', all_day: false }];
    query.mockResolvedValue(queryRows(rows));
    const url = `${base}/calendar/feeds/${'a'.repeat(43)}.ics`; const first = await fetch(url); const body = await first.text(); const etag = first.headers.get('etag');
    if (etag === null) throw new Error('Calendar feed response must include an ETag');
    expect(etag).toBe(`"${createHash('sha256').update(body).digest('hex')}"`);
    expect((await fetch(url, { headers: { 'if-none-match': etag } })).status).toBe(304);
    expect((await fetch(url, { headers: { 'if-none-match': `W/${etag}` } })).status).toBe(304);
    expect((await fetch(url, { headers: { 'if-none-match': '*' } })).status).toBe(304);
  });

  it('rotates only an owned feed and returns the replacement secret once', async () => {
    query.mockResolvedValue(queryRows<FeedRow>([{ id: 'feed-1', calendar_ids: ['cal-1'], created_at: '2026-09-01T00:00:00.000Z' }]));
    const response = await fetch(`${base}/api/calendar/feeds/feed-1/rotate`, { method: 'POST' });
    const json = feedResponse(await response.json());
    expect(response.status).toBe(200);
    expect(json.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(queryText(0)).toContain('token_hash = $1');
    expect(queryText(0)).toContain('owner_user_id = $3');
    expect(queryParameters(0)[0]).not.toBe(json.secret);
  });
});
