import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDayEventsResolver, centeredScrollLeft, eventPayload, eventsForDay, layoutTimedEvents, monthRange, shiftCalendarAnchor, sortedDayEvents, toggleAllDayTimes, weekFocusIndex, weekRange } from './calendarView.js';

describe('calendar desktop helpers', () => {
  it('returns an exclusive month range', () => {
    const { start, end } = monthRange(new Date(2026, 8, 14));
    assert.deepEqual([start.getFullYear(), start.getMonth(), start.getDate()], [2026, 8, 1]);
    assert.deepEqual([end.getFullYear(), end.getMonth(), end.getDate()], [2026, 9, 1]);
  });
  it('returns Monday through Sunday for a weekly range', () => {
    const { start, end } = weekRange(new Date(2026, 8, 16));
    assert.deepEqual([start.getDay(), start.getDate()], [1, 14]);
    assert.deepEqual([end.getDay(), end.getDate()], [1, 21]);
  });
  it('honours Sunday as the selected first day of week', () => {
    const { start, end } = weekRange(new Date(2026, 8, 16), 0);
    assert.deepEqual([start.getDay(), start.getDate()], [0, 13]);
    assert.deepEqual([end.getDay(), end.getDate()], [0, 20]);
  });
  it('clamps month navigation to the target month instead of skipping February', () => {
    const forward = shiftCalendarAnchor(new Date(2026, 0, 31), 'month', 1);
    const backward = shiftCalendarAnchor(new Date(2026, 2, 31), 'month', -1);
    assert.deepEqual([forward.getFullYear(), forward.getMonth(), forward.getDate()], [2026, 1, 28]);
    assert.deepEqual([backward.getFullYear(), backward.getMonth(), backward.getDate()], [2026, 1, 28]);
  });
  it('rejects invalid event ranges before calling the API', () => {
    assert.equal(eventPayload({ calendarId: 'one', startsAt: '2026-09-10T10:00', endsAt: '2026-09-10T09:00', summary: '', description: '', location: '', url: '', organizer: '' }), null);
    assert.equal(eventPayload({ calendarId: 'one', startsAt: '2026-09-10T10:00', endsAt: '2026-09-10T10:00', summary: '', description: '', location: '', url: '', organizer: '' }), null);
  });
  it('requires a sender account and recipients when invitations are enabled', () => {
    const base = { calendarId: 'one', startsAt: '2026-09-10T10:00', endsAt: '2026-09-10T11:00', summary: 'Planning', description: '', location: '', url: '', organizer: '', sendInvites: true, attendees: ['guest@example.test'] };
    assert.equal(eventPayload(base), null);
    assert.equal(eventPayload({ ...base, inviteAccountId: 'account-1', attendees: [] }), null);
    assert.deepEqual(eventPayload({ ...base, inviteAccountId: 'account-1' }).attendees, ['guest@example.test']);
  });
  it('converts date field values when toggling all-day mode', () => {
    const timed = { allDay: false, startsAt: '2026-09-10T09:30', endsAt: '2026-09-10T10:30' };
    assert.deepEqual(toggleAllDayTimes(timed, true), { ...timed, allDay: true, startsAt: '2026-09-10', endsAt: '2026-09-10' });
    assert.deepEqual(toggleAllDayTimes({ ...timed, allDay: true, startsAt: '2026-09-10', endsAt: '2026-09-11' }, false), { ...timed, allDay: false, startsAt: '2026-09-10T00:00', endsAt: '2026-09-11T00:00' });
  });
  it('preserves selected all-day dates as UTC date boundaries', () => {
    const payload = eventPayload({ calendarId: 'one', allDay: true, startsAt: '2026-09-10', endsAt: '2026-09-11', summary: '', description: '', location: '', url: '', organizer: '' });
    assert.equal(payload.startsAt, '2026-09-10T00:00:00.000Z');
    assert.equal(payload.endsAt, '2026-09-11T00:00:00.000Z');
  });
  it('keeps an all-day event on its selected local calendar day west of UTC', () => {
    const originalTimeZone = globalThis.process.env.TZ;
    globalThis.process.env.TZ = 'America/Los_Angeles';
    try {
      const event = { all_day: true, starts_at: '2026-09-10T00:00:00.000Z', ends_at: '2026-09-11T00:00:00.000Z' };
      assert.equal(eventsForDay([event], new Date(2026, 8, 9)).length, 0);
      assert.equal(eventsForDay([event], new Date(2026, 8, 10)).length, 1);
    } finally {
      globalThis.process.env.TZ = originalTimeZone;
    }
  });
  it('includes local multi-day events in each overlapped day', () => {
    const event = { starts_at: '2026-09-10T22:00:00', ends_at: '2026-09-11T02:00:00' };
    assert.equal(eventsForDay([event], new Date(2026, 8, 10)).length, 1);
    assert.equal(eventsForDay([event], new Date(2026, 8, 11)).length, 1);
  });
});

