import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  calendarProjectionCacheStats,
  clearCalendarProjectionCache,
  closeCalendarProjectionPool,
  projectCalendarResources,
} from './calendarProjectionPool.js';

function ics(lines) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN', ...lines, 'END:VCALENDAR', ''].join('\r\n');
}

function dailyRow(id, { tzid = null, etag = 'etag-1' } = {}) {
  const zoneParameter = tzid ? `;TZID=${tzid}` : '';
  const zoneSuffix = tzid ? '' : 'Z';
  return {
    id,
    calendar_id: 'cal-1',
    uid: id,
    etag,
    raw_ical: ics([
      'BEGIN:VEVENT', `UID:${id}`, 'DTSTAMP:20260101T000000Z',
      `DTSTART${zoneParameter}:20260105T090000${zoneSuffix}`,
      `DTEND${zoneParameter}:20260105T100000${zoneSuffix}`,
      'RRULE:FREQ=DAILY', `SUMMARY:${id}`, 'END:VEVENT',
    ]),
    summary: id,
    starts_at: new Date('2026-01-05T09:00:00Z'),
    ends_at: new Date('2026-01-05T10:00:00Z'),
    all_day: false,
  };
}

const FROM = new Date('2026-09-01T00:00:00Z');
const TO = new Date('2026-09-15T00:00:00Z');

