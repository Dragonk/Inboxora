import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  runProviderMutation: vi.fn(),
  insert: vi.fn(),
  patch: vi.fn(),
  remove: vi.fn(),
  createPerson: vi.fn(),
  updatePerson: vi.fn(),
  removePerson: vi.fn(),
  readProviderSwitches: vi.fn(),
  googleConfig: { clientId: 'g-client', clientSecret: 'g-secret', redirectUri: 'https://inboxora.example/oauth/google/callback' },
}));

vi.mock('./db.js', () => ({ query: mocks.query }));
vi.mock('./providerMutationService.js', () => ({ runProviderMutation: mocks.runProviderMutation }));
vi.mock('./providerSwitches.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./providerSwitches.js')>()),
  readProviderSwitches: mocks.readProviderSwitches,
}));
vi.mock('./providerAuthService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./providerAuthService.js')>()),
  googleConfigFromEnv: () => ({ ...mocks.googleConfig }),
}));
vi.mock('./providers/google/googleCalendar.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./providers/google/googleCalendar.js')>()),
  insertGoogleEvent: mocks.insert,
  patchGoogleEvent: mocks.patch,
  deleteGoogleEvent: mocks.remove,
}));
vi.mock('./providers/google/googlePeople.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./providers/google/googlePeople.js')>()),
  createGooglePerson: mocks.createPerson,
  updateGooglePerson: mocks.updatePerson,
  deleteGooglePerson: mocks.removePerson,
}));

import { GoogleApiError } from './providers/google/googleApiClient.js';
import {
  googleCalendarEventMutationAdapter,
  googleContactMutationAdapter,
  googleContactPayloadFor,
  googleEventIdForLocalRow,
  googleEventPayloadFor,
  googlePersonDate,
  googlePersonLinkForLocalRow,
  journalResourceId,
  resolveGoogleCalendarWriteTarget,
  resolveGoogleContactWriteTarget,
  writeGoogleCalendarEvent,
  writeGoogleContact,
} from './providerGoogleWrites.js';
import type { GoogleCalendarWriteTarget, GoogleContactWriteTarget, GoogleEventWriteInput } from './providerGoogleWrites.js';
import type { ParsedRecurrence } from '../utils/calendarRecurrenceRule.js';
import type { VCardContact } from '../utils/vcard.js';

const api = { userId: 'user-1', connectionId: 'connection-1', config: { clientId: 'g-client', clientSecret: 'g-secret', redirectUri: 'https://x' } };
const ALL_ON = { enabled: true, webEnabled: true, deviceEnabled: false, apiEnabled: true };

const event = (overrides: Partial<GoogleEventWriteInput> = {}): GoogleEventWriteInput => ({
  summary: 'Standup',
  description: 'Daily sync',
  location: 'Room 1',
  url: null,
  startsAt: new Date('2026-09-01T09:00:00.000Z'),
  endsAt: new Date('2026-09-01T09:30:00.000Z'),
  allDay: false,
  attendees: ['a@example.test'],
  recurrence: undefined,
  ...overrides,
});

const weekly: ParsedRecurrence = {
  frequency: 'weekly', interval: 2, byWeekday: [1, 3], until: null, untilIcal: null, count: 4,
};

const calendarTarget: GoogleCalendarWriteTarget = {
  kind: 'google', connectionId: 'connection-1', collectionId: 'collection-1',
  providerCalendarId: 'primary', calendarId: 'calendar-1',
};

const contactTarget: GoogleContactWriteTarget = {
  kind: 'google', connectionId: 'connection-1', collectionId: 'collection-1',
  collectionRemoteId: 'people/me', addressBookId: 'book-1',
};

const googleCalendarRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'calendar-1', collection_id: 'collection-1', remote_id: 'primary',
  connection_id: 'connection-1', source_access: 'read_write', user_access: 'read_write', ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readProviderSwitches.mockResolvedValue(ALL_ON);
  mocks.googleConfig = { clientId: 'g-client', clientSecret: 'g-secret', redirectUri: 'https://inboxora.example/oauth/google/callback' };
  mocks.insert.mockResolvedValue({ id: 'evt-1', iCalUID: 'standup@google.com' });
  mocks.patch.mockResolvedValue({ id: 'evt-1', iCalUID: 'standup@google.com' });
  mocks.remove.mockResolvedValue(undefined);
  mocks.createPerson.mockResolvedValue({ resourceName: 'people/c1', etag: 'etag-1' });
  mocks.updatePerson.mockResolvedValue({ resourceName: 'people/c1', etag: 'etag-2' });
  mocks.removePerson.mockResolvedValue(undefined);
});

