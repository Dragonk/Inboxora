import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ create: vi.fn(), patch: vi.fn(), remove: vi.fn() }));

vi.mock('./graphCalendar.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./graphCalendar.js')>()),
  createGraphEvent: mocks.create,
  patchGraphEvent: mocks.patch,
  deleteGraphEvent: mocks.remove,
}));

import { GraphApiError } from './graphApiClient.js';
import { graphCalendarEventMutationAdapter, graphEventPayloadFor, graphRecurrenceFromStructure } from './graphCalendarWrites.js';
import type { LocalEventWriteInput } from './graphCalendarWrites.js';
import type { ParsedRecurrence } from '../../../utils/calendarRecurrenceRule.js';

const api = { userId: 'user-1', connectionId: 'connection-1' };
const adapter = () => graphCalendarEventMutationAdapter({ api });

const event = (overrides: Partial<LocalEventWriteInput> = {}): LocalEventWriteInput => ({
  summary: 'Standup',
  description: 'Daily sync',
  location: 'Room 1',
  url: null,
  startsAt: new Date('2026-09-01T09:00:00.000Z'),
  endsAt: new Date('2026-09-01T09:30:00.000Z'),
  allDay: false,
  attendees: ['a@example.test', 'b@example.test'],
  recurrence: null,
  ...overrides,
});

const weekly: ParsedRecurrence = {
  frequency: 'weekly', interval: 2, byWeekday: [1, 3], until: null, untilIcal: null, count: 4,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockResolvedValue({ id: 'AAMkAD-evt-1', iCalUId: 'standup@contoso.test' });
  mocks.patch.mockResolvedValue({ id: 'AAMkAD-evt-1' });
  mocks.remove.mockResolvedValue(undefined);
});

describe('a local event becomes a Graph event payload', () => {
  it('sends the instant as UTC wall time and maps the fields Graph has', () => {
    const payload = graphEventPayloadFor(event(), 'intent-1');
    expect(payload).toMatchObject({
      subject: 'Standup',
      start: { dateTime: '2026-09-01T09:00:00', timeZone: 'UTC' },
      end: { dateTime: '2026-09-01T09:30:00', timeZone: 'UTC' },
      body: { contentType: 'Text', content: 'Daily sync' },
      location: { displayName: 'Room 1' },
      transactionId: 'intent-1',
    });
    expect(payload.attendees?.map(attendee => attendee.emailAddress?.address)).toEqual(['a@example.test', 'b@example.test']);
  });

  it('marks an all-day event and never invents a zone-specific wall time', () => {
    const payload = graphEventPayloadFor(event({ allDay: true }));
    expect(payload.isAllDay).toBe(true);
    expect(payload.start.timeZone).toBe('UTC');
  });
});

describe('a local recurrence becomes a Graph pattern and range', () => {
  it('maps a weekly rule with its interval, days and occurrence count', () => {
    expect(graphRecurrenceFromStructure(weekly, event().startsAt)).toEqual({
      pattern: { type: 'weekly', interval: 2, daysOfWeek: ['monday', 'wednesday'], firstDayOfWeek: 'sunday' },
      range: { type: 'numbered', numberOfOccurrences: 4, startDate: '2026-09-01' },
    });
  });

  it('repeats on the start’s own weekday when the rule names none', () => {
    // 2026-09-01 is a Tuesday; an RRULE without BYDAY means exactly that.
    const structure: ParsedRecurrence = { ...weekly, byWeekday: [], count: null };
    const built = graphRecurrenceFromStructure(structure, event().startsAt);
    expect(built.pattern.daysOfWeek).toEqual(['tuesday']);
    expect(built.range).toEqual({ type: 'noEnd', startDate: '2026-09-01' });
  });

  it('maps monthly and yearly rules onto the start’s own day', () => {
    const monthly = graphRecurrenceFromStructure({ ...weekly, frequency: 'monthly', byWeekday: [], count: 3 }, event().startsAt);
    expect(monthly.pattern).toMatchObject({ type: 'absoluteMonthly', dayOfMonth: 1 });
    const yearly = graphRecurrenceFromStructure({ ...weekly, frequency: 'yearly', byWeekday: [], count: 2 }, event().startsAt);
    expect(yearly.pattern).toMatchObject({ type: 'absoluteYearly', month: 9, dayOfMonth: 1 });
  });

  it('ends on the validated until date', () => {
    const built = graphRecurrenceFromStructure({ ...weekly, count: null, until: '2026-12-31', untilIcal: '20261231T235959Z' }, event().startsAt);
    expect(built.range).toEqual({ type: 'endDate', endDate: '2026-12-31', startDate: '2026-09-01' });
  });
});

describe('a Graph calendar write reports what actually happened', () => {
  it('creates with an idempotency transaction id and reports the provider id', async () => {
    const outcome = await adapter().perform(
      { operation: 'create', calendarId: 'cal-1', event: event(), transactionId: 'intent-1' },
      { operationId: 'op', signal: new AbortController().signal },
    );
    expect(outcome).toMatchObject({ status: 'committed', value: { event: { id: 'AAMkAD-evt-1' } } });
    expect(mocks.create).toHaveBeenCalledWith(api, 'cal-1', expect.objectContaining({ transactionId: 'intent-1' }));
  });

  it('refuses to call a create without an identity committed', async () => {
    mocks.create.mockResolvedValueOnce({});
    const outcome = await adapter().perform(
      { operation: 'create', calendarId: 'cal-1', event: event() },
      { operationId: 'op', signal: new AbortController().signal },
    );
    expect(outcome).toEqual({ status: 'outcome_unknown', code: 'EVENT_ID_MISSING' });
  });

  it('classifies a throttle as retryable and a 404 as permanent', async () => {
    mocks.patch.mockRejectedValueOnce(new GraphApiError({ code: 'RATE_LIMITED', message: 'slow', status: 429, retryable: true, retryAfterSeconds: 5 }));
    await expect(adapter().perform(
      { operation: 'update', calendarId: 'cal-1', eventId: 'AAMkAD-evt-1', event: event() },
      { operationId: 'op', signal: new AbortController().signal },
    )).resolves.toEqual({ status: 'retryable', code: 'RATE_LIMITED', retryAfterSeconds: 5 });

    mocks.remove.mockRejectedValueOnce(new GraphApiError({ code: 'RESOURCE_NOT_FOUND', message: 'gone', status: 404 }));
    await expect(adapter().perform(
      { operation: 'delete', calendarId: 'cal-1', eventId: 'AAMkAD-evt-1' },
      { operationId: 'op', signal: new AbortController().signal },
    )).resolves.toEqual({ status: 'permanent', code: 'RESOURCE_NOT_FOUND' });
  });

  it('never reports an ambiguous network failure as a refusal, and is not re-runnable', async () => {
    mocks.patch.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(adapter().perform(
      { operation: 'update', calendarId: 'cal-1', eventId: 'AAMkAD-evt-1', event: event() },
      { operationId: 'op', signal: new AbortController().signal },
    )).resolves.toEqual({ status: 'outcome_unknown', code: 'MUTATION_OUTCOME_UNKNOWN' });
    expect(adapter().idempotent).toBe(false);
    expect(adapter().resourceType).toBe('calendar_event');
  });
});
