import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  CALENDAR_VIEW_DEFAULT, CALENDAR_VIEW_STORAGE_KEY, CALENDAR_VIEWS,
  normalizeCalendarView, readStoredCalendarView, storeCalendarView,
} from './calendarPreferences.js';

function stubStorage({ throwOnUse = false } = {}) {
  const store = new Map();
  globalThis.localStorage = {
    getItem: key => {
      if (throwOnUse) throw new Error('storage blocked');
      return store.has(key) ? store.get(key) : null;
    },
    setItem: (key, value) => {
      if (throwOnUse) throw new Error('storage blocked');
      store.set(key, String(value));
    },
    removeItem: key => store.delete(key),
    clear: () => store.clear(),
  };
  return store;
}

describe('calendar view preference', () => {
  beforeEach(() => { stubStorage(); });

  it('accepts every view the calendar offers', () => {
    assert.deepEqual(CALENDAR_VIEWS, ['month', 'week', 'workweek', 'agenda']);
    for (const view of CALENDAR_VIEWS) assert.equal(normalizeCalendarView(view), view);
  });

  it('falls back to the default for anything unknown', () => {
    for (const value of ['year', '', null, undefined, 42, {}, []]) {
      assert.equal(normalizeCalendarView(value), CALENDAR_VIEW_DEFAULT);
    }
  });

  it('remembers the view so leaving the calendar and returning keeps it', () => {
    // The page unmounts when the user goes back to the mailbox, so the choice has to
    // survive outside the component.
    assert.equal(readStoredCalendarView(), CALENDAR_VIEW_DEFAULT);
    assert.equal(storeCalendarView('workweek'), 'workweek');
    assert.equal(readStoredCalendarView(), 'workweek');
    assert.equal(globalThis.localStorage.getItem(CALENDAR_VIEW_STORAGE_KEY), 'workweek');
  });

  it('never stores an invalid view', () => {
    assert.equal(storeCalendarView('decade'), CALENDAR_VIEW_DEFAULT);
    assert.equal(readStoredCalendarView(), CALENDAR_VIEW_DEFAULT);
  });

  it('survives a storage that throws', () => {
    // Private mode or disabled cookies must not stop the calendar from opening.
    stubStorage({ throwOnUse: true });
    assert.equal(readStoredCalendarView(), CALENDAR_VIEW_DEFAULT);
    assert.equal(storeCalendarView('agenda'), 'agenda');
  });
});