describe('calendar timed-event layout', () => {
  const day = new Date(2026, 8, 14);
  const timed = (id, start, end) => ({ id, starts_at: `2026-09-14T${start}:00`, ends_at: `2026-09-14T${end}:00` });

  it('is deterministic for the same input', () => {
    const events = [timed('a', '09:00', '11:00'), timed('b', '10:00', '12:00'), timed('c', '10:00', '12:00')];
    const first = layoutTimedEvents(events, day).map(item => [item.event.id, item.column, item.columns]);
    const second = layoutTimedEvents(events, day).map(item => [item.event.id, item.column, item.columns]);
    assert.deepEqual(first, second);
  });

  it('gives identical intervals distinct columns but a shared collision width', () => {
    const laidOut = layoutTimedEvents([timed('a', '09:00', '10:00'), timed('b', '09:00', '10:00'), timed('c', '09:00', '10:00')], day);
    assert.deepEqual(laidOut.map(item => [item.event.id, item.column, item.columns]), [['a', 0, 3], ['b', 1, 3], ['c', 2, 3]]);
  });

  it('does not treat touching intervals as overlapping', () => {
    const laidOut = layoutTimedEvents([timed('a', '09:00', '10:00'), timed('b', '10:00', '11:00')], day);
    assert.deepEqual(laidOut.map(item => [item.event.id, item.column, item.columns]), [['a', 0, 1], ['b', 0, 1]]);
  });

  it('reports the peak concurrency for each event, not the whole cluster', () => {
    // a overlaps b and c; b and c never overlap each other.
    const laidOut = layoutTimedEvents([timed('a', '09:00', '13:00'), timed('b', '09:00', '10:00'), timed('c', '12:00', '13:00')], day);
    assert.deepEqual(laidOut.map(item => [item.event.id, item.column, item.columns]), [['a', 0, 2], ['b', 1, 2], ['c', 1, 2]]);
  });

  it('lays out a large fully overlapping set without the previous cubic cost', () => {
    const events = Array.from({ length: 1000 }, (_, index) => timed(`m${index}`, '10:00', '11:00'));
    const started = Date.now();
    const laidOut = layoutTimedEvents(events, day);
    const elapsed = Date.now() - started;
    assert.equal(laidOut.length, 1000);
    assert.equal(laidOut[0].columns, 1000);
    assert.equal(Math.max(...laidOut.map(item => item.column)), 999);
    // Generous bound: the previous implementation took hundreds of milliseconds
    // for this shape, so this only guards against reintroducing that order.
    assert.ok(elapsed < 500, `expected < 500ms, took ${elapsed}ms`);
  });
});

describe('calendar day event index', () => {
  const collect = (events, day) => sortedDayEvents([...events], day).map(event => event.id);

  it('matches the direct scan for mixed timed, all-day and multi-day events', () => {
    const events = [
      { id: 'timed', starts_at: '2026-09-14T09:00:00', ends_at: '2026-09-14T10:00:00' },
      { id: 'spanning', starts_at: '2026-09-13T22:00:00', ends_at: '2026-09-14T02:00:00' },
      { id: 'all-day', all_day: true, starts_at: '2026-09-14', ends_at: '2026-09-15' },
      { id: 'all-day-multi', all_day: true, starts_at: '2026-09-13', ends_at: '2026-09-16' },
      { id: 'other', starts_at: '2026-09-20T09:00:00', ends_at: '2026-09-20T10:00:00' },
    ];
    const resolve = createDayEventsResolver(events);
    for (let offset = 12; offset <= 16; offset += 1) {
      const day = new Date(2026, 8, offset);
      assert.deepEqual(resolve(day).map(event => event.id), collect(events, day), `day ${offset}`);
    }
  });

  it('orders all-day events before timed events and ties by id', () => {
    const events = [
      { id: 'z-timed', starts_at: '2026-09-14T08:00:00', ends_at: '2026-09-14T09:00:00' },
      { id: 'b-all-day', all_day: true, starts_at: '2026-09-14', ends_at: '2026-09-15' },
      { id: 'a-timed', starts_at: '2026-09-14T08:00:00', ends_at: '2026-09-14T09:00:00' },
      { id: 'a-all-day', all_day: true, starts_at: '2026-09-14', ends_at: '2026-09-15' },
    ];
    const resolved = createDayEventsResolver(events)(new Date(2026, 8, 14)).map(event => event.id);
    assert.deepEqual(resolved, ['a-all-day', 'b-all-day', 'a-timed', 'z-timed']);
    assert.deepEqual(resolved, collect(events, new Date(2026, 8, 14)));
  });
});