describe('which writer owns a Google calendar', () => {
  it('resolves a write-enabled Google collection to its connection and provider calendar id', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [googleCalendarRow()] });
    await expect(resolveGoogleCalendarWriteTarget('user-1', 'calendar-1')).resolves.toEqual({
      kind: 'google', connectionId: 'connection-1', collectionId: 'collection-1',
      providerCalendarId: 'primary', calendarId: 'calendar-1',
    });
  });

  it('answers not_google for a calendar no Google collection links', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await expect(resolveGoogleCalendarWriteTarget('user-1', 'calendar-1')).resolves.toEqual({ kind: 'not_google' });
    // The probe is scoped to a Google source, so a local or Microsoft calendar is never mistaken for one.
    const [sql] = mocks.query.mock.calls[0] as [string];
    expect(sql).toContain("c.source = 'google'");
  });

  it('stays refused for a Google collection the user has not enabled for write-back', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [googleCalendarRow({ user_access: 'source' })] });
    await expect(resolveGoogleCalendarWriteTarget('user-1', 'calendar-1')).resolves.toEqual({ kind: 'not_google' });
    expect(mocks.readProviderSwitches).not.toHaveBeenCalled();
  });

  it('stays refused when the origin itself is read-only', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [googleCalendarRow({ source_access: 'read_only' })] });
    await expect(resolveGoogleCalendarWriteTarget('user-1', 'calendar-1')).resolves.toEqual({ kind: 'not_google' });
  });

  it('refuses when the provider layer is switched off outright', async () => {
    const original = process.env.PROVIDER_INTEGRATIONS_ENABLED;
    process.env.PROVIDER_INTEGRATIONS_ENABLED = '0';
    try {
      mocks.query.mockResolvedValueOnce({ rows: [googleCalendarRow()] });
      await expect(resolveGoogleCalendarWriteTarget('user-1', 'calendar-1')).resolves.toMatchObject({ kind: 'refused', status: 403 });
      // No provider call, and not even the switch read: the layer is off.
      expect(mocks.readProviderSwitches).not.toHaveBeenCalled();
      expect(mocks.insert).not.toHaveBeenCalled();
    } finally {
      if (original === undefined) delete process.env.PROVIDER_INTEGRATIONS_ENABLED;
      else process.env.PROVIDER_INTEGRATIONS_ENABLED = original;
    }
  });

  it('refuses when the per-method switch is off', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [googleCalendarRow()] });
    mocks.readProviderSwitches.mockResolvedValue({ ...ALL_ON, apiEnabled: false });
    await expect(resolveGoogleCalendarWriteTarget('user-1', 'calendar-1')).resolves.toMatchObject({ kind: 'refused', status: 403 });
  });

  it('refuses when no Google API client is configured', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [googleCalendarRow()] });
    mocks.googleConfig = { clientId: '', clientSecret: '', redirectUri: '' };
    await expect(resolveGoogleCalendarWriteTarget('user-1', 'calendar-1')).resolves.toMatchObject({ kind: 'refused', status: 409 });
  });

  it('refuses a Google calendar that is not linked to a connection', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [googleCalendarRow({ connection_id: null })] });
    await expect(resolveGoogleCalendarWriteTarget('user-1', 'calendar-1')).resolves.toMatchObject({ kind: 'refused', status: 409 });
  });
});

describe('which writer owns a Google address book', () => {
  const googleBookRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'book-1', collection_id: 'collection-1', remote_id: 'people/me',
    connection_id: 'connection-1', source_access: 'read_write', user_access: 'read_write', ...overrides,
  });

  it('resolves a write-enabled Google book and keeps the collection remote id as the link identity', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [googleBookRow()] });
    await expect(resolveGoogleContactWriteTarget('user-1', 'book-1')).resolves.toEqual({
      kind: 'google', connectionId: 'connection-1', collectionId: 'collection-1',
      collectionRemoteId: 'people/me', addressBookId: 'book-1',
    });
  });

  it('falls back to the personal collection when the collection stored no remote id', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [googleBookRow({ remote_id: null })] });
    await expect(resolveGoogleContactWriteTarget('user-1', 'book-1')).resolves.toMatchObject({ collectionRemoteId: 'people/me' });
  });

  it('answers not_google for a book no Google collection links, and refuses a disabled one', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await expect(resolveGoogleContactWriteTarget('user-1', 'book-1')).resolves.toEqual({ kind: 'not_google' });
    mocks.query.mockResolvedValueOnce({ rows: [googleBookRow({ user_access: 'source' })] });
    await expect(resolveGoogleContactWriteTarget('user-1', 'book-1')).resolves.toEqual({ kind: 'not_google' });
  });
});

