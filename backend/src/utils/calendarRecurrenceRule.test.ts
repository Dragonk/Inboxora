import { describe, expect, it } from 'vitest';
import { parseRecurrenceInput, recurrenceViewFromRRule } from './calendarRecurrenceRule.js';

function mustParse(value: unknown, allDay = false): string | null {
  const result = parseRecurrenceInput(value, { allDay });
  if (!result.ok) throw new Error(`expected a valid rule, got: ${result.error}`);
  return result.rrule;
}

describe('parseRecurrenceInput', () => {
  it('treats a missing or explicitly none rule as a single event', () => {
    expect(mustParse(undefined)).toBeNull();
    expect(mustParse(null)).toBeNull();
    expect(mustParse({ frequency: 'none' })).toBeNull();
  });

  it('renders the supported frequencies', () => {
    expect(mustParse({ frequency: 'daily' })).toBe('FREQ=DAILY');
    expect(mustParse({ frequency: 'weekly' })).toBe('FREQ=WEEKLY');
    expect(mustParse({ frequency: 'monthly' })).toBe('FREQ=MONTHLY');
    expect(mustParse({ frequency: 'yearly' })).toBe('FREQ=YEARLY');
  });

  it('includes a non-default interval and sorted weekdays', () => {
    expect(mustParse({ frequency: 'weekly', interval: 2, byWeekday: [5, 1, 1] })).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR');
  });

  it('renders COUNT and UNTIL, with a date-valued UNTIL for an all-day series', () => {
    expect(mustParse({ frequency: 'daily', count: 5 })).toBe('FREQ=DAILY;COUNT=5');
    expect(mustParse({ frequency: 'daily', until: '2026-12-31' })).toBe('FREQ=DAILY;UNTIL=20261231T000000Z');
    expect(mustParse({ frequency: 'daily', until: '2026-12-31' }, true)).toBe('FREQ=DAILY;UNTIL=20261231');
  });

  it('rejects an unknown frequency, field, interval or weekday', () => {
    for (const value of [
      { frequency: 'hourly' },
      { frequency: 'daily', byDay: 'MO' },
      { frequency: 'daily', interval: 0 },
      { frequency: 'daily', interval: 1.5 },
      { frequency: 'weekly', byWeekday: [7] },
      { frequency: 'weekly', byWeekday: [] },
      { frequency: 'monthly', byWeekday: [1] },
      { frequency: 'daily', count: 0 },
      { frequency: 'daily', count: 100000 },
      { frequency: 'daily', count: 3, until: '2026-01-01' },
      { frequency: 'daily', until: 'not-a-date' },
      'FREQ=DAILY',
      [],
    ]) {
      expect(parseRecurrenceInput(value, { allDay: false }).ok).toBe(false);
    }
  });

  it('rejects an until date that is not a real calendar day for an all-day series', () => {
    expect(parseRecurrenceInput({ frequency: 'daily', until: '2026-02-30' }, { allDay: true }).ok).toBe(false);
  });
});

describe('recurrenceViewFromRRule', () => {
  it('round-trips a rule this editor rendered', () => {
    const rrule = mustParse({ frequency: 'weekly', interval: 3, byWeekday: [1, 3], count: 8 });
    const view = recurrenceViewFromRRule(rrule);
    expect(view).toMatchObject({ frequency: 'weekly', interval: 3, byWeekday: [1, 3], count: 8, until: null, custom: false });
  });

  it('parses an UNTIL value back', () => {
    const view = recurrenceViewFromRRule('FREQ=DAILY;UNTIL=20261231T000000Z');
    expect(view).toMatchObject({ frequency: 'daily', until: '20261231T000000Z', count: null, custom: false });
  });

  it('flags a foreign rule as custom so the editor keeps it untouched', () => {
    const view = recurrenceViewFromRRule('FREQ=MONTHLY;BYDAY=2MO;BYSETPOS=1');
    expect(view?.custom).toBe(true);
    expect(view?.raw).toBe('FREQ=MONTHLY;BYDAY=2MO;BYSETPOS=1');
  });

  it('returns null for no rule', () => {
    expect(recurrenceViewFromRRule(null)).toBeNull();
    expect(recurrenceViewFromRRule('')).toBeNull();
  });
});