describe('week grid focus and centring', () => {
  const week = Array.from({ length: 7 }, (_, index) => new Date(2026, 8, 7 + index)); // Mon 7 → Sun 13 Sep

  it('focuses today when the shown week contains it', () => {
    assert.equal(weekFocusIndex(week, new Date(2026, 8, 7), new Date(2026, 8, 10)), 3);
    assert.equal(weekFocusIndex(week, new Date(2026, 8, 7), new Date(2026, 8, 7)), 0);
    assert.equal(weekFocusIndex(week, new Date(2026, 8, 7), new Date(2026, 8, 13)), 6);
  });

  it('falls back to the selected day when today is in another week', () => {
    // Anchored on a later week, so today is nowhere in view: the anchor leads instead.
    const later = Array.from({ length: 7 }, (_, index) => new Date(2026, 8, 21 + index));
    assert.equal(weekFocusIndex(later, new Date(2026, 8, 24), new Date(2026, 8, 10)), 3);
  });

  it('reports nothing to focus for a work-week that excludes a weekend anchor', () => {
    // Mon 7 → Fri 11 September, which is what a work-week view renders.
    const workWeek = Array.from({ length: 5 }, (_, offset) => new Date(2026, 8, 7 + offset));
    // Today is Saturday and the anchor is that same Saturday, so neither is in view.
    assert.equal(workWeek.at(-1).toDateString(), 'Fri Sep 11 2026');
    assert.equal(weekFocusIndex(workWeek, new Date(2026, 8, 12), new Date(2026, 8, 12)), -1);
  });

  it('handles an empty or missing day list', () => {
    assert.equal(weekFocusIndex([], new Date(2026, 8, 7)), -1);
    assert.equal(weekFocusIndex(null, new Date(2026, 8, 7)), -1);
    assert.equal(weekFocusIndex(week, null, new Date(2026, 9, 1)), -1);
  });

  it('centres a column in the viewport', () => {
    // Column 3 of a phone-width week grid: 52px axis, 150px columns, 390px viewport.
    // Its centre (502 + 75) goes to the middle of the viewport (195), so 382.
    const columnStart = 52 + 3 * 150;
    assert.equal(centeredScrollLeft({ columnStart, columnWidth: 150, viewportWidth: 390, contentWidth: 1102 }), 382);
  });

  it('clamps to the scrollable range instead of overscrolling past either edge', () => {
    // Monday sits at the left edge and cannot be centred, so it lands on 0.
    assert.equal(centeredScrollLeft({ columnStart: 52, columnWidth: 150, viewportWidth: 390, contentWidth: 1102 }), 0);
    // Sunday sits at the right edge and is pinned to the maximum scroll.
    assert.equal(centeredScrollLeft({ columnStart: 52 + 6 * 150, columnWidth: 150, viewportWidth: 390, contentWidth: 1102 }), 712);
  });

  it('leaves a grid that already fits exactly where it is', () => {
    // Desktop: the columns share the width, so there is nothing to scroll.
    assert.equal(centeredScrollLeft({ columnStart: 200, columnWidth: 180, viewportWidth: 1200, contentWidth: 1200 }), 0);
  });

  it('returns 0 rather than NaN for unmeasurable geometry', () => {
    assert.equal(centeredScrollLeft({ columnStart: NaN, columnWidth: 150, viewportWidth: 390, contentWidth: 1102 }), 0);
    assert.equal(centeredScrollLeft({}), 0);
  });
});
