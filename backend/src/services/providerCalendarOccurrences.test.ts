import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The scoped-occurrence engine, exercised against faked provider adapters with the real payload builders.
 *
 * The cases cover what a user does to a series — change or cancel one occurrence, change or cancel the rest of
 * one — for both providers, and they assert the two things that would otherwise be silently wrong: the
 * occurrence is addressed by the id the **provider's instance listing** returned, and a "this and following"
 * operation truncates the master and (for an edit) creates the remainder rather than rewriting the series.
 */

const mocks = vi.hoisted(() => ({
  google: {
    instances: vi.fn(),
    get: vi.fn(),
    insert: vi.fn(),
    patch: vi.fn(),
    remove: vi.fn(),
    listEvents: vi.fn(),
  },
  graph: {
    instances: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    patch: vi.fn(),
    remove: vi.fn(),
    listEvents: vi.fn(),
  },
}));

/**
 * The stages the journal would hand an adapter that is resuming a recovered operation (CAL-01).
 *
 * Set by the case that needs it; the production call site builds this inside `runProviderMutation` from the claim.
 */
const injected = { progress: [] as Array<{ stage: string; detail?: unknown }> };
const recordProgress = vi.fn(async () => {});

vi.mock('./providerMutationService.js', () => ({
  // Run the real adapter's `perform` and translate its outcome the way the journal does, so the engine's
  // classification is exercised without a database.
  runProviderMutation: async (input: { payload: unknown }, adapter: { perform: (write: unknown, context?: unknown) => Promise<{ status: string; value?: unknown; code?: string }> }) => {
    const outcome = await adapter.perform(input.payload, {
      operationId: 'op-1',
      signal: new AbortController().signal,
      recordProgress,
      progress: injected.progress,
    }) as { status: string; value?: unknown; code?: string; retryAfterSeconds?: number };
    return outcome.status === 'committed'
      ? { status: 'confirmed', value: outcome.value }
      : {
        status: outcome.status,
        ...(outcome.code ? { code: outcome.code } : {}),
        ...(outcome.retryAfterSeconds !== undefined ? { retryAfterSeconds: outcome.retryAfterSeconds } : {}),
      };
  },
}));
vi.mock('./providers/google/googleCalendar.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./providers/google/googleCalendar.js')>()),
  fetchGoogleEventInstances: mocks.google.instances,
  fetchCalendarEvents: mocks.google.listEvents,
  fetchGoogleEvent: mocks.google.get,
  insertGoogleEvent: mocks.google.insert,
  patchGoogleEvent: mocks.google.patch,
  deleteGoogleEvent: mocks.google.remove,
}));
vi.mock('./providers/microsoft/graphCalendar.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./providers/microsoft/graphCalendar.js')>()),
  fetchGraphEventInstances: mocks.graph.instances,
  fetchGraphEvent: mocks.graph.get,
  createGraphEvent: mocks.graph.create,
  listGraphCalendarEvents: mocks.graph.listEvents,
  patchGraphEvent: mocks.graph.patch,
  deleteGraphEvent: mocks.graph.remove,
}));

import { GoogleApiError } from './providers/google/googleApiClient.js';
import {
  occurrenceInstant,
  resolveProviderOccurrenceId,
  continueRruleAfterSplit,
  occurrencesBeforeRule,
  truncateRRuleBefore,
  writeProviderCalendarOccurrence,
  type ProviderOccurrenceTarget,
} from './providerCalendarOccurrences.js';

// The stages a resumed adapter is handed are per-test state: a case that sets them must not leak the record into
// the next one, which would make that case look like a resumed run and skip its writes.
beforeEach(() => { injected.progress = []; });

const GOOGLE_MASTER = 'google-master-1';
const GRAPH_MASTER = 'AAMkAD-master-1';
const OCCURRENCE = '2026-09-15T09:00:00.000Z';

const googleTarget: ProviderOccurrenceTarget = {
  kind: 'google', userId: 'user-1', connectionId: 'connection-1', collectionId: 'collection-1',
  providerCalendarId: 'primary', calendarId: 'calendar-1', localEventId: 'event-1',
  masterProviderId: GOOGLE_MASTER, occurrenceStart: OCCURRENCE, allDay: false,
};
const graphTarget: ProviderOccurrenceTarget = { ...googleTarget, kind: 'graph', masterProviderId: GRAPH_MASTER };

const values = {
  summary: 'Standup (moved)', description: 'Daily', location: 'Room 1', url: null,
  startsAt: new Date('2026-09-15T11:00:00.000Z'), endsAt: new Date('2026-09-15T11:30:00.000Z'),
  allDay: false, attendees: ['a@example.test'],
};

