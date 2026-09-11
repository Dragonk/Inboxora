// Real PostgreSQL tests for materialised calendar occurrences.
//
// These exist because materialisation introduces a second representation of the same data,
// and the only thing that makes that safe is proving it agrees with the expansion it replaces.
// A unit test with a mocked database cannot show that: the risk is precisely in the interaction
// between the trigger, the stored rows and the recurrence expansion.
//
// Run with:
//   DB_HOST=localhost DB_NAME=mailflow_test DB_USER=mailflow_test DB_PASSWORD=mailflow_test \
//     npx vitest run src/services/calendarOccurrences.integration.test.js

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { query, withTransaction, pool } from './db.js';
import { coveragePredicate, finalizeMaterialization, materializeEvent, materializePendingOccurrences, occurrenceHorizon } from './calendarOccurrences.js';
import { projectCalendarResource } from '../utils/calendarRecurrence.js';

const hasPg = process.env.DB_HOST && process.env.DB_NAME;
const describeOrSkip = hasPg ? describe : describe.skip;

const USER_ID = '00000000-0000-0000-0000-0000000003a1';
const CALENDAR_ID = '00000000-0000-0000-0000-0000000003a2';

const CRLF = '\r\n';
const vcalendar = (body, exceptions = []) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', 'BEGIN:VEVENT', 'UID:CASE', ...body, 'END:VEVENT', ...exceptions, 'END:VCALENDAR'].join(CRLF);

// Every shape where a stored occurrence could plausibly drift from a live expansion.
const CASES = {
  plain: ['DTSTART;TZID=Europe/Warsaw:20260105T090000', 'DTEND;TZID=Europe/Warsaw:20260105T100000', 'RRULE:FREQ=DAILY;COUNT=20', 'SUMMARY:Plain'],
  exdate: ['DTSTART;TZID=Europe/Warsaw:20260105T090000', 'DTEND;TZID=Europe/Warsaw:20260105T100000', 'RRULE:FREQ=DAILY;COUNT=20', 'EXDATE;TZID=Europe/Warsaw:20260107T090000', 'SUMMARY:Exdate'],
  allday: ['DTSTART;VALUE=DATE:20260105', 'DTEND;VALUE=DATE:20260106', 'RRULE:FREQ=WEEKLY;COUNT=6', 'SUMMARY:Allday'],
  monthly: ['DTSTART;TZID=Europe/Warsaw:20260131T140000', 'DTEND;TZID=Europe/Warsaw:20260131T150000', 'RRULE:FREQ=MONTHLY;COUNT=8', 'SUMMARY:Monthly'],
  single: ['DTSTART;TZID=Europe/Warsaw:20260909T080000', 'DTEND;TZID=Europe/Warsaw:20260909T083000', 'SUMMARY:Single'],
  singleAllDay: ['DTSTART;VALUE=DATE:20260909', 'DTEND;VALUE=DATE:20260910', 'SUMMARY:SingleAllDay'],
  // A series whose description lives on the master: occurrences must inherit it rather than
  // store a copy of it per instance.
  inherited: ['DTSTART;TZID=Europe/Warsaw:20260105T090000', 'DTEND;TZID=Europe/Warsaw:20260105T100000', 'RRULE:FREQ=DAILY;COUNT=5', 'SUMMARY:Inherited', 'DESCRIPTION:Master text', 'LOCATION:Room 1'],
};

const EXCEPTIONS = {
  moved: ['BEGIN:VEVENT', 'UID:CASE', 'RECURRENCE-ID;TZID=Europe/Warsaw:20260112T090000', 'DTSTART;TZID=Europe/Warsaw:20260113T140000', 'DTEND;TZID=Europe/Warsaw:20260113T150000', 'SUMMARY:MovedInstance', 'END:VEVENT'],
  cancelled: ['BEGIN:VEVENT', 'UID:CASE', 'RECURRENCE-ID;TZID=Europe/Warsaw:20260107T090000', 'DTSTART;TZID=Europe/Warsaw:20260107T090000', 'DTEND;TZID=Europe/Warsaw:20260107T100000', 'STATUS:CANCELLED', 'SUMMARY:CancelledInstance', 'END:VEVENT'],
};
CASES.moved = CASES.plain;
CASES.cancelled = CASES.plain;

const WINDOW = { from: new Date('2026-01-01T00:00:00Z'), to: new Date('2026-12-01T00:00:00Z') };
// An explicit horizon rather than occurrenceHorizon(), which is anchored on the current date:
// a test whose fixtures live in a fixed month must not start failing once that month falls out
// of the rolling horizon.
const BUILT = { from: new Date('2026-01-01T00:00:00Z'), to: new Date('2027-01-01T00:00:00Z') };