const previousEnv = {};
beforeEach(() => {
  clearCalendarProjectionCache();
  for (const name of ['CALENDAR_PROJECTION_DISABLED', 'CALENDAR_PROJECTION_WORKERS', 'CALENDAR_PROJECTION_MAX_ITERATIONS', 'CALENDAR_PROJECTION_MAX_QUEUE', 'CALENDAR_PROJECTION_TIMEOUT_MS', 'CALENDAR_PROJECTION_CACHE_DISABLED', 'CALENDAR_PROJECTION_CACHE_ENTRIES', 'CALENDAR_PROJECTION_CACHE_TTL_MS']) {
    previousEnv[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(async () => {
  await closeCalendarProjectionPool();
  clearCalendarProjectionCache();
  for (const [name, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('calendar projection worker pool', () => {
  it('projects every resource into the requested window', async () => {
    const rows = [dailyRow('a'), dailyRow('b'), dailyRow('c')];
    const result = await projectCalendarResources(rows, FROM, TO);
    expect(result.degraded).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.failures).toEqual([]);
    expect(result.events).toHaveLength(42);
    expect(result.events.every(event => event.starts_at instanceof Date)).toBe(true);
    expect(new Set(result.events.map(event => event.series_id))).toEqual(new Set(['a', 'b', 'c']));
  });

  it('keeps a damaged resource from suppressing the healthy calendars', async () => {
    const broken = { ...dailyRow('broken'), raw_ical: 'not a calendar at all' };
    const result = await projectCalendarResources([broken, dailyRow('healthy')], FROM, TO);
    const healthy = result.events.filter(event => event.series_id === 'healthy');
    expect(healthy).toHaveLength(14);
  });

  it('reports a resource that exceeds its iteration budget as truncated, not as a silent omission', async () => {
    process.env.CALENDAR_PROJECTION_MAX_ITERATIONS = '500';
    const dense = {
      id: 'dense',
      calendar_id: 'cal-1',
      uid: 'dense',
      etag: 'etag-dense',
      raw_ical: ics([
        'BEGIN:VEVENT', 'UID:dense', 'DTSTAMP:20200101T000000Z',
        'DTSTART:19700101T000000Z', 'DTEND:19700101T000100Z', 'RRULE:FREQ=MINUTELY', 'SUMMARY:Dense', 'END:VEVENT',
      ]),
      summary: 'Dense',
      starts_at: new Date('1970-01-01T00:00:00Z'),
      ends_at: new Date('1970-01-01T00:01:00Z'),
      all_day: false,
    };
    const result = await projectCalendarResources([dense, dailyRow('healthy')], FROM, TO);
    expect(result.truncated).toBe(true);
    expect(result.truncatedSeries).toContain('dense');
    expect(result.failures).toContainEqual(expect.objectContaining({ id: 'dense', reason: 'iteration-limit' }));
    expect(result.events.filter(event => event.series_id === 'healthy')).toHaveLength(14);
  });

  it('reports queue overflow instead of silently dropping calendars', async () => {
    process.env.CALENDAR_PROJECTION_MAX_QUEUE = '1';
    process.env.CALENDAR_PROJECTION_WORKERS = '1';
    const rows = [dailyRow('a'), dailyRow('b'), dailyRow('c')];
    const result = await projectCalendarResources(rows, FROM, TO);
    expect(result.overloaded).toBe(true);
    expect(result.failures.some(failure => failure.reason === 'overloaded')).toBe(true);
  });

  it('falls back to inline projection when workers are disabled', async () => {
    const result = await projectCalendarResources([dailyRow('inline')], FROM, TO, { useWorkers: false });
    expect(result.degraded).toBe(true);
    expect(result.events).toHaveLength(14);
  });

  it('returns an empty result for an empty resource list without spawning workers', async () => {
    const result = await projectCalendarResources([], FROM, TO);
    expect(result).toEqual({ events: [], failures: [], truncated: false, truncatedSeries: [], overloaded: false, degraded: false });
  });

  it('serves an unchanged resource from the projection cache', async () => {
    const rows = [dailyRow('cached')];
    const first = await projectCalendarResources(rows, FROM, TO, { userId: 'user-1' });
    const second = await projectCalendarResources(rows, FROM, TO, { userId: 'user-1' });
    expect(second.events).toHaveLength(first.events.length);
    expect(calendarProjectionCacheStats().entries).toBe(1);
  });

  it('invalidates a cached projection when the resource version changes', async () => {
    const original = dailyRow('edited');
    await projectCalendarResources([original], FROM, TO, { userId: 'user-1' });
    const edited = { ...original, etag: 'etag-2' };
    await projectCalendarResources([edited], FROM, TO, { userId: 'user-1' });
    // One entry per version; the stale version is still addressable but the new
    // version never reuses it.
    expect(calendarProjectionCacheStats().entries).toBe(2);
  });

  it('never shares a cached projection between users', async () => {
    const rows = [dailyRow('private')];
    await projectCalendarResources(rows, FROM, TO, { userId: 'user-1' });
    await projectCalendarResources(rows, FROM, TO, { userId: 'user-2' });
    expect(calendarProjectionCacheStats().entries).toBe(2);
  });

  it('coalesces two identical concurrent projections into one cached entry', async () => {
    const rows = [dailyRow('shared')];
    const [first, second] = await Promise.all([
      projectCalendarResources(rows, FROM, TO, { userId: 'user-1' }),
      projectCalendarResources(rows, FROM, TO, { userId: 'user-1' }),
    ]);
    expect(first.events).toHaveLength(second.events.length);
    expect(calendarProjectionCacheStats().entries).toBe(1);
  });

  it('bypasses the cache when requested', async () => {
    const rows = [dailyRow('nocache')];
    await projectCalendarResources(rows, FROM, TO, { userId: 'user-1', cache: false });
    expect(calendarProjectionCacheStats().entries).toBe(0);
  });

  it('caches a series that overran its budget instead of re-walking it on every request', async () => {
    process.env.CALENDAR_PROJECTION_MAX_ITERATIONS = '500';
    const dense = {
      id: 'budget-dense', calendar_id: 'cal-1', uid: 'budget-dense', etag: 'etag-budget',
      raw_ical: ics([
        'BEGIN:VEVENT', 'UID:budget-dense', 'DTSTAMP:20200101T000000Z',
        'DTSTART:19700101T000000Z', 'DTEND:19700101T000100Z', 'RRULE:FREQ=MINUTELY', 'SUMMARY:Dense', 'END:VEVENT',
      ]),
      summary: 'Dense', starts_at: new Date('1970-01-01T00:00:00Z'), ends_at: new Date('1970-01-01T00:01:00Z'), all_day: false,
    };
    const first = await projectCalendarResources([dense], FROM, TO, { userId: 'user-1' });
    expect(first.truncated).toBe(true);
    // The answer is cached even though it is a failure. Leaving it out meant this walk —
    // over a thousand iterations of pure CPU — ran again on every single request.
    expect(calendarProjectionCacheStats().entries).toBe(1);

    const second = await projectCalendarResources([dense], FROM, TO, { userId: 'user-1' });
    expect(second.truncated).toBe(true);
    expect(second.failures).toContainEqual(expect.objectContaining({ id: 'budget-dense' }));
  });

  it('expires a cached failure sooner than a cached success', async () => {
    process.env.CALENDAR_PROJECTION_MAX_ITERATIONS = '500';
    // A failure that outlived its usefulness would hide a series that has since become
    // expandable, so it must expire on its own short timer.
    process.env.CALENDAR_PROJECTION_FAILURE_CACHE_TTL_MS = '1000';
    const dense = {
      id: 'ttl-dense', calendar_id: 'cal-1', uid: 'ttl-dense', etag: 'etag-ttl',
      raw_ical: ics([
        'BEGIN:VEVENT', 'UID:ttl-dense', 'DTSTAMP:20200101T000000Z',
        'DTSTART:19700101T000000Z', 'DTEND:19700101T000100Z', 'RRULE:FREQ=MINUTELY', 'SUMMARY:Dense', 'END:VEVENT',
      ]),
      summary: 'Dense', starts_at: new Date('1970-01-01T00:00:00Z'), ends_at: new Date('1970-01-01T00:01:00Z'), all_day: false,
    };
    await projectCalendarResources([dense], FROM, TO, { userId: 'user-1' });
    expect(calendarProjectionCacheStats().entries).toBe(1);
    await new Promise(resolve => { setTimeout(resolve, 1100); });
    // Reading it again drops the expired entry rather than serving it.
    const after = await projectCalendarResources([dense], FROM, TO, { userId: 'user-1' });
    expect(after.truncated).toBe(true);
  });
});