const GOOGLE_MASTER_EVENT = {
  id: GOOGLE_MASTER,
  start: { dateTime: '2026-09-01T09:00:00Z', timeZone: 'UTC' },
  recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=12'],
};
const GRAPH_MASTER_EVENT = {
  id: GRAPH_MASTER,
  start: { dateTime: '2026-09-01T09:00:00.0000000', timeZone: 'UTC' },
  recurrence: {
    pattern: { type: 'weekly', interval: 1, daysOfWeek: ['monday', 'wednesday'] },
    range: { type: 'numbered', numberOfOccurrences: 12, startDate: '2026-09-01' },
  },
};

describe('resolving the provider’s occurrence id', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('takes the instance whose original start matches the occurrence, for Google and Graph', async () => {
    mocks.google.instances.mockResolvedValue([
      { id: `${GOOGLE_MASTER}_20260914T090000Z`, originalStartTime: { dateTime: '2026-09-14T09:00:00Z' } },
      { id: `${GOOGLE_MASTER}_20260915T090000Z`, originalStartTime: { dateTime: '2026-09-15T09:00:00Z' } },
    ]);
    await expect(resolveProviderOccurrenceId({ target: googleTarget })).resolves.toEqual({
      id: `${GOOGLE_MASTER}_20260915T090000Z`, cancelled: false,
    });

    mocks.graph.instances.mockResolvedValue([
      { id: `${GRAPH_MASTER}_20260914`, originalStart: '2026-09-14T09:00:00.0000000' },
      { id: `${GRAPH_MASTER}_20260915`, originalStart: '2026-09-15T09:00:00.0000000' },
    ]);
    // Graph's `originalStart` carries no zone designator; it is the UTC instant Graph returned under
    // `Prefer: outlook.timezone="UTC"`, which is what the listing sends.
    await expect(resolveProviderOccurrenceId({ target: graphTarget })).resolves.toEqual({
      id: `${GRAPH_MASTER}_20260915`, cancelled: false,
    });
  });

  it('answers null when the provider lists no such occurrence', async () => {
    mocks.google.instances.mockResolvedValue([{ id: 'other', originalStartTime: { dateTime: '2026-09-14T09:00:00Z' } }]);
    await expect(resolveProviderOccurrenceId({ target: googleTarget })).resolves.toBeNull();
    mocks.graph.instances.mockResolvedValue([]);
    await expect(resolveProviderOccurrenceId({ target: graphTarget })).resolves.toBeNull();
  });

  it('finds an exception moved beyond a day by widening the window', async () => {
    // CAL-04: a listing is filtered by an instance's current start, so an exception moved by a week fell outside
    // the old ±24 h window and the edit was answered OCCURRENCE_NOT_FOUND. The narrow window is tried first and
    // the wider one only when it found nothing.
    mocks.google.instances
      .mockResolvedValueOnce([{ id: 'unrelated', originalStartTime: { dateTime: '2026-09-14T09:00:00Z' } }])
      .mockResolvedValueOnce([{ id: 'moved-a-week', originalStartTime: { dateTime: '2026-09-15T09:00:00Z' } }]);

    await expect(resolveProviderOccurrenceId({ target: googleTarget })).resolves.toEqual({ id: 'moved-a-week', cancelled: false });
    expect(mocks.google.instances).toHaveBeenCalledTimes(2);
  });

  it('does not match a timed occurrence to another instance on the same date', async () => {
    // The date-only comparison blurred temporal identity: a timed occurrence at 09:00 matched an instance at
    // 15:00 on the same day. It now applies to all-day occurrences only (CAL-04).
    mocks.google.instances.mockResolvedValue([{ id: 'same-day-other-time', originalStartTime: { dateTime: '2026-09-15T15:00:00Z' } }]);
    await expect(resolveProviderOccurrenceId({ target: googleTarget })).resolves.toBeNull();

    mocks.graph.instances.mockResolvedValue([{ id: 'same-day-other-time', originalStart: '2026-09-15T15:00:00.0000000' }]);
    await expect(resolveProviderOccurrenceId({ target: graphTarget })).resolves.toBeNull();

    // The all-day case still matches by date.
    mocks.google.instances.mockResolvedValue([{ id: 'all-day', originalStartTime: { date: '2026-09-15' } }]);
    await expect(resolveProviderOccurrenceId({ target: { ...googleTarget, occurrenceStart: '2026-09-15', allDay: true } }))
      .resolves.toMatchObject({ id: 'all-day' });
  });

  it('reads a Graph stamp without a zone as UTC rather than in the server zone', async () => {
    // CAL-04: Graph's `originalStart` carries no offset. `new Date` parsed it in the server's local zone, so the
    // comparison was wrong on any host that is not UTC.
    mocks.graph.instances.mockResolvedValue([{ id: 'graph-exact', originalStart: '2026-09-15T09:00:00.0000000' }]);
    await expect(resolveProviderOccurrenceId({ target: graphTarget })).resolves.toEqual({ id: 'graph-exact', cancelled: false });
  });

  it('matches an all-day occurrence by its date', async () => {
    mocks.google.instances.mockResolvedValue([{ id: `${GOOGLE_MASTER}_20260915`, originalStartTime: { date: '2026-09-15' } }]);
    await expect(resolveProviderOccurrenceId({ target: { ...googleTarget, occurrenceStart: '2026-09-15', allDay: true } }))
      .resolves.toMatchObject({ id: `${GOOGLE_MASTER}_20260915` });
  });
});

