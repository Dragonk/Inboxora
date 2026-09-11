// Recurrence-projection benchmark.
//
// Imports the real current projection code (no copied algorithm) so the numbers
// describe this build. Run from backend/:
//
//   node benchmarks/calendar-projection-benchmark.mjs
//
// The fixed dataset is 100 daily series spanning five years, projected into a
// 42-day window — the shape called out by the calendar audit. Every figure is
// reported over several repetitions (median and p95), not as a best case.

import { performance } from 'node:perf_hooks';

import { projectCalendarResource, projectCalendarResourceWithStatus } from '../src/utils/calendarRecurrence.js';

const SERIES_COUNT = Number.parseInt(process.env.BENCH_SERIES ?? '100', 10) || 100;
const WINDOW_DAYS = 42;
const REPETITIONS = Number.parseInt(process.env.BENCH_REPS ?? '7', 10) || 7;

function ics(lines) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Benchmark//EN', ...lines, 'END:VCALENDAR', ''].join('\r\n');
}

function seriesRow(index, tzid) {
  const start = new Date(Date.UTC(2021, 8, 1, 9, 0, 0));
  const zoneParameter = tzid ? `;TZID=${tzid}` : '';
  const zoneSuffix = tzid ? '' : 'Z';
  const uid = `series-${index}`;
  return {
    id: uid,
    calendar_id: 'cal-1',
    uid,
    raw_ical: ics([
      'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20210101T000000Z',
      `DTSTART${zoneParameter}:20210901T090000${zoneSuffix}`,
      `DTEND${zoneParameter}:20210901T100000${zoneSuffix}`,
      'RRULE:FREQ=DAILY', `SUMMARY:Series ${index}`, 'END:VEVENT',
    ]),
    summary: `Series ${index}`,
    starts_at: start,
    ends_at: new Date(start.getTime() + 3600000),
    all_day: false,
  };
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = fraction => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
  return { min: sorted[0], median: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
}

function measure(label, run) {
  run(); // warm the JIT and the per-resource caches before recording
  const samples = [];
  let events = 0;
  for (let index = 0; index < REPETITIONS; index += 1) {
    const started = performance.now();
    events = run();
    samples.push(performance.now() - started);
  }
  const result = stats(samples);
  console.log(`${label}: median ${result.median.toFixed(1)} ms, p95 ${result.p95.toFixed(1)} ms, min ${result.min.toFixed(1)} ms, max ${result.max.toFixed(1)} ms (events ${events})`);
  return result;
}

function projectionRun(rows, from, to) {
  let events = 0;
  for (const row of rows) events += projectCalendarResource(row, from, to).length;
  return events;
}

function fullScanRun(rows, from, to) {
  let events = 0;
  for (const row of rows) events += projectCalendarResourceWithStatus(row, from, to, { fullScan: true }).events.length;
  return events;
}

const from = new Date('2026-09-01T00:00:00Z');
const to = new Date(from.getTime() + WINDOW_DAYS * 86400000);

const utcRows = Array.from({ length: SERIES_COUNT }, (_, index) => seriesRow(index, null));
const tzidRows = Array.from({ length: SERIES_COUNT }, (_, index) => seriesRow(index, 'Europe/Warsaw'));

console.log(`dataset: ${SERIES_COUNT} series x 5 years, ${WINDOW_DAYS}-day window, ${REPETITIONS} repetitions\n`);

measure('UTC series projection (fast path)', () => projectionRun(utcRows, from, to));
measure('TZID (Europe/Warsaw) projection (fast path)', () => projectionRun(tzidRows, from, to));
measure('UTC series projection (full scan, precise)', () => fullScanRun(utcRows, from, to));
measure('TZID (Europe/Warsaw) projection (full scan, precise)', () => fullScanRun(tzidRows, from, to));

// Synthetic microtest isolating formatter reuse on the IANA fallback path.
// It makes 4 formatToParts calls per conversion (the shape of
// localDateInTimeZone) for 6000 conversions, and compares constructing the
// formatter each time against reusing one. This is a microtest of Intl cost, not
// a calendar-load measurement.
function formatterMicrotest({ reuse }) {
  const options = { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' };
  const shared = new Intl.DateTimeFormat('en-CA', options);
  const make = () => (reuse ? shared : new Intl.DateTimeFormat('en-CA', options));
  const instant = new Date('2026-09-01T09:00:00Z');
  const started = performance.now();
  let constructions = 0;
  for (let index = 0; index < 6000; index += 1) {
    for (let call = 0; call < 4; call += 1) {
      make().formatToParts(instant);
      constructions += 1;
    }
  }
  return { ms: performance.now() - started, constructions };
}

const cold = formatterMicrotest({ reuse: false });
const warm = formatterMicrotest({ reuse: true });
console.log(`\nformatter microtest (6000 conversions x 4 calls): construct-per-call ${cold.ms.toFixed(1)} ms / ${cold.constructions} constructions, reused ${warm.ms.toFixed(1)} ms / ${warm.constructions} constructions`);