// Only the fields the expansion consumes; the rest of the row is irrelevant to correctness.
function eventRow(raw, overrides = {}) {
  return {
    id: overrides.id, uid: 'CASE', raw_ical: raw, summary: overrides.summary ?? null,
    description: null, location: null, url: null, organizer: null, attendees: null,
    starts_at: new Date('2026-01-05T08:00:00Z'), ends_at: new Date('2026-01-05T09:00:00Z'), ...overrides,
  };
}

async function insertEvent(uid, raw, summary, { description = null, location = null } = {}) {
  const result = await query(
    `INSERT INTO calendar_events (calendar_id, user_id, uid, raw_ical, etag, summary, description, location, starts_at, ends_at, all_day, timezone)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,'Europe/Warsaw') RETURNING id`,
    [CALENDAR_ID, USER_ID, uid, raw, `etag-${uid}`, summary, description, location, new Date('2026-01-05T08:00:00Z'), new Date('2026-01-05T09:00:00Z')],
  );
  return result.rows[0].id;
}

async function storedOccurrences(eventId) {
  const result = await query(
    `SELECT o.starts_at, o.ends_at, o.all_day, COALESCE(o.summary, e.summary) AS summary,
            COALESCE(o.description, e.description) AS description, COALESCE(o.location, e.location) AS location
       FROM calendar_occurrences o JOIN calendar_events e ON e.id = o.event_id
      WHERE o.event_id = $1 AND o.starts_at < $3 AND o.ends_at > $2`,
    [eventId, WINDOW.from, WINDOW.to],
  );
  return result.rows
    .map(row => `${new Date(row.starts_at).toISOString()}|${new Date(row.ends_at).toISOString()}|${row.summary}|${row.all_day}|${row.description}|${row.location}`)
    .sort();
}

function liveOccurrences(eventId, raw, summary) {
  return projectCalendarResource(eventRow(raw, { id: eventId, summary }), WINDOW.from, WINDOW.to)
    .map(row => `${new Date(row.starts_at).toISOString()}|${new Date(row.ends_at).toISOString()}|${row.summary}|${row.all_day}|${row.description}|${row.location}`)
    .sort();
}

beforeAll(async () => {
  if (!hasPg) return;
  await query('DELETE FROM users WHERE id = $1', [USER_ID]);
  await query('INSERT INTO users (id, username, password_hash) VALUES ($1, $2, $3)', [USER_ID, `occurrence-${Date.now()}`, 'x']);
  await query('INSERT INTO calendars (id, user_id, owner_user_id, name) VALUES ($1,$2,$2,$3)', [CALENDAR_ID, USER_ID, 'Occurrences']);
});

afterEach(async () => {
  if (!hasPg) return;
  await query('DELETE FROM calendar_events WHERE user_id = $1', [USER_ID]);
});

afterAll(async () => {
  if (!hasPg) return;
  await query('DELETE FROM users WHERE id = $1', [USER_ID]);
  await pool.end();
});