describe('truncating a rule before an occurrence', () => {
  it('sets UNTIL to the second before it and drops COUNT, keeping the rest of the rule', () => {
    expect(truncateRRuleBefore(['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=12'], new Date(OCCURRENCE)))
      .toEqual(['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;UNTIL=20260915T085959Z']);
  });

  it('leaves a non-rule line alone and replaces an existing UNTIL', () => {
    expect(truncateRRuleBefore(['EXDATE;TZID=Europe/Warsaw:20260907T090000', 'RRULE:FREQ=DAILY;UNTIL=20261231T000000Z'], new Date(OCCURRENCE)))
      .toEqual(['EXDATE;TZID=Europe/Warsaw:20260907T090000', 'RRULE:FREQ=DAILY;UNTIL=20260915T085959Z']);
  });

  it('reads an all-day occurrence date as midnight UTC', () => {
    expect(occurrenceInstant('2026-09-15')?.toISOString()).toBe('2026-09-15T00:00:00.000Z');
    expect(occurrenceInstant('nonsense')).toBeNull();
  });
});

describe('changing one occurrence', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('patches the instance the provider listed, for Google and Graph', async () => {
    mocks.google.instances.mockResolvedValue([{ id: `${GOOGLE_MASTER}_20260915T090000Z`, originalStartTime: { dateTime: '2026-09-15T09:00:00Z' } }]);
    mocks.google.patch.mockResolvedValue({ id: `${GOOGLE_MASTER}_20260915T090000Z` });
    const google = await writeProviderCalendarOccurrence({ target: googleTarget, scope: 'single', operation: 'update', values, sendUpdates: 'all' });
    expect(google).toMatchObject({ status: 'confirmed', providerOccurrenceId: `${GOOGLE_MASTER}_20260915T090000Z` });
    expect(mocks.google.patch).toHaveBeenCalledWith(expect.anything(), 'primary', `${GOOGLE_MASTER}_20260915T090000Z`, expect.objectContaining({ summary: 'Standup (moved)' }), { sendUpdates: 'all' });

    mocks.graph.instances.mockResolvedValue([{ id: `${GRAPH_MASTER}_20260915`, originalStart: '2026-09-15T09:00:00.0000000' }]);
    mocks.graph.patch.mockResolvedValue({ id: `${GRAPH_MASTER}_20260915` });
    const graph = await writeProviderCalendarOccurrence({ target: graphTarget, scope: 'single', operation: 'update', values, sendUpdates: 'all' });
    expect(graph).toMatchObject({ status: 'confirmed', providerOccurrenceId: `${GRAPH_MASTER}_20260915` });
    expect(mocks.graph.patch).toHaveBeenLastCalledWith(expect.anything(), 'primary', `${GRAPH_MASTER}_20260915`, expect.objectContaining({ subject: 'Standup (moved)' }));
    // The series itself is untouched by a single-occurrence edit.
    expect(mocks.google.get).not.toHaveBeenCalled();
    expect(mocks.graph.get).not.toHaveBeenCalled();
  });

  it('cancels the instance rather than the series', async () => {
    mocks.google.instances.mockResolvedValue([{ id: `${GOOGLE_MASTER}_20260915T090000Z`, originalStartTime: { dateTime: '2026-09-15T09:00:00Z' } }]);
    const google = await writeProviderCalendarOccurrence({ target: googleTarget, scope: 'single', operation: 'cancel', sendUpdates: 'all' });
    expect(google.status).toBe('confirmed');
    expect(mocks.google.remove).toHaveBeenCalledWith(expect.anything(), 'primary', `${GOOGLE_MASTER}_20260915T090000Z`, { sendUpdates: 'all' });

    mocks.graph.instances.mockResolvedValue([{ id: `${GRAPH_MASTER}_20260915`, originalStart: '2026-09-15T09:00:00.0000000' }]);
    await writeProviderCalendarOccurrence({ target: graphTarget, scope: 'single', operation: 'cancel', sendUpdates: 'all' });
    expect(mocks.graph.remove).toHaveBeenCalledWith(expect.anything(), 'primary', `${GRAPH_MASTER}_20260915`);
  });
});

