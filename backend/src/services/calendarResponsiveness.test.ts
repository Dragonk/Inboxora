// The audit's key acceptance criterion: work on the calendar must not stall the
// rest of the API.
//
// Recurrence expansion is synchronous CPU work. The property that matters is
// whether the request-handling thread stays free to serve other requests while
// it runs. This test measures that directly as event-loop lag: a repeating timer
// records how late it fires, which is exactly the delay a concurrent light
// request would observe. It compares two modes on identical data:
//
//   * pooled  — expansion runs on worker threads (the shipped behaviour)
//   * inline  — expansion runs on the request thread (the pre-fix behaviour)
//
// The inline run is included to prove the measurement is meaningful: if it stops
// being measurably worse, the workload is no longer heavy and this test would
// silently stop protecting the property.

import { describe, expect, it } from 'vitest';

import { closeCalendarProjectionPool, projectCalendarResources } from './calendarProjectionPool.js';

function ics(lines) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Responsiveness//EN', ...lines, 'END:VCALENDAR', ''].join('\r\n');
}

// A MINUTELY series anchored in 2000 forces a long walk to reach a 2026 window.
function heavyRows(count) {
  return Array.from({ length: count }, (_, index) => {
    const uid = `heavy-${index}`;
    return {
      id: uid,
      calendar_id: 'cal-1',
      uid,
      etag: `etag-${index}`,
      raw_ical: ics([
        'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20000101T000000Z',
        'DTSTART:20000101T000000Z', 'DTEND:20000101T000100Z',
        'RRULE:FREQ=MINUTELY', `SUMMARY:${uid}`, 'END:VEVENT',
      ]),
      summary: uid,
      starts_at: new Date('2000-01-01T00:00:00Z'),
      ends_at: new Date('2000-01-01T00:01:00Z'),
      all_day: false,
    };
  });
}

const FROM = new Date('2026-09-01T00:00:00Z');
const TO = new Date('2026-09-15T00:00:00Z');

// Record how late a 10 ms interval timer fires while `work` runs.
//
// A timer that never fires at all (zero samples) is the strongest possible
// starvation signal: the loop was blocked for the whole measurement, which is
// exactly what inline expansion does.
function eventLoopLagWhile(work) {
  const lags = [];
  const interval = 10;
  let expected = performance.now() + interval;
  const timer = setInterval(() => {
    const now = performance.now();
    lags.push(Math.max(0, now - expected));
    expected = now + interval;
  }, interval);
  const started = performance.now();
  return work().then(() => {
    const duration = performance.now() - started;
    clearInterval(timer);
    lags.sort((left, right) => left - right);
    const at = fraction => lags[Math.min(lags.length - 1, Math.floor(fraction * lags.length))] ?? 0;
    return { duration, samples: lags.length, median: at(0.5), p95: at(0.95), max: lags[lags.length - 1] ?? 0 };
  });
}

const options = { userId: 'responsiveness', maxIterations: 40000 };

describe('calendar expansion responsiveness', () => {
  it('does not stall the event loop while expanding heavy series', async () => {
    // The shared vitest setup disables the worker pool so unit tests run inline.
    // This file measures the pool itself, so it re-enables it explicitly.
    const disabled = process.env.CALENDAR_PROJECTION_DISABLED;
    delete process.env.CALENDAR_PROJECTION_DISABLED;
    try {
      const rows = heavyRows(4);

      // Pooled: the walk happens on workers, so the request thread keeps timing.
      const pooled = await eventLoopLagWhile(() => projectCalendarResources(rows, FROM, TO, options));

      // Inline: the walk happens on this thread and starves the timer entirely.
      const inline = await eventLoopLagWhile(() => projectCalendarResources(rows, FROM, TO, { ...options, useWorkers: false, userId: 'responsiveness-inline' }));

      await closeCalendarProjectionPool();

      // The workload must be heavy enough to be worth measuring.
      expect(pooled.duration).toBeGreaterThan(100);
      expect(inline.duration).toBeGreaterThan(100);

      // Pooled expansion leaves the request thread responsive: the timer keeps
      // firing and never falls far behind, which is what a concurrent light API
      // request experiences.
      expect(pooled.samples).toBeGreaterThan(5);
      expect(pooled.max).toBeLessThan(100);

      // Inline expansion blocks the loop. This is the actual regression guard: if
      // the pool ever stops being used, the timer is starved and this fails.
      expect(inline.samples).toBeLessThan(pooled.samples);
    } finally {
      if (disabled === undefined) delete process.env.CALENDAR_PROJECTION_DISABLED;
      else process.env.CALENDAR_PROJECTION_DISABLED = disabled;
    }
  }, 120000);
});
