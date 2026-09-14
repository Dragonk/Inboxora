import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it, afterEach, mock } from 'node:test';

import { api, isAbortError } from '../utils/api.ts';

const read = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');

afterEach(() => { mock.restoreAll(); });

describe('calendar request cancellation', () => {
  it('classifies an abort as a cancellation rather than a failure', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    assert.equal(isAbortError(abort), true);
    assert.equal(isAbortError({ code: 20 }), true);
    assert.equal(isAbortError(new Error('boom')), false);
    assert.equal(isAbortError(null), false);
    assert.equal(isAbortError(undefined), false);
  });

  it('forwards an AbortSignal to the events request', async () => {
    const controller = new AbortController();
    let seen: { url: string; options: RequestInit } | undefined;
    const fetchStub = async (url: string, options: RequestInit) => {
      seen = { url, options };
      return { ok: true, status: 200, json: async () => ({ events: [] }) };
    };
    mock.method(globalThis, 'fetch', fetchStub);
    await api.calendar.listEvents('2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', { signal: controller.signal });
    assert.ok(seen);
    assert.equal(seen.options.signal, controller.signal);
    assert.match(seen.url, /^\/api\/calendar\/events\?/);
    assert.match(seen.url, /from=2026-09-01/);
  });

  it('sends the flat calendar selection and keeps an empty selection explicit', async () => {
    const urls: string[] = [];
    const fetchStub = async (url: string) => {
      urls.push(url);
      return { ok: true, status: 200, json: async () => ({ events: [] }) };
    };
    mock.method(globalThis, 'fetch', fetchStub);
    await api.calendar.listEvents('2026-09-01', '2026-10-01', { calendarIds: ['cal-a', 'cal-b'] });
    await api.calendar.listEvents('2026-09-01', '2026-10-01', { calendarIds: [] });
    await api.calendar.listEvents('2026-09-01', '2026-10-01');
    assert.match(urls[0], /calendarIds=cal-a%2Ccal-b/);
    // An explicitly empty selection must still be transmitted (empty = none),
    // which is different from omitting the parameter (absent = every calendar).
    assert.match(urls[1], /calendarIds=(&|$)/);
    assert.doesNotMatch(urls[2], /calendarIds/);
  });

  it('propagates a fetch abort untouched so callers can ignore it', async () => {
    const fetchStub = async () => {
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      throw error;
    };
    mock.method(globalThis, 'fetch', fetchStub);
    await assert.rejects(
      () => api.calendar.listEvents('2026-09-01', '2026-10-01'),
      error => isAbortError(error),
    );
  });
});

describe('calendar page cancellation and render contract', () => {
  const source = read('CalendarPage.tsx');

  it('aborts the previous load and invalidates its generation', () => {
    assert.match(source, /const controller = new AbortController\(\)/);
    assert.match(source, /abortRef\.current\?\.abort\(\)/);
    assert.match(source, /loadGeneration\.current \+= 1/);
    assert.match(source, /controller\.signal/);
  });

  it('cancels in-flight work on unmount through the effect cleanup', () => {
    assert.match(source, /return \(\) => \{ loadGeneration\.current \+= 1; abortRef\.current\?\.abort\(\); abortRef\.current = null; \};/);
  });

  it('never reports an aborted load as a user-visible error', () => {
    assert.match(source, /if \(!isAbortError\(err\) && generation === loadGeneration\.current\)/);
  });

  it('subscribes to individual store fields instead of the whole store', () => {
    assert.match(source, /useStore\(\(state: StoreState\) => state\.visibleCalendarIds\)/);
    assert.match(source, /useStore\(\(state: StoreState\) => state\.setVisibleCalendarIds\)/);
    assert.doesNotMatch(source, /useStore\(\)/);
  });

  it('sends the selection to the server while keeping the client-side filter', () => {
    assert.match(source, /selectionKey/);
    assert.match(source, /calendarIds/);
    assert.match(source, /visibleCalendarIds\.includes\(event\.calendar_id\)/);
  });

  it('marks a partial result instead of presenting it as complete', () => {
    assert.match(source, /setIncompleteSeries/);
    assert.match(source, /data-testid="calendar-incomplete"/);
  });

  it('builds the per-day index once per event list', () => {
    assert.match(source, /useMemo\(\(\) => createDayEventsResolver\(visibleEvents\), \[visibleEvents\]\)/);
    assert.doesNotMatch(source, /sortedDayEvents\(events, day\)/);
  });
});

describe('backend partial-result contract', () => {
  it('returns an explicit truncation marker and never silently shortens the list', () => {
    const source = readFileSync(new URL('../../../backend/src/routes/calendar.ts', import.meta.url), 'utf8');
    assert.match(source, /incompleteSeries/);
    assert.match(source, /truncated: true/);
    assert.match(source, /projectCalendarResources\(eventRows, from, to/);
  });
});