describe('changing this and following', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('truncates the master and creates the remainder as a new series, for Google', async () => {
    mocks.google.instances.mockResolvedValue([{ id: `${GOOGLE_MASTER}_20260915T090000Z`, originalStartTime: { dateTime: '2026-09-15T09:00:00Z' } }]);
    mocks.google.get.mockResolvedValue(GOOGLE_MASTER_EVENT);
    mocks.google.insert.mockResolvedValue({ id: 'google-remainder-1' });

    const outcome = await writeProviderCalendarOccurrence({ target: googleTarget, scope: 'following', operation: 'update', values, sendUpdates: 'all' });

    expect(outcome).toMatchObject({ status: 'confirmed', createdSeriesId: 'google-remainder-1' });
    expect(mocks.google.patch).toHaveBeenCalledWith(
      expect.anything(), 'primary', GOOGLE_MASTER,
      { recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20260915T085959Z'] },
      { sendUpdates: 'all' },
    );
    // The remainder keeps the client's values and continues the series with the master's rule **adjusted for
    // what the earlier part keeps**: COUNT=12 with 4 occurrences before the split continues with 8, not 12
    // (CAL-02). The truncation belongs to the part that stays behind.
    expect(mocks.google.insert).toHaveBeenCalledWith(
      expect.anything(), 'primary',
      expect.objectContaining({ summary: 'Standup (moved)', recurrence: ['RRULE:FREQ=WEEKLY;COUNT=8;BYDAY=MO,WE'] }),
      { sendUpdates: 'all' },
    );
  });

  it('writes UNTIL in the DTSTART value type: a DATE rule for an all-day series', () => {
    // CAL-03: an all-day series has a DATE DTSTART, and RFC 5545 requires a DATE UNTIL for it. A UTC
    // DATE-TIME was both an invalid value type and a day off.
    expect(truncateRRuleBefore(['RRULE:FREQ=DAILY;COUNT=5'], new Date('2026-09-15T00:00:00.000Z'), { startIsDate: true }))
      .toEqual(['RRULE:FREQ=DAILY;UNTIL=20260914']);
    // The timed form is unchanged: UTC DATE-TIME, one second before the occurrence.
    expect(truncateRRuleBefore(['RRULE:FREQ=DAILY;COUNT=5'], new Date('2026-09-15T09:00:00.000Z'))).toEqual(
      ['RRULE:FREQ=DAILY;UNTIL=20260915T085959Z'],
    );
  });

  it('ends a Graph series on the previous calendar day in the series zone, not the previous UTC day', async () => {
    // CAL-03: a 00:30 Europe/Warsaw occurrence is already on the previous UTC date, so subtracting 24 hours
    // from the instant and taking the UTC date ended the earlier part a day too early.
    const warsawMaster = {
      ...GRAPH_MASTER_EVENT,
      start: { dateTime: '2026-09-15T00:30:00+02:00', timeZone: 'Europe/Warsaw' },
    };
    mocks.graph.instances.mockResolvedValue([{ id: `${GRAPH_MASTER}_20260915`, originalStart: '2026-09-14T22:30:00.0000000' }]);
    mocks.graph.get.mockResolvedValue(warsawMaster);
    mocks.graph.create.mockResolvedValue({ id: 'graph-remainder-2' });

    const outcome = await writeProviderCalendarOccurrence({
      target: { ...graphTarget, occurrenceStart: '2026-09-15T00:30:00+02:00' },
      scope: 'following', operation: 'update', values, sendUpdates: 'all',
    });

    expect(outcome).toMatchObject({ status: 'confirmed' });
    expect(mocks.graph.patch).toHaveBeenCalledWith(expect.anything(), 'primary', GRAPH_MASTER, {
      recurrence: {
        pattern: { type: 'weekly', interval: 1, daysOfWeek: ['monday', 'wednesday'] },
        range: { type: 'endDate', startDate: '2026-09-01', endDate: '2026-09-14' },
      },
    });
  });

  it('refuses a split at the first occurrence instead of writing an empty prefix', async () => {
    // The earlier part would contain no occurrence. Graph would reject the range (or accept one that ends
    // before it starts); nothing may be written, and the caller must see it as unsupported rather than as a
    // generic failure (CAL-03).
    mocks.graph.instances.mockResolvedValue([{ id: `${GRAPH_MASTER}_20260901`, originalStart: '2026-09-01T09:00:00.0000000' }]);
    mocks.graph.get.mockResolvedValue(GRAPH_MASTER_EVENT);

    const outcome = await writeProviderCalendarOccurrence({
      target: { ...graphTarget, occurrenceStart: '2026-09-01T09:00:00.000Z' },
      scope: 'following', operation: 'update', values, sendUpdates: 'all',
    });

    expect(outcome).toMatchObject({ status: 'failed', failure: { code: 'SPLIT_AT_FIRST_OCCURRENCE' } });
    expect(mocks.graph.patch).not.toHaveBeenCalled();
    expect(mocks.graph.create).not.toHaveBeenCalled();
  });

  it('refuses a following-change without values before truncating the master', async () => {
    // CAL-01: the master used to be truncated and only then was the missing `values` noticed, so a request that
    // could never succeed still ended the earlier part of the series. Everything is validated and built first.
    mocks.google.instances.mockResolvedValue([{ id: `${GOOGLE_MASTER}_20260915T090000Z`, originalStartTime: { dateTime: '2026-09-15T09:00:00Z' } }]);
    mocks.google.get.mockResolvedValue(GOOGLE_MASTER_EVENT);
    const google = await writeProviderCalendarOccurrence({ target: googleTarget, scope: 'following', operation: 'update', sendUpdates: 'all' });
    expect(google).toMatchObject({ status: 'failed', failure: { code: 'INVALID_REQUEST' } });
    expect(mocks.google.patch).not.toHaveBeenCalled();
    expect(mocks.google.insert).not.toHaveBeenCalled();

    mocks.graph.instances.mockResolvedValue([{ id: `${GRAPH_MASTER}_20260915`, originalStart: '2026-09-15T09:00:00.0000000' }]);
    mocks.graph.get.mockResolvedValue(GRAPH_MASTER_EVENT);
    const graph = await writeProviderCalendarOccurrence({ target: graphTarget, scope: 'following', operation: 'update', sendUpdates: 'all' });
    expect(graph).toMatchObject({ status: 'failed', failure: { code: 'INVALID_REQUEST' } });
    expect(mocks.graph.patch).not.toHaveBeenCalled();
    expect(mocks.graph.create).not.toHaveBeenCalled();
  });

  it('continues a counted series without restarting its count, and refuses when it cannot', () => {
    // CAL-02: a COUNT rule copied verbatim restarts the whole series. With weekly Tuesdays from 2026-09-01 and
    // a split at the 4th occurrence, three occurrences stay behind and the remainder continues with seven.
    const rule = 'FREQ=WEEKLY;BYDAY=TU;COUNT=10';
    expect(occurrencesBeforeRule(rule, '2026-09-01T09:00:00Z', new Date('2026-09-22T09:00:00Z'))).toBe(3);
    expect(continueRruleAfterSplit(rule, '2026-09-01T09:00:00Z', new Date('2026-09-22T09:00:00Z'))).toContain('COUNT=7');

    // An UNTIL-based rule already describes the remainder correctly.
    expect(continueRruleAfterSplit('FREQ=DAILY;UNTIL=20261231T000000Z', '2026-09-01T09:00:00Z', new Date('2026-09-15T09:00:00Z')))
      .toBe('FREQ=DAILY;UNTIL=20261231T000000Z');

    // Cannot be expanded within the safety limit, or nothing is left: refuse rather than guess a count.
    expect(occurrencesBeforeRule('FREQ=DAILY', '2026-01-01T09:00:00Z', new Date('2030-01-01T09:00:00Z'), 10)).toBeNull();
    expect(continueRruleAfterSplit('FREQ=DAILY;COUNT=3', '2026-09-01T09:00:00Z', new Date('2026-09-10T09:00:00Z'))).toBeNull();
  });

  it('refuses a continuation it cannot compute instead of truncating the master first', async () => {
    // The master carries a rule but no start, so the remaining count cannot be derived. Nothing may be written,
    // and the caller must see it as unsupported (CAL-02).
    mocks.google.instances.mockResolvedValue([{ id: `${GOOGLE_MASTER}_20260915T090000Z`, originalStartTime: { dateTime: '2026-09-15T09:00:00Z' } }]);
    mocks.google.get.mockResolvedValue({ id: GOOGLE_MASTER, recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=12'] });

    const outcome = await writeProviderCalendarOccurrence({ target: googleTarget, scope: 'following', operation: 'update', values, sendUpdates: 'all' });

    expect(outcome).toMatchObject({ status: 'failed', failure: { code: 'RECURRENCE_CONTINUATION_UNSUPPORTED' } });
    expect(mocks.google.patch).not.toHaveBeenCalled();
    expect(mocks.google.insert).not.toHaveBeenCalled();
  });

  it('continues a count the client sent, because the composer sends the series’ own rule', async () => {
    // CAL-02, client-supplied rule: "this and following" copies the **series'** recurrence into the editor, so the
    // count that arrives with the edit is the whole series' count. Applied verbatim it restarts the series from
    // the split; it has to lose the occurrences the earlier part keeps, exactly as the master's own rule does.
    const clientRule = { frequency: 'weekly' as const, interval: 1, byWeekday: [1, 3], until: null, untilIcal: null, count: 12 };

    mocks.google.instances.mockResolvedValue([{ id: `${GOOGLE_MASTER}_20260915T090000Z`, originalStartTime: { dateTime: '2026-09-15T09:00:00Z' } }]);
    mocks.google.get.mockResolvedValue(GOOGLE_MASTER_EVENT);
    await expect(writeProviderCalendarOccurrence({
      target: googleTarget, scope: 'following', operation: 'update',
      values: { ...values, recurrence: clientRule }, sendUpdates: 'all',
    })).resolves.toMatchObject({ status: 'confirmed' });
    const googleLines = ((mocks.google.insert.mock.calls.at(-1)?.[2] as { recurrence?: string[] }).recurrence ?? []).join('\n');
    // 4 of the 12 occurrences precede the split, so the remainder keeps 8.
    expect(googleLines).toContain('COUNT=8');
    expect(googleLines).not.toContain('COUNT=12');

    mocks.graph.instances.mockResolvedValue([{ id: `${GRAPH_MASTER}_20260915`, originalStart: '2026-09-15T09:00:00.0000000' }]);
    mocks.graph.get.mockResolvedValue(GRAPH_MASTER_EVENT);
    await expect(writeProviderCalendarOccurrence({
      target: graphTarget, scope: 'following', operation: 'update',
      values: { ...values, recurrence: clientRule }, sendUpdates: 'all',
    })).resolves.toMatchObject({ status: 'confirmed' });
    const graphRecurrence = (mocks.graph.create.mock.calls.at(-1)?.[2] as { recurrence?: { range?: { type?: string; numberOfOccurrences?: number } } }).recurrence;
    expect(graphRecurrence?.range).toMatchObject({ type: 'numbered', numberOfOccurrences: 8 });
  });

  it('preserves absent, null, and explicit recurrence as three distinct Google remainder intents', async () => {
    const instance = [{ id: `${GOOGLE_MASTER}_20260915T090000Z`, originalStartTime: { dateTime: '2026-09-15T09:00:00Z' } }];
    const write = async (recurrence: { frequency: 'weekly'; interval: number; byWeekday: number[]; until: null; untilIcal: null; count: number } | null | undefined, provided: boolean) => {
      vi.clearAllMocks();
      mocks.google.instances.mockResolvedValue(instance);
      mocks.google.get.mockResolvedValue(GOOGLE_MASTER_EVENT);
      mocks.google.insert.mockResolvedValue({ id: 'remainder' });
      await writeProviderCalendarOccurrence({
        target: googleTarget, scope: 'following', operation: 'update',
        values: provided ? { ...values, recurrence } : values, sendUpdates: 'all',
      });
      return mocks.google.insert.mock.calls.at(-1)?.[2] as { recurrence?: string[] };
    };

    expect((await write(undefined, false)).recurrence).toContain('RRULE:FREQ=WEEKLY;COUNT=8;BYDAY=MO,WE');
    expect((await write(null, true)).recurrence).toEqual([]);
    const explicit = (await write({ frequency: 'weekly', interval: 1, byWeekday: [1], until: null, untilIcal: null, count: 12 }, true)).recurrence?.join(';') ?? '';
    expect(explicit).toContain('COUNT=8');
    expect(explicit).toContain('BYDAY=MO');
  });

  it('recognises a remainder a previous run already created, instead of creating a second series', async () => {
    // CAL-01: the create goes straight to the provider, so a run that died after dispatching it left no record of
    // whether it landed. A resumed run asks the calendar; an exact, single match means it did land.
    const prepared = {
      payload: {
        summary: 'Standup (moved)', description: 'Daily', location: 'Room 1',
        start: { dateTime: '2026-09-15T11:00:00.000Z' }, end: { dateTime: '2026-09-15T11:30:00.000Z' },
        recurrence: ['RRULE:FREQ=WEEKLY;COUNT=8;BYDAY=MO,WE'],
      },
    };
    injected.progress = [
      { stage: 'split_prepared', detail: prepared },
      { stage: 'master_truncated', detail: {} },
      { stage: 'remainder_create_dispatched', detail: {} },
    ];
    mocks.google.instances.mockResolvedValue([{ id: `${GOOGLE_MASTER}_20260915T090000Z`, originalStartTime: { dateTime: '2026-09-15T09:00:00Z' } }]);
    mocks.google.get.mockResolvedValue(GOOGLE_MASTER_EVENT);
    // The calendar already holds an event that carries exactly what the split was about to create.
    mocks.google.listEvents.mockResolvedValue({
      events: [{
        id: 'remainder-1',
        summary: 'Standup (moved)',
        start: { dateTime: '2026-09-15T11:00:00.000Z' },
        recurrence: ['RRULE:FREQ=WEEKLY;COUNT=8;BYDAY=MO,WE'],
      }],
    });

    const outcome = await writeProviderCalendarOccurrence({
      target: googleTarget, scope: 'following', operation: 'update', values: { ...values }, sendUpdates: 'all',
    });

    expect(outcome).toMatchObject({ status: 'confirmed', createdSeriesId: 'remainder-1' });
    // Nothing was created a second time, and the master was not truncated again either.
    expect(mocks.google.insert).not.toHaveBeenCalled();
    expect(mocks.google.patch).not.toHaveBeenCalled();
  });

  it('recognises a Microsoft remainder a previous run already created, instead of creating a second series', async () => {
    // The same recovery as on Google, over Graph's ordinary listing: the create has no journal of its own, so the
    // calendar is asked what it holds before another one is dispatched.
    injected.progress = [
      { stage: 'split_prepared', detail: { payload: {
        subject: 'Standup (moved)', body: { contentType: 'text', content: 'Daily' },
        start: { dateTime: '2026-09-15T11:00:00.000Z', timeZone: 'UTC' },
        end: { dateTime: '2026-09-15T11:30:00.000Z', timeZone: 'UTC' },
        recurrence: {
          pattern: { type: 'weekly', interval: 1, daysOfWeek: ['monday', 'wednesday'] },
          range: { type: 'numbered', startDate: '2026-09-15', numberOfOccurrences: 8 },
        },
        transactionId: 'op-1',
      } } },
      { stage: 'master_truncated', detail: {} },
      { stage: 'remainder_create_dispatched', detail: {} },
    ];
    mocks.graph.instances.mockResolvedValue([{ id: `${GRAPH_MASTER}_20260915`, originalStart: '2026-09-15T09:00:00.0000000' }]);
    mocks.graph.get.mockResolvedValue(GRAPH_MASTER_EVENT);
    mocks.graph.listEvents.mockResolvedValue([{
      id: 'graph-remainder-1',
      subject: 'Standup (moved)',
      start: { dateTime: '2026-09-15T11:00:00.0000000', timeZone: 'UTC' },
      recurrence: {
        pattern: { type: 'weekly', interval: 1, daysOfWeek: ['monday', 'wednesday'] },
        range: { type: 'numbered', startDate: '2026-09-15', numberOfOccurrences: 8 },
      },
    }]);

    const outcome = await writeProviderCalendarOccurrence({
      target: graphTarget, scope: 'following', operation: 'update', values, sendUpdates: 'all',
    });

    if (outcome.status !== 'confirmed') console.log('DIAG graph reconcile', JSON.stringify(outcome));
    expect(outcome).toMatchObject({ status: 'confirmed', createdSeriesId: 'graph-remainder-1' });
    expect(mocks.graph.create).not.toHaveBeenCalled();
    expect(mocks.graph.patch).not.toHaveBeenCalled();
  });

  it('refuses a client count it cannot continue rather than restarting the series', async () => {
    // The master's rule cannot be expanded (it carries no DTSTART), so the remainder's count cannot be derived.
    // Nothing may be written: a remainder that restarted the count is worse than a refusal.
    const clientRule = { frequency: 'weekly' as const, interval: 1, byWeekday: [1, 3], until: null, untilIcal: null, count: 12 };
    mocks.google.instances.mockResolvedValue([{ id: `${GOOGLE_MASTER}_20260915T090000Z`, originalStartTime: { dateTime: '2026-09-15T09:00:00Z' } }]);
    mocks.google.get.mockResolvedValue({ id: GOOGLE_MASTER, recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=12'] });

    const outcome = await writeProviderCalendarOccurrence({
      target: googleTarget, scope: 'following', operation: 'update',
      values: { ...values, recurrence: clientRule }, sendUpdates: 'all',
    });
    expect(outcome).toMatchObject({ status: 'failed', failure: { code: 'RECURRENCE_CONTINUATION_UNSUPPORTED' } });
    expect(mocks.google.patch).not.toHaveBeenCalled();
    expect(mocks.google.insert).not.toHaveBeenCalled();
  });

  it('ends the earlier part at the day before the split, for Graph, and creates the remainder', async () => {
    mocks.graph.instances.mockResolvedValue([{ id: `${GRAPH_MASTER}_20260915`, originalStart: '2026-09-15T09:00:00.0000000' }]);
    mocks.graph.get.mockResolvedValue(GRAPH_MASTER_EVENT);
    mocks.graph.create.mockResolvedValue({ id: 'graph-remainder-1' });

    const outcome = await writeProviderCalendarOccurrence({ target: graphTarget, scope: 'following', operation: 'update', values, sendUpdates: 'all' });

    expect(outcome).toMatchObject({ status: 'confirmed', createdSeriesId: 'graph-remainder-1' });
    expect(mocks.graph.patch).toHaveBeenCalledWith(expect.anything(), 'primary', GRAPH_MASTER, {
      recurrence: {
        pattern: { type: 'weekly', interval: 1, daysOfWeek: ['monday', 'wednesday'] },
        range: { type: 'endDate', startDate: '2026-09-01', endDate: '2026-09-14' },
      },
    });
    expect(mocks.graph.create).toHaveBeenCalledWith(expect.anything(), 'primary', expect.objectContaining({
      subject: 'Standup (moved)',
      // CAL-02: the remainder starts at the split and keeps only the occurrences the earlier part does not —
      // 4 of the 12 are before it, so 8 remain. Copying the range verbatim restarted the whole series.
      recurrence: {
        pattern: { type: 'weekly', interval: 1, daysOfWeek: ['monday', 'wednesday'] },
        range: { type: 'numbered', startDate: '2026-09-15', numberOfOccurrences: 8 },
      },
    }));
  });

  it('cancels this and following by truncating only, with no remainder', async () => {
    mocks.google.instances.mockResolvedValue([{ id: `${GOOGLE_MASTER}_20260915T090000Z`, originalStartTime: { dateTime: '2026-09-15T09:00:00Z' } }]);
    mocks.google.get.mockResolvedValue(GOOGLE_MASTER_EVENT);
    const outcome = await writeProviderCalendarOccurrence({ target: googleTarget, scope: 'following', operation: 'cancel', sendUpdates: 'all' });
    expect(outcome).toMatchObject({ status: 'confirmed', createdSeriesId: null });
    expect(mocks.google.insert).not.toHaveBeenCalled();
    expect(mocks.google.remove).not.toHaveBeenCalled();
  });

  it('refuses when the master carries no rule to truncate', async () => {
    mocks.graph.instances.mockResolvedValue([{ id: `${GRAPH_MASTER}_20260915`, originalStart: '2026-09-15T09:00:00.0000000' }]);
    mocks.graph.get.mockResolvedValue({ id: GRAPH_MASTER });
    const outcome = await writeProviderCalendarOccurrence({ target: graphTarget, scope: 'following', operation: 'cancel', sendUpdates: 'all' });
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.failure.status).toBe(403);
  });
});

describe('the engine reports what the provider did', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('refuses a scoped change to an occurrence the provider does not list', async () => {
    mocks.google.instances.mockResolvedValue([]);
    const outcome = await writeProviderCalendarOccurrence({ target: googleTarget, scope: 'single', operation: 'update', values, sendUpdates: 'all' });
    expect(outcome).toMatchObject({ status: 'failed', failure: { status: 409, code: 'OCCURRENCE_NOT_FOUND' } });
    expect(mocks.google.patch).not.toHaveBeenCalled();
  });

  it('maps a provider refusal onto the shared statuses', async () => {
    mocks.google.instances.mockResolvedValue([{ id: `${GOOGLE_MASTER}_20260915T090000Z`, originalStartTime: { dateTime: '2026-09-15T09:00:00Z' } }]);
    mocks.google.patch.mockRejectedValue(new GoogleApiError({ code: 'RATE_LIMITED', message: 'rate limited', status: 429, retryable: true, retryAfterSeconds: 30 }));
    const outcome = await writeProviderCalendarOccurrence({ target: googleTarget, scope: 'single', operation: 'update', values, sendUpdates: 'all' });
    expect(outcome).toMatchObject({ status: 'failed', failure: { status: 503, retryAfterSeconds: 30 } });
  });
});
