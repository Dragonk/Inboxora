import { beforeEach, describe, expect, it, vi } from 'vitest';

// The occurrence materialiser runs in the background, but "background" is not the same as
// "off the event loop": its first implementation called the projection inline and blocked the
// API for the whole batch. Measured with monitorEventLoopDelay, four long-running series held
// the loop for 429 ms with *zero* timer samples in between, against 5-7 ms through the pool.
//
// This file pins that with the projection mocked, because a timing assertion cannot decide it:
// an inline batch hands the loop back between events, so its longest stall is only a fraction
// of the total. The real database behaviour is covered by
// calendarOccurrences.integration.test.js.

const { query, withTransaction, projectCalendarResources } = vi.hoisted(() => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
  projectCalendarResources: vi.fn(),
}));

vi.mock('./db.js', () => ({ query, withTransaction }));
vi.mock('./calendarProjectionPool.js', () => ({ projectCalendarResources }));

const {
  coveragePredicate, materializeEvent, occurrenceHorizon, requestOccurrenceRebuild,
} = await import('./calendarOccurrences.js');

const ROW = {
  id: 'event-1', user_id: 'user-1', calendar_id: 'calendar-1', uid: 'uid-1', etag: 'etag-1',
  raw_ical: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n',
  summary: 'Blocker', description: null, location: null, url: null, organizer: null, attendees: null,
  starts_at: new Date('2018-06-01T07:00:00Z'), ends_at: new Date('2018-06-01T07:30:00Z'),
  all_day: false, timezone: 'Europe/Warsaw',
};

beforeEach(() => {
  query.mockReset();
  withTransaction.mockReset();
  withTransaction.mockImplementation(async fn => fn({ query }));
  projectCalendarResources.mockReset();
  projectCalendarResources.mockResolvedValue({ events: [], failures: [], truncated: false });
});

describe('calendar occurrence materialisation', () => {
  it('expands through the worker pool instead of on the event loop', async () => {
    query.mockResolvedValueOnce({ rows: [ROW] });

    await materializeEvent('event-1', occurrenceHorizon());

    expect(projectCalendarResources).toHaveBeenCalledTimes(1);
    const options = projectCalendarResources.mock.calls[0][3];
    // `useWorkers: false` is the regression this guards: it renders the expansion inline.
    expect(options?.useWorkers).not.toBe(false);
    // The cached projection is keyed for interactive reads; the materialiser must see the
    // event as it is now, not a stale entry.
    expect(options?.cache).toBe(false);
  });

  it('expands over the horizon the caller asked for, not over the requested window', async () => {
    query.mockResolvedValueOnce({ rows: [ROW] });
    const horizon = { from: new Date('2026-01-01T00:00:00Z'), to: new Date('2027-01-01T00:00:00Z') };

    await materializeEvent('event-1', horizon);

    const [rows, from, to] = projectCalendarResources.mock.calls[0];
    expect(rows).toHaveLength(1);
    expect(from).toEqual(horizon.from);
    expect(to).toEqual(horizon.to);
  });

  it('stays dirty when the expansion was only partial', async () => {
    query.mockResolvedValueOnce({ rows: [ROW] });
    projectCalendarResources.mockResolvedValueOnce({ events: [], failures: [], truncated: true });
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    withTransaction.mockImplementationOnce(async fn => fn(client));

    const result = await materializeEvent('event-1', occurrenceHorizon());

    expect(result).toBe('truncated');
    // The final bookkeeping must record `dirty = true`, so the read path keeps expanding this
    // series on the fly rather than presenting a partial month as complete.
    const finalize = client.query.mock.calls.at(-1);
    expect(finalize[1][4]).toBe(true);
  });

  it('reports a missing event as skipped rather than writing an empty build', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await expect(materializeEvent('gone', occurrenceHorizon())).resolves.toBe('skipped');
    expect(projectCalendarResources).not.toHaveBeenCalled();
  });

  it('gives the horizon a past and a future side', () => {
    const { from, to } = occurrenceHorizon(new Date('2026-09-11T12:00:00Z'));
    expect(from.getTime()).toBeLessThan(new Date('2026-09-11T12:00:00Z').getTime());
    expect(to.getTime()).toBeGreaterThan(new Date('2026-09-11T12:00:00Z').getTime());
  });

  it('queues the requested events for rebuild', async () => {
    query.mockResolvedValueOnce({ rowCount: 2 });
    const result = await requestOccurrenceRebuild(['a', 'b']);
    expect(result.queued).toBe(2);
    expect(query.mock.calls[0][0]).toContain('SET dirty = true');
  });

  it('ignores an empty rebuild request without querying', async () => {
    await expect(requestOccurrenceRebuild([])).resolves.toEqual({ queued: 0 });
    expect(query).not.toHaveBeenCalled();
  });

  // The read path's "is this event covered?" test lives in one place, because the route and
  // the integration tests must agree on it exactly.
  it('exposes a coverage predicate that treats a missing state row as uncovered', () => {
    const predicate = coveragePredicate('s');
    expect(predicate).toContain('s.event_id IS NULL');
    expect(predicate).toContain('s.dirty');
    expect(predicate).toContain('s.built_from > $2');
    expect(predicate).toContain('s.built_to < $3');
  });
});
