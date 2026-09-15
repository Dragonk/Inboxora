import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  CALENDAR_VIEW_DEFAULT, CALENDAR_VIEW_STORAGE_KEY, CALENDAR_VIEWS,
  normalizeCalendarView, readStoredCalendarView, storeCalendarView,
} from './calendarPreferences.ts';

type StorageStubOptions = {
  throwOnUse?: boolean;
};

function stubStorage({ throwOnUse = false }: StorageStubOptions = {}) {
  const store = new Map<string, string>();
  Reflect.set(globalThis, 'localStorage', {
    getItem: (key: string): string | null => {
      if (throwOnUse) throw new Error('storage blocked');
      const value = store.get(key);
      return typeof value === 'string' ? value : null;
    },
    setItem: (key: string, value: string): void => {
      if (throwOnUse) throw new Error('storage blocked');
      store.set(key, value);
    },
    removeItem: (key: string): void => { store.delete(key); },
    clear: (): void => { store.clear(); },
  });
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