describe('a local event becomes a Google event payload', () => {
  it('sends a timed event as the UTC instant with an explicit UTC zone', () => {
    expect(googleEventPayloadFor(event())).toEqual({
      summary: 'Standup',
      start: { dateTime: '2026-09-01T09:00:00.000Z', timeZone: 'UTC' },
      end: { dateTime: '2026-09-01T09:30:00.000Z', timeZone: 'UTC' },
      description: 'Daily sync',
      location: 'Room 1',
      attendees: [{ email: 'a@example.test' }],
    });
  });

  it('sends an all-day event as an exclusive date pair and never a wall clock', () => {
    const payload = googleEventPayloadFor(event({
      allDay: true, summary: null, description: null, location: null, attendees: [],
      startsAt: new Date('2026-09-01T00:00:00.000Z'), endsAt: new Date('2026-09-02T00:00:00.000Z'),
    }));
    expect(payload).toEqual({ summary: '', start: { date: '2026-09-01' }, end: { date: '2026-09-02' } });
  });

  it('renders the validated recurrence as one complete RRULE line', () => {
    expect(googleEventPayloadFor(event({ recurrence: weekly })).recurrence).toEqual(['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=4']);
  });

  it('clears a series with an explicit empty list, and says nothing when the write does not mention it', () => {
    // Recurring → one-off: Google removes the recurrence only when it receives `[]`; an omitted field leaves
    // the old series in place, so the local event would become a one-off while Google kept repeating it.
    expect(googleEventPayloadFor(event({ recurrence: null })).recurrence).toEqual([]);
    // The rule was never mentioned (an occurrence edit, or an unrelated update): the payload must not carry
    // the key at all, or every such update would silently drop the series.
    expect(googleEventPayloadFor(event({ recurrence: undefined }))).not.toHaveProperty('recurrence');
  });

  it('omits the recurrence entirely when the local event has none', () => {
    expect(googleEventPayloadFor(event()).recurrence).toBeUndefined();
  });
});