describeOrSkip('materialised calendar occurrences', () => {
  // The invariant the whole design rests on: what is stored is what the live path would have
  // produced. If this fails, materialisation is silently showing a different calendar.
  it.each(Object.keys(CASES))('stores exactly what a live expansion of %s would produce', async name => {
    const raw = vcalendar(CASES[name], EXCEPTIONS[name] ?? []);
    const eventId = await insertEvent(`occ-${name}`, raw, name);
    await materializeEvent(eventId, BUILT);

    const stored = await storedOccurrences(eventId);
    expect(stored).toEqual(liveOccurrences(eventId, raw, name));
    expect(stored.length).toBeGreaterThan(0);
  });

  it('skips a cancelled instance but keeps the rest of the series', async () => {
    const raw = vcalendar(CASES.plain, EXCEPTIONS.cancelled);
    const eventId = await insertEvent('occ-cancel', raw, 'plain');
    await materializeEvent(eventId, BUILT);

    const stored = await storedOccurrences(eventId);
    expect(stored.some(entry => entry.includes('CancelledInstance'))).toBe(false);
    // COUNT=20 minus the cancelled day.
    expect(stored).toHaveLength(19);
  });

  it('moves an instance without disturbing its neighbours', async () => {
    const raw = vcalendar(CASES.plain, EXCEPTIONS.moved);
    const eventId = await insertEvent('occ-moved', raw, 'plain');
    await materializeEvent(eventId, BUILT);

    const stored = await storedOccurrences(eventId);
    expect(stored.filter(entry => entry.includes('MovedInstance'))).toHaveLength(1);
    expect(stored).toEqual(liveOccurrences(eventId, raw, 'plain'));
  });

  // Only genuine overrides are stored; a master description must not be copied onto every
  // occurrence, or a five-year daily series would multiply it hundreds of times.
  it('leaves inherited fields NULL rather than duplicating them per occurrence', async () => {
    const raw = vcalendar(CASES.inherited);
    // The denormalised columns are written from the same ICS in production, so the fixture
    // must match it: the point of the test is that an agreeing value is not duplicated.
    const eventId = await insertEvent('occ-inherit', raw, 'Inherited', { description: 'Master text', location: 'Room 1' });
    await materializeEvent(eventId, BUILT);

    const result = await query(
      'SELECT description, location FROM calendar_occurrences WHERE event_id = $1',
      [eventId],
    );
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.every(row => row.description === null && row.location === null)).toBe(true);
  });

  it('re-arms on any event write through the trigger, including raw CalDAV-style updates', async () => {
    const eventId = await insertEvent('occ-trigger', vcalendar(CASES.plain), 'plain');
    await materializeEvent(eventId, BUILT);
    expect((await query('SELECT dirty FROM calendar_occurrence_state WHERE event_id = $1', [eventId])).rows[0].dirty).toBe(false);

    // A raw_ical-only write is what CalDAV and the external sync perform.
    await query('UPDATE calendar_events SET raw_ical = replace(raw_ical, $2, $3), etag = $4 WHERE id = $1',
      [eventId, 'SUMMARY:Plain', 'SUMMARY:Renamed', 'etag-2']);
    expect((await query('SELECT dirty FROM calendar_occurrence_state WHERE event_id = $1', [eventId])).rows[0].dirty).toBe(true);

    await materializeEvent(eventId, BUILT);
    const stored = await storedOccurrences(eventId);
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.every(entry => entry.includes('Renamed'))).toBe(true);
  });

  // A build that finishes after the event changed underneath it must not clear the dirty flag.
  // Its stored rows describe the previous version, so clearing it would serve a calendar that
  // silently ignores the edit — the most damaging failure this design can have.
  it('does not clear the dirty flag when the event changed during the build', async () => {
    const eventId = await insertEvent('occ-race', vcalendar(CASES.plain), 'plain');
    await materializeEvent(eventId, BUILT);
    expect((await query('SELECT dirty FROM calendar_occurrence_state WHERE event_id = $1', [eventId])).rows[0].dirty).toBe(false);

    // The edit lands while a build is still running: it re-arms dirty, then the build's own
    // bookkeeping runs against the version it originally read. This calls the real recording
    // function rather than a copy of its SQL, so removing the etag guard fails this test.
    await query("UPDATE calendar_events SET etag = 'etag-new', raw_ical = replace(raw_ical, 'SUMMARY:Plain', 'SUMMARY:Edited') WHERE id = $1", [eventId]);
    await withTransaction(client => finalizeMaterialization(client, {
      eventId, horizon: BUILT, etag: 'etag-occ-race', truncated: false,
    }));

    // The stale build must refuse to declare itself current.
    expect((await query('SELECT dirty FROM calendar_occurrence_state WHERE event_id = $1', [eventId])).rows[0].dirty).toBe(true);

    // And a rebuild must pick the edit up.
    await materializeEvent(eventId, BUILT);
    const stored = await storedOccurrences(eventId);
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.every(entry => entry.includes('Edited'))).toBe(true);
    expect((await query('SELECT dirty FROM calendar_occurrence_state WHERE event_id = $1', [eventId])).rows[0].dirty).toBe(false);
  });

  it('queues a new event and drains it through the scheduler pass', async () => {
    await insertEvent('occ-queued', vcalendar(CASES.plain), 'plain');
    const summary = await materializePendingOccurrences({ limit: 50 });
    expect(summary.processed).toBeGreaterThan(0);
    const remaining = await query('SELECT count(*)::int n FROM calendar_occurrence_state WHERE user_id = $1 AND dirty', [USER_ID]);
    expect(remaining.rows[0].n).toBe(0);
  });

  // The read path must treat an uncovered window as "use the live path", never as "no events".
  it('reports a window outside the built horizon as uncovered', async () => {
    const eventId = await insertEvent('occ-horizon', vcalendar(CASES.plain), 'plain');
    // A deliberately narrow horizon that cannot contain the series.
    await materializeEvent(eventId, { from: new Date('2026-01-01T00:00:00Z'), to: new Date('2026-02-01T00:00:00Z') });

    const outside = await query(
      `SELECT 1 FROM calendar_occurrence_state s WHERE s.event_id = $1 AND NOT ${coveragePredicate('s')}`,
      [eventId, WINDOW.from, WINDOW.to],
    );
    expect(outside.rows).toHaveLength(0);
  });

  it('keeps the horizon covering both the recent past and the foreseeable future', () => {
    const { from, to } = occurrenceHorizon(new Date('2026-09-11T12:00:00Z'));
    expect(from.getTime()).toBeLessThan(new Date('2026-09-11T00:00:00Z').getTime());
    expect(to.getTime()).toBeGreaterThan(new Date('2027-09-01T00:00:00Z').getTime());
  });
});