describe('a local contact becomes a People body and update mask', () => {
  it('derives the mask from exactly the fields the body sets', () => {
    const contact: VCardContact = {
      displayName: 'Ada Lovelace', firstName: 'Ada', lastName: 'Lovelace',
      emails: [{ value: 'ada@example.test', type: 'work', primary: true }],
      phones: [{ value: '+48 111', type: 'cell' }],
      organization: 'Analytical', title: 'Engineer', notes: 'First programmer',
      birthday: '1815-12-10',
    };
    const { person, updateFields } = googleContactPayloadFor(contact, 'etag-1');

    expect(person).toMatchObject({
      etag: 'etag-1',
      names: [{ givenName: 'Ada', familyName: 'Lovelace' }],
      emailAddresses: [{ value: 'ada@example.test', type: 'work', metadata: { primary: true } }],
      phoneNumbers: [{ value: '+48 111', type: 'cell' }],
      organizations: [{ name: 'Analytical', title: 'Engineer' }],
      biographies: [{ value: 'First programmer' }],
      birthdays: [{ date: { year: 1815, month: 12, day: 10 } }],
    });
    // The mask names exactly the body's own keys, so the two cannot disagree.
    expect([...updateFields].sort()).toEqual(['biographies', 'birthdays', 'emailAddresses', 'names', 'organizations', 'phoneNumbers'].sort());
    expect(updateFields.every(field => field in person)).toBe(true);
  });

  it('sends a supplied-but-empty list so a cleared field is cleared, and omits an absent one', () => {
    const cleared = googleContactPayloadFor({ displayName: 'Ada', emails: [], phones: [] }, null);
    expect(cleared.person.emailAddresses).toEqual([]);
    expect(cleared.person.phoneNumbers).toEqual([]);
    expect(cleared.updateFields).toContain('emailAddresses');
    expect(cleared.updateFields).toContain('phoneNumbers');
    // A field the caller never mentioned is in neither the body nor the mask, so People leaves it alone.
    expect(cleared.person.nicknames).toBeUndefined();
    expect(cleared.updateFields).not.toContain('nicknames');
  });

  it('writes a display name with no structure as an unstructured name', () => {
    const { person } = googleContactPayloadFor({ displayName: 'Ada' }, null);
    expect(person.names).toEqual([{ unstructuredName: 'Ada' }]);
  });

  it('writes an anniversary as the dated event the read path projects back', () => {
    const { person, updateFields } = googleContactPayloadFor({ displayName: 'Ada', anniversary: '--05-06' }, null);
    expect(person.events).toEqual([{ type: 'anniversary', date: { month: 5, day: 6 } }]);
    expect(updateFields).toContain('events');
  });

  it('never writes a local-only field, which the next sync would drop', () => {
    const { person, updateFields } = googleContactPayloadFor({
      displayName: 'Ada', role: 'Chief', categories: ['Friends'],
      contactDates: [{ label: 'Wedding', value: '2020-09-14' }],
    }, null);
    expect(updateFields).not.toContain('categories');
    expect(updateFields).not.toContain('organizations');
    expect(person.organizations).toBeUndefined();
  });

  it('marks only the first flagged address as primary', () => {
    const { person } = googleContactPayloadFor({
      displayName: 'Ada',
      emails: [{ value: 'a@example.test', primary: true }, { value: 'b@example.test', primary: true }],
    }, null);
    expect(person.emailAddresses?.map(entry => entry.metadata?.primary)).toEqual([true, undefined]);
  });

  it('leaves an unrepresentable date alone rather than clearing a field the caller did not empty', () => {
    expect(googlePersonDate('not-a-date')).toBeNull();
    expect(googlePersonDate('1815-12-10')).toEqual({ year: 1815, month: 12, day: 10 });
    expect(googlePersonDate('--05-06')).toEqual({ month: 5, day: 6 });
    expect(googlePersonDate('1815-13-40')).toBeNull();
    const { person, updateFields } = googleContactPayloadFor({ displayName: 'Ada', birthday: 'nonsense' }, null);
    expect(person.birthdays).toBeUndefined();
    expect(updateFields).not.toContain('birthdays');
    // An explicitly emptied date does clear the field.
    const cleared = googleContactPayloadFor({ displayName: 'Ada', birthday: '' }, null);
    expect(cleared.person.birthdays).toEqual([]);
    expect(cleared.updateFields).toContain('birthdays');
  });
});

describe('a Google calendar write reports what actually happened', () => {
  const adapter = () => googleCalendarEventMutationAdapter({ api, insert: mocks.insert, patch: mocks.patch, remove: mocks.remove });

  it('creates with the notification choice stated and reports the provider identity', async () => {
    const outcome = await adapter().perform(
      { operation: 'create', calendarId: 'primary', event: event(), sendUpdates: 'all' },
      { operationId: 'op', signal: new AbortController().signal },
    );
    expect(outcome).toMatchObject({ status: 'committed', value: { event: { id: 'evt-1' } } });
    expect(mocks.insert).toHaveBeenCalledWith(api, 'primary', expect.objectContaining({ summary: 'Standup' }), { sendUpdates: 'all' });
  });

  it('sends `none` explicitly rather than relying on Google’s default', async () => {
    await adapter().perform(
      { operation: 'update', calendarId: 'primary', eventId: 'evt-1', event: event(), sendUpdates: 'none' },
      { operationId: 'op', signal: new AbortController().signal },
    );
    expect(mocks.patch).toHaveBeenCalledWith(api, 'primary', 'evt-1', expect.anything(), { sendUpdates: 'none' });
  });

  it('refuses a create Google answered without an id', async () => {
    mocks.insert.mockResolvedValueOnce({});
    await expect(adapter().perform(
      { operation: 'create', calendarId: 'primary', event: event(), sendUpdates: 'none' },
      { operationId: 'op', signal: new AbortController().signal },
    )).resolves.toEqual({ status: 'outcome_unknown', code: 'EVENT_ID_MISSING' });
  });

  it('classifies a throttle as retryable and a 404 as permanent', async () => {
    mocks.patch.mockRejectedValueOnce(new GoogleApiError({ code: 'RATE_LIMITED', message: 'slow', status: 429, retryable: true, retryAfterSeconds: 5 }));
    await expect(adapter().perform(
      { operation: 'update', calendarId: 'primary', eventId: 'evt-1', event: event(), sendUpdates: 'none' },
      { operationId: 'op', signal: new AbortController().signal },
    )).resolves.toEqual({ status: 'retryable', code: 'RATE_LIMITED', retryAfterSeconds: 5 });

    mocks.remove.mockRejectedValueOnce(new GoogleApiError({ code: 'RESOURCE_NOT_FOUND', message: 'gone', status: 404 }));
    await expect(adapter().perform(
      { operation: 'delete', calendarId: 'primary', eventId: 'evt-1', sendUpdates: 'none' },
      { operationId: 'op', signal: new AbortController().signal },
    )).resolves.toEqual({ status: 'permanent', code: 'RESOURCE_NOT_FOUND' });
  });

  it('never reports an ambiguous failure as a refusal, and is not re-runnable', async () => {
    mocks.patch.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(adapter().perform(
      { operation: 'update', calendarId: 'primary', eventId: 'evt-1', event: event(), sendUpdates: 'none' },
      { operationId: 'op', signal: new AbortController().signal },
    )).resolves.toEqual({ status: 'outcome_unknown', code: 'MUTATION_OUTCOME_UNKNOWN' });
    expect(adapter().idempotent).toBe(false);
    expect(adapter().resourceType).toBe('calendar_event');
  });

  it('refuses an update or delete without a provider event id', async () => {
    await expect(adapter().perform(
      { operation: 'delete', calendarId: 'primary', sendUpdates: 'none' },
      { operationId: 'op', signal: new AbortController().signal },
    )).resolves.toEqual({ status: 'permanent', code: 'RESOURCE_NOT_FOUND' });
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});

describe('a Google contact write reports what actually happened', () => {
  const adapter = () => googleContactMutationAdapter({ api, create: mocks.createPerson, update: mocks.updatePerson, remove: mocks.removePerson });

  it('creates and reports the resource name and version', async () => {
    const outcome = await adapter().perform(
      { operation: 'create', person: { names: [{ givenName: 'Ada' }] }, updateFields: ['names'] },
      { operationId: 'op', signal: new AbortController().signal },
    );
    expect(outcome).toMatchObject({ status: 'committed', value: { person: { resourceName: 'people/c1', etag: 'etag-1' } } });
  });

  it('refuses a create Google answered without a resource name', async () => {
    mocks.createPerson.mockResolvedValueOnce({});
    await expect(adapter().perform(
      { operation: 'create', person: { names: [{ givenName: 'Ada' }] }, updateFields: ['names'] },
      { operationId: 'op', signal: new AbortController().signal },
    )).resolves.toEqual({ status: 'outcome_unknown', code: 'CONTACT_ID_MISSING' });
  });

  it('sends the update mask People is asked to replace', async () => {
    await adapter().perform(
      { operation: 'update', resourceName: 'people/c1', person: { etag: 'etag-1', names: [{ givenName: 'Ada' }] }, updateFields: ['names'] },
      { operationId: 'op', signal: new AbortController().signal },
    );
    expect(mocks.updatePerson).toHaveBeenCalledWith(api, 'people/c1', expect.objectContaining({ etag: 'etag-1' }), ['names']);
  });

  it('refuses an update with no fields to replace and a resource name it may not put in a URL', async () => {
    await expect(adapter().perform(
      { operation: 'update', resourceName: 'people/c1', person: { etag: 'etag-1' }, updateFields: [] },
      { operationId: 'op', signal: new AbortController().signal },
    )).resolves.toEqual({ status: 'permanent', code: 'INVALID_REQUEST' });
    await expect(adapter().perform(
      { operation: 'update', resourceName: 'people/c1:deleteContact', person: { etag: 'e' }, updateFields: ['names'] },
      { operationId: 'op', signal: new AbortController().signal },
    )).resolves.toEqual({ status: 'permanent', code: 'RESOURCE_NOT_FOUND' });
    expect(mocks.updatePerson).not.toHaveBeenCalled();
  });
});

describe('running a Google write through the journal', () => {
  beforeEach(() => {
    mocks.runProviderMutation.mockResolvedValue({ status: 'confirmed', operationId: 'op-1', replayed: false, value: { event: { id: 'evt-1', iCalUID: 'standup@google.com' } } });
  });

  it('journals the local row id, never the provider id, which the column cannot hold', async () => {
    await writeGoogleCalendarEvent({
      userId: 'user-1', target: calendarTarget, operation: 'update', providerEventId: 'evt-1',
      event: event(), sendUpdates: 'none', localResourceId: '4c1f2a52-0f5f-4a0e-9f1b-2a5f4f8f6b21',
    });
    const [request] = mocks.runProviderMutation.mock.calls[0] as [Record<string, unknown>];
    expect(request.resourceId).toBe('4c1f2a52-0f5f-4a0e-9f1b-2a5f4f8f6b21');
    // The provider identity still travels, in the payload the adapter performs.
    expect(request.payload).toMatchObject({ calendarId: 'primary', eventId: 'evt-1' });
  });

  it('records no journal resource id for a provider id that is not a local UUID', async () => {
    await writeGoogleContact({
      userId: 'user-1', target: contactTarget, operation: 'delete', providerContactId: 'people/c1',
      localResourceId: 'AAMkAD-not-a-uuid',
    });
    const [request] = mocks.runProviderMutation.mock.calls[0] as [Record<string, unknown>];
    expect(request.resourceId).toBeNull();
    expect(journalResourceId('AAMkAD-not-a-uuid')).toBeNull();
    expect(journalResourceId('4c1f2a52-0f5f-4a0e-9f1b-2a5f4f8f6b21')).toBe('4c1f2a52-0f5f-4a0e-9f1b-2a5f4f8f6b21');
  });

  it('sends the intent id as the journal idempotency key', async () => {
    await writeGoogleCalendarEvent({
      userId: 'user-1', target: calendarTarget, operation: 'create', event: event(), sendUpdates: 'none', idempotencyKey: 'intent-1',
    });
    const [request] = mocks.runProviderMutation.mock.calls[0] as [Record<string, unknown>];
    expect(request).toMatchObject({ operation: 'create', collectionId: 'collection-1', idempotencyKey: 'intent-1' });
  });

  it('maps a refusal onto the shared write failure vocabulary', async () => {
    mocks.runProviderMutation.mockResolvedValueOnce({ status: 'outcome_unknown', operationId: 'op-1', replayed: false });
    const outcome = await writeGoogleCalendarEvent({
      userId: 'user-1', target: calendarTarget, operation: 'update', providerEventId: 'evt-1', event: event(), sendUpdates: 'none',
    });
    expect(outcome).toMatchObject({ status: 'failed', failure: { status: 502, code: 'MUTATION_OUTCOME_UNKNOWN' } });
  });

  it('refuses to call a create confirmed without an identity', async () => {
    mocks.runProviderMutation.mockResolvedValueOnce({ status: 'confirmed', operationId: 'op-1', replayed: false, value: { event: null } });
    const outcome = await writeGoogleCalendarEvent({ userId: 'user-1', target: calendarTarget, operation: 'create', event: event(), sendUpdates: 'none' });
    expect(outcome).toMatchObject({ status: 'failed', failure: { status: 502, code: 'EVENT_ID_MISSING' } });
  });

  it('carries the stored etag into the People update body and reports the create identity', async () => {
    mocks.runProviderMutation.mockResolvedValueOnce({
      status: 'confirmed', operationId: 'op-1', replayed: false,
      value: { person: { resourceName: 'people/c1', etag: 'etag-2' } },
    });
    const outcome = await writeGoogleContact({
      userId: 'user-1', target: contactTarget, operation: 'update', providerContactId: 'people/c1',
      contact: { displayName: 'Ada' }, etag: 'etag-1',
    });
    expect(outcome).toMatchObject({ status: 'confirmed', providerContactId: 'people/c1' });
    const [request] = mocks.runProviderMutation.mock.calls[0] as [Record<string, unknown>];
    expect(request.payload).toMatchObject({
      resourceName: 'people/c1',
      person: { etag: 'etag-1', names: [{ unstructuredName: 'Ada' }] },
      updateFields: ['names'],
    });
  });

  it('reads the provider event id from an active link only', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ object_remote_id: 'evt-1' }] });
    await expect(googleEventIdForLocalRow('user-1', 'collection-1', 'event-1')).resolves.toBe('evt-1');
    const [sql] = mocks.query.mock.calls[0] as [string];
    expect(sql).toContain("object_type = 'calendar_event'");
    expect(sql).toContain("status = 'active'");
  });

  it('reads the person identity and its version from an active link', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ object_remote_id: 'people/c1', remote_version: 'etag-1' }] });
    await expect(googlePersonLinkForLocalRow('user-1', 'collection-1', 'contact-1')).resolves.toEqual({ resourceName: 'people/c1', etag: 'etag-1' });
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await expect(googlePersonLinkForLocalRow('user-1', 'collection-1', 'contact-1')).resolves.toBeNull();
  });
});
