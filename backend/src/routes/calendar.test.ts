import { outlookCalendar } from '../test/fixtures/outlookCalendar.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { listeningPort } from '../test/net.js';
import type { Server } from 'node:http';
import type { NextFunction, Request, Response } from 'express';
import 'express-async-errors';

interface CalendarQueryResult {
  rows: Array<Record<string, unknown>>;
  rowCount?: number;
}

type CalendarQuery = (sql: string, parameters?: unknown[]) => Promise<CalendarQueryResult>;
type CalendarTransaction = <T>(callback: (client: { query: CalendarQuery }) => Promise<T>) => Promise<T>;
type CalendarInvitation = (invitation: {
  account: Record<string, unknown>;
  attendees: string[];
  summary?: string | null;
  uid: string;
  startsAt: Date | string | number;
  endsAt: Date | string | number;
  allDay?: boolean;
  description?: string | null;
  location?: string | null;
  method?: string;
  sequence?: number;
}) => Promise<{ accepted: string[]; rejected: string[] }>;
type CalendarSource = Record<string, unknown>;
type CalendarSyncResult =
  | { ok: true; eventCount?: number; skipped?: Array<{ uid: string; reason: string }> }
  | { ok: false; error: string };
type SyncCalendarSource = (userId: string, sourceId: string) => Promise<CalendarSyncResult>;
type ReleaseCalendarSource = (sourceId: string) => void;
type ScheduleCalendarSource = (source: CalendarSource) => void;
type StopCalendarSource = (sourceId: string) => Promise<void>;

const { query, withTransaction, sendCalendarInvitation, releaseCalendarSource, scheduleCalendarSource, stopCalendarSource, syncCalendarSource } = vi.hoisted(() => {
  const query = vi.fn<CalendarQuery>();
  return {
    query,
    withTransaction: vi.fn<CalendarTransaction>(async callback => callback({ query })),
    sendCalendarInvitation: vi.fn<CalendarInvitation>(),
    releaseCalendarSource: vi.fn<ReleaseCalendarSource>(),
    scheduleCalendarSource: vi.fn<ScheduleCalendarSource>(),
    stopCalendarSource: vi.fn<StopCalendarSource>(),
    syncCalendarSource: vi.fn<SyncCalendarSource>(async () => ({ ok: true })),
  };
});
vi.mock('../services/db.js', () => ({ query, withTransaction }));
vi.mock('../services/encryption.js', () => ({
  encrypt: (value: string) => `enc:v1:${value}`,
  decrypt: (value: string) => value?.startsWith('enc:v1:') ? value.slice('enc:v1:'.length) : value,
}));
vi.mock('../services/calendarInvitation.js', () => ({
  sendCalendarInvitation,
  prepareCalendarInvitation: async (input: Parameters<CalendarInvitation>[0]) => ({
    dispatch: () => sendCalendarInvitation(input),
  }),
}));
vi.mock('../services/externalCalendarSync.js', () => ({ releaseCalendarSource, scheduleCalendarSource, stopCalendarSource, syncCalendarSource }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: { headers: Record<string, string>; session?: { userId?: string } }, _res: unknown, next: () => void) => { req.session = { userId: 'user-1' }; next(); },
}));

import express from 'express';
import { projectCalendarResource } from '../utils/calendarRecurrence.js';
import calendarRouter from './calendar.js';
/**
 * Shape of the JSON bodies this suite asserts on. Fields are optional because a
 * single interface covers both success and error responses.
 */
/** The events endpoint always answers with its list. */
interface CalendarEventsResponse {
  events: Array<Record<string, unknown>>;
  truncated?: boolean;
  error?: string;
}
function queryCall(callIndex: number): [string, unknown[]] {
  const call = query.mock.calls[callIndex];
  if (!call) throw new Error(`Calendar query ${callIndex} was not made`);
  const [sql, parameters] = call;
  if (!Array.isArray(parameters)) throw new Error(`Calendar query ${callIndex} did not receive parameters`);
  return [sql, parameters];
}

function queryParameters(callIndex: number): unknown[] {
  return queryCall(callIndex)[1];
}

function queryParameter(parameters: unknown[] | undefined, parameterIndex: number): unknown {
  if (!parameters) throw new Error('Calendar query did not receive parameters');
  const parameter = parameters[parameterIndex];
  if (parameter === undefined) throw new Error(`Calendar query parameter ${parameterIndex} is missing`);
  return parameter;
}

function queryStringParameter(callIndex: number, parameterIndex: number): string {
  const parameter = queryParameter(queryParameters(callIndex), parameterIndex);
  if (typeof parameter !== 'string') throw new Error(`Calendar query ${callIndex} parameter ${parameterIndex} is not a string`);
  return parameter;
}

function queryCallContaining(fragment: string): [string, unknown[]] {
  const callIndex = query.mock.calls.findIndex(([sql]) => sql.includes(fragment));
  if (callIndex < 0) throw new Error(`Calendar query containing ${fragment} was not made`);
  const [sql] = query.mock.calls[callIndex];
  return [sql, queryParameters(callIndex)];
}

function isResponseRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function responseRecord(value: unknown): Record<string, unknown> {
  if (!isResponseRecord(value)) throw new Error('Calendar response is not an object');
  return value;
}

function responseObject(value: unknown, key: string): Record<string, unknown> {
  const property = responseRecord(value)[key];
  return responseRecord(property);
}

function responseArray(value: unknown, key: string): Array<Record<string, unknown>> {
  const property = responseRecord(value)[key];
  if (!Array.isArray(property) || property.some(item => typeof item !== 'object' || item === null || Array.isArray(item))) {
    throw new Error(`Calendar response ${key} is not an object array`);
  }
  return property;
}

function calendarEventsResponse(value: unknown): CalendarEventsResponse {
  const response = responseRecord(value);
  const events = responseArray(response, 'events');
  const truncated = response.truncated;
  if (truncated === undefined) return { events };
  if (typeof truncated !== 'boolean') throw new Error('Calendar response truncated is not a boolean');
  return { events, truncated };
}

let server: Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/calendar', calendarRouter);
  app.use((error: Error, _req: Request, res: Response, next: NextFunction) => { void next; return res.status(500).json({ error: error.message }); });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${listeningPort(server)}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  query.mockReset().mockResolvedValue({ rows: [] });
  withTransaction.mockClear();
  withTransaction.mockImplementation(async (fn: (client: { query: typeof query }) => unknown) => fn({ query }));
  sendCalendarInvitation.mockReset().mockResolvedValue({ accepted: [], rejected: [] });
  releaseCalendarSource.mockReset();
  scheduleCalendarSource.mockReset();
  stopCalendarSource.mockReset();
  syncCalendarSource.mockReset().mockResolvedValue({ ok: true });
});

function presentationRows() {
  return [{
    id: '11111111-1111-4111-8111-111111111111', name: 'Polish holidays', color: '#123456', source: 'google', read_only: true, display_visible: true,
    collection_id: '22222222-2222-4222-8222-222222222222', provider: 'google', provider_identity: 'provider-subject', account_id: '33333333-3333-4333-8333-333333333333', account_email: 'owner@example.test',
    import_source_id: null, import_kind: null, import_label: null, feature_enabled: true,
  }];
}

function mockPresentationRead({ sourceCollapsed = false, calendarHidden = false }: { sourceCollapsed?: boolean; calendarHidden?: boolean } = {}) {
  query.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM calendars c') && sql.includes('provider_identity')) return { rows: presentationRows() };
    if (sql.includes('FROM user_calendar_source_preferences')) return { rows: sourceCollapsed ? [{ source_id: 'google:account:33333333-3333-4333-8333-333333333333', collapsed: true }] : [] };
    if (sql.includes('FROM user_calendar_presentation_preferences')) return { rows: calendarHidden ? [{ calendar_id: '11111111-1111-4111-8111-111111111111', sidebar_hidden: true }] : [] };
    if (sql.includes("preferences->'calendarContactAppearance'")) return { rows: [] };
    return { rows: [] };
  });
}

describe('calendar presentation', () => {
  it('returns grouped durable account identities and all presentation state', async () => {
    mockPresentationRead({ sourceCollapsed: true, calendarHidden: true });
    const response = await fetch(`${base}/api/calendar/presentation`);
    expect(response.status).toBe(200);
    const body = responseRecord(await response.json());
    expect(typeof body.revision).toBe('string');
    expect(responseArray(body, 'groups')).toEqual(expect.arrayContaining([expect.objectContaining({
      id: 'google:account:33333333-3333-4333-8333-333333333333', collapsed: true,
      calendars: expect.arrayContaining([expect.objectContaining({ id: '11111111-1111-4111-8111-111111111111', selected: true, sidebarHidden: true })]),
    })]));
  });

  it('rejects unknown source identifiers before persisting a preference', async () => {
    mockPresentationRead();
    const response = await fetch(`${base}/api/calendar/presentation/sources/google%3Aaccount%3Aother`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ collapsed: true }) });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Calendar source not found' });
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO user_calendar_source_preferences'))).toBe(false);
  });

  it('rejects unknown and unowned calendar identifiers before persisting a preference', async () => {
    mockPresentationRead();
    const response = await fetch(`${base}/api/calendar/presentation/calendars/44444444-4444-4444-8444-444444444444`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sidebarHidden: true }) });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Calendar not found' });
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO user_calendar_presentation_preferences'))).toBe(false);
  });

  it('uses the canonical loader before and after both preference updates', async () => {
    mockPresentationRead();
    const source = await fetch(`${base}/api/calendar/presentation/sources/google%3Aaccount%3A33333333-3333-4333-8333-333333333333`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ collapsed: true }) });
    expect(source.status).toBe(200);
    expect(responseRecord(await source.json())).toHaveProperty('revision');
    expect(query.mock.calls.filter(([sql]) => sql.includes('FROM calendars c') && sql.includes('provider_identity'))).toHaveLength(2);

    query.mockClear();
    const calendar = await fetch(`${base}/api/calendar/presentation/calendars/11111111-1111-4111-8111-111111111111`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sidebarHidden: true }) });
    expect(calendar.status).toBe(200);
    expect(responseRecord(await calendar.json())).toHaveProperty('revision');
    expect(query.mock.calls.filter(([sql]) => sql.includes('FROM calendars c') && sql.includes('provider_identity'))).toHaveLength(2);
  });
});

// The events read runs two disjoint queries: materialised occurrences, and the live fallback
// for whatever the background worker has not covered. These tests route the fake data by SQL
// content rather than by call order, so adding a query to the read path cannot silently
// rewire which fixture each test receives — which is exactly what happened when
// materialisation was introduced.
function mockEventRead({ events = [], contacts = [], occurrences = [] }: {
  events?: Array<Record<string, unknown>>;
  contacts?: Array<Record<string, unknown>>;
  occurrences?: Array<Record<string, unknown>>;
} = {}) {
  query.mockImplementation(async (sql: string) => {
    if (typeof sql === 'string' && sql.includes('FROM calendars c') && sql.includes('provider_identity')) {
      const id = String(events[0]?.calendar_id ?? occurrences[0]?.calendar_id ?? '11111111-1111-4111-8111-111111111111');
      return { rows: [{ id, name: 'Work', color: '#123456', source: 'local', read_only: false, display_visible: true, collection_id: null, provider: null, provider_identity: null, account_id: null, account_email: null, import_source_id: null, import_kind: null, import_label: null, feature_enabled: true }] };
    }
    if (typeof sql === 'string' && (sql.includes('user_calendar_source_preferences') || sql.includes('user_calendar_presentation_preferences') || sql.includes("preferences->'calendarContactAppearance'"))) return { rows: [] };
    if (typeof sql === 'string' && sql.includes('FROM calendar_occurrences o')) return { rows: occurrences };
    if (typeof sql === 'string' && sql.includes('contact_dates')) return { rows: contacts };
    return { rows: events };
  });
}

describe('local calendar API', () => {

  it('rejects a CalDAV source without dedicated remote credentials', async () => {
    const response = await fetch(`${base}/api/calendar/sources`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'caldav', url: 'https://calendar.example/dav/', displayName: 'Work' }),
    });

    expect(response.status).toBe(400);
    expect((await response.json())).toEqual({ error: 'CalDAV sources require username and password' });
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects source URLs that embed credentials', async () => {
    const response = await fetch(`${base}/api/calendar/sources`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'ical_url', url: 'https://user:password@calendar.example/events.ics', displayName: 'Work' }),
    });

    expect(response.status).toBe(400);
    expect((await response.json())).toEqual({ error: 'Source URL must not include credentials' });
    expect(query).not.toHaveBeenCalled();
  });

  it('normalizes a webcal source to HTTPS before storing it', async () => {
    query.mockImplementation(async (sql: string) => sql.includes('INSERT INTO calendar_import_sources')
      ? { rows: [{ id: 'source-1', kind: 'ical_url', url: 'https://calendar.example/events.ics', display_name: 'Work' }] }
      : { rows: [] });
    const response = await fetch(`${base}/api/calendar/sources`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'ical_url', url: 'webcal://calendar.example/events.ics', displayName: 'Work' }),
    });

    expect(response.status).toBe(201);
    expect((await response.json())).toEqual({
      source: expect.not.objectContaining({ url: expect.anything(), username: expect.anything(), password: expect.anything(), url_fingerprint: expect.anything() }),
      sync: { ok: true },
    });
    const [, insertParameters] = queryCallContaining('INSERT INTO calendar_import_sources');
    expect(queryParameter(insertParameters, 2)).toBe('enc:v1:https://calendar.example/events.ics');
    expect(queryParameter(insertParameters, 3)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('does not expose database details when a legacy writer is rejected', async () => {
    query.mockRejectedValueOnce(Object.assign(new Error('Calendar source URLs must be encrypted before storage'), {
      code: '23514', detail: 'https://calendar.example/events.ics?token=REPRO_SECRET',
    }));
    const response = await fetch(`${base}/api/calendar/sources`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'ical_url', url: 'https://calendar.example/events.ics?token=REPRO_SECRET', displayName: 'Work' }),
    });

    expect(response.status).toBe(409);
    const payload = responseRecord(await response.json());
    expect(payload).toEqual({ error: 'Calendar source URL could not be stored securely' });
    expect(JSON.stringify(payload)).not.toContain('REPRO_SECRET');
  });

  it('redacts all source secrets from the listing payload', async () => {
    query.mockResolvedValueOnce({ rows: [{
      id: 'source-1', kind: 'ical_url', url: 'enc:v1:ciphertext', username: 'remote-user', password: 'enc:v1:password',
      url_fingerprint: 'fingerprint', display_name: 'Work', color: null, interval_min: 60, enabled: true,
      last_sync_at: null, last_error: 'failure enc:v1:ciphertext',
    }] });

    const response = await fetch(`${base}/api/calendar/sources`);

    expect(response.status).toBe(200);
    const payload = responseRecord(await response.json());
    expect(payload.sources).toEqual([{ id: 'source-1', kind: 'ical_url', displayName: 'Work', color: null, intervalMin: 60, enabled: true, lastSyncAt: null, lastError: 'failure [redacted]' }]);
    expect(JSON.stringify(payload)).not.toContain('ciphertext');
    expect(JSON.stringify(payload)).not.toContain('remote-user');
  });

  it('returns the actual first-sync result instead of an unconditional add success', async () => {
    syncCalendarSource.mockResolvedValueOnce({ ok: true, eventCount: 2, skipped: [{ uid: 'bad', reason: 'unsupported or malformed VEVENT' }] });
    query.mockImplementation(async (sql: string) => sql.includes('INSERT INTO calendar_import_sources')
      ? { rows: [{ id: 'source-1', kind: 'ical_url', url: 'https://calendar.example/events.ics', display_name: 'Work' }] }
      : { rows: [] });

    const response = await fetch(`${base}/api/calendar/sources`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'ical_url', url: 'https://calendar.example/events.ics', displayName: 'Work' }),
    });

    expect(response.status).toBe(201);
    expect((await response.json())).toEqual({ source: expect.objectContaining({ id: 'source-1' }), sync: { ok: true, eventCount: 2, skipped: [{ uid: 'bad', reason: 'unsupported or malformed VEVENT' }] } });
  });

  it('reports a persisted source first-sync failure with a differentiated status', async () => {
    syncCalendarSource.mockResolvedValueOnce({ ok: false, error: 'network unavailable' });
    query.mockImplementation(async (sql: string) => sql.includes('INSERT INTO calendar_import_sources')
      ? { rows: [{ id: 'source-1', kind: 'ical_url', url: 'https://calendar.example/events.ics', display_name: 'Work' }] }
      : { rows: [] });

    const response = await fetch(`${base}/api/calendar/sources`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'ical_url', url: 'https://calendar.example/events.ics', displayName: 'Work' }),
    });

    expect(response.status).toBe(502);
    expect((await response.json())).toEqual({ error: 'network unavailable', source: expect.objectContaining({ id: 'source-1' }), sync: { ok: false, error: 'network unavailable' } });
    expect(scheduleCalendarSource).toHaveBeenCalled();
  });

  it('does not stop an unknown or unauthorized source', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    const response = await fetch(`${base}/api/calendar/sources/missing-source`, { method: 'DELETE' });

    expect(response.status).toBe(404);
    expect(stopCalendarSource).not.toHaveBeenCalled();
    expect(releaseCalendarSource).not.toHaveBeenCalled();
  });

  it('restores scheduling and releases removal state when source deletion fails', async () => {
    const source = { id: 'source-1', kind: 'ical_url', url: 'https://calendar.example/events.ics', display_name: 'Work', interval_min: 60 };
    query
      .mockResolvedValueOnce({ rows: [source] })
      .mockRejectedValueOnce(new Error('source delete failed'));

    const response = await fetch(`${base}/api/calendar/sources/source-1`, { method: 'DELETE' });

    expect(response.status).toBe(500);
    expect(scheduleCalendarSource).toHaveBeenCalledWith(source);
    expect(releaseCalendarSource).toHaveBeenCalledWith('source-1');
  });

  it('releases removal state when projection deletion fails after source deletion', async () => {
    const source = { id: 'source-1', kind: 'ical_url', url: 'https://calendar.example/events.ics', display_name: 'Work', interval_min: 60 };
    query
      .mockResolvedValueOnce({ rows: [source] })
      .mockResolvedValueOnce({ rows: [{ id: 'source-1' }] })
      .mockRejectedValueOnce(new Error('projection delete failed'));

    const response = await fetch(`${base}/api/calendar/sources/source-1`, { method: 'DELETE' });

    expect(response.status).toBe(500);
    expect(scheduleCalendarSource).not.toHaveBeenCalled();
    expect(releaseCalendarSource).toHaveBeenCalledWith('source-1');
  });

  it('lists only calendars owned by the signed-in user', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'calendar-1', name: 'Personal', source: 'local', read_only: false }] });

    const response = await fetch(`${base}/api/calendar/calendars`);

    expect(response.status).toBe(200);
    expect(responseArray(await response.json(), 'calendars')).toContainEqual({ id: 'calendar-1', name: 'Personal', source: 'local', read_only: false });
    // The list is aliased so the write-back collection id can be joined in without an extra query.
    expect(queryCall(0)[0]).toContain('WHERE c.user_id = $1 AND c.owner_user_id = $1');
    expect(queryCall(0)[1]).toEqual(['user-1']);
  });

  it('adds the read-only contact dates calendar without persisting a duplicate resource', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'calendar-1', name: 'Personal', source: 'local', read_only: false }] });

    const response = await fetch(`${base}/api/calendar/calendars`);

    expect(response.status).toBe(200);
    expect(responseArray(await response.json(), 'calendars')).toContainEqual(expect.objectContaining({ id: 'contacts-birthdays', source: 'contacts', read_only: true }));
  });

  it('creates an account-owned local calendar with display metadata', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'calendar-2', owner_user_id: 'user-1', name: 'Work', color: '#123456', display_visible: true, source: 'local', read_only: false }] });

    const response = await fetch(`${base}/api/calendar/calendars`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Work', color: '#123456', displayVisible: true }),
    });

    expect(response.status).toBe(201);
    expect(responseObject(await response.json(), 'calendar')).toMatchObject({ id: 'calendar-2', name: 'Work' });
    expect(queryCall(0)[0]).toContain('owner_user_id');
    expect(queryCall(0)[1]).toEqual(['user-1', 'Work', '#123456', true]);
  });

  it('updates only an owned local calendar', async () => {
    query.mockResolvedValueOnce({ rows: [{ source: 'local' }] }).mockResolvedValueOnce({ rows: [{ id: 'calendar-2', owner_user_id: 'user-1', name: 'Updated', color: '#abcdef', display_visible: false, source: 'local', read_only: false }] });

    const response = await fetch(`${base}/api/calendar/calendars/calendar-2`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Updated', color: '#abcdef', displayVisible: false }),
    });

    expect(response.status).toBe(200);
    expect(responseObject(await response.json(), 'calendar')).toMatchObject({ name: 'Updated', display_visible: false });
    expect(queryCall(1)[0]).toContain("owner_user_id = $6 AND user_id = $6 AND source = 'local'");
    // davMode is omitted here, which keeps the stored mode (COALESCE) unchanged.
    expect(queryCall(1)[0]).toContain('dav_mode = COALESCE($4, dav_mode)');
    expect(queryCall(1)[1]).toEqual(['Updated', '#abcdef', false, null, 'calendar-2', 'user-1']);
  });

  it('stores a DAV sharing mode on an owned calendar and rejects an unknown one', async () => {
    query.mockResolvedValueOnce({ rows: [{ source: 'local' }] }).mockResolvedValueOnce({ rows: [{ id: 'calendar-2', name: 'Work', color: '#123456', display_visible: true, source: 'local', read_only: false, dav_mode: 'read_only' }] });
    const response = await fetch(`${base}/api/calendar/calendars/calendar-2`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Work', color: '#123456', displayVisible: true, davMode: 'read_only' }),
    });
    expect(response.status).toBe(200);
    expect(responseObject(await response.json(), 'calendar').dav_mode).toBe('read_only');
    expect(queryCall(1)[1][3]).toBe('read_only');

    query.mockClear();
    const invalid = await fetch(`${base}/api/calendar/calendars/calendar-2`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Work', color: '#123456', displayVisible: true, davMode: 'shared' }),
    });
    expect(invalid.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('refuses DAV sharing for the synthetic contact-dates calendar', async () => {
    const response = await fetch(`${base}/api/calendar/calendars/contacts-birthdays`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Contact dates', color: '#e879f9', displayVisible: true, davMode: 'read_write' }),
    });
    expect(response.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('refuses generic local metadata edits on an imported provider calendar', async () => {
    query.mockResolvedValueOnce({ rows: [{ source: 'ical_url' }] });
    const response = await fetch(`${base}/api/calendar/calendars/remote-calendar`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Work', color: '#123456', displayVisible: true }),
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'Provider calendars cannot be edited here' });
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('persists contact calendar appearance per user while retaining translated default names', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const response = await fetch(`${base}/api/calendar/calendars/contacts-birthdays`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Daty kontaktów', color: '#123456', displayVisible: true, customName: false }),
    });
    expect(response.status).toBe(200);
    expect(queryParameters(0)[0]).toBe('user-1');
    expect(JSON.parse(queryStringParameter(0, 1))).toMatchObject({ name: null, color: '#123456' });
    expect(responseObject(await response.json(), 'calendar')).toMatchObject({ read_only: true, custom_name: false });
  });
  it('returns a custom contact calendar name and color after reload', async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ appearance: { name: 'Rodzina', color: '#123456' } }] });
    const response = await fetch(`${base}/api/calendar/calendars`);
    expect(responseArray(await response.json(), 'calendars')[0]).toMatchObject({ name: 'Rodzina', custom_name: true, color: '#123456', read_only: true });
  });
  it('requires exact calendar-name confirmation before deleting an owned calendar', async () => {
    // The capability decision loads the row, then the scoped DELETE returns it.
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-2', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-2' }] });

    const response = await fetch(`${base}/api/calendar/calendars/calendar-2`, {
      method: 'DELETE', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmName: 'Work' }),
    });

    expect(response.status).toBe(204);
    // The capability model decides on the loaded row first; the DELETE is then
    // scoped to the same owner and confirmed name.
    expect(queryCall(0)[0]).toContain('SELECT id, source, read_only FROM calendars');
    const [deleteSql, deleteParameters] = queryCallContaining('DELETE FROM calendars');
    expect(deleteSql).toContain('owner_user_id = $2');
    expect(deleteParameters).toEqual(['calendar-2', 'user-1', 'Work']);
  });

  it('refuses provider calendar deletion instead of deleting its local projection', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'provider-calendar', source: 'google', read_only: false, source_access: 'read_write', user_access: 'read_write' }] });
    const response = await fetch(`${base}/api/calendar/calendars/provider-calendar`, {
      method: 'DELETE', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmName: 'Work' }),
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'Provider calendars cannot be deleted here' });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('does not delete a calendar when server-side confirmation does not match', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const response = await fetch(`${base}/api/calendar/calendars/calendar-2`, {
      method: 'DELETE', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmName: 'Other' }),
    });

    expect(response.status).toBe(404);
    expect(queryCall(0)[0]).toContain('name = $3');
  });

  it('rejects an excessively broad event range before querying the database', async () => {
    const response = await fetch(`${base}/api/calendar/events?from=2026-01-01T00:00:00.000Z&to=2028-01-02T00:00:00.000Z`);

    expect(response.status).toBe(400);
    expect((await response.json())).toEqual({ error: 'The requested event range is too large' });
    expect(query).not.toHaveBeenCalled();
  });

  it('projects a labelled-only contact date and selects the JSON date column', async () => {
    mockEventRead({ contacts: [{
      id: 'contact-1', display_name: 'Ada', primary_email: 'ada@example.test', birthday: null, anniversary: null,
      contact_dates: [{ label: 'Wedding', value: '2020-09-14' }],
    }] });

    const response = await fetch(`${base}/api/calendar/events?from=2026-09-01T00:00:00.000Z&to=2026-10-01T00:00:00.000Z`);
    const { events } = calendarEventsResponse(await response.json());

    expect(response.status).toBe(200);
    expect(query.mock.calls.some(([sql]) => typeof sql === 'string' && sql.includes('contact_dates'))).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      calendar_id: 'contacts-birthdays', uid: expect.stringMatching(/^contacts-contact-1-/), summary: 'Wedding: Ada', contact_date_label: 'Wedding', contact_name: 'Ada',
      starts_at: '2026-09-14T00:00:00.000Z', ends_at: '2026-09-15T00:00:00.000Z', all_day: true,
      source: 'contacts', read_only: true,
    });
  });

  it('deduplicates a legacy date mirrored in labelled contact dates', async () => {
    mockEventRead({ contacts: [{
      id: 'contact-1', display_name: 'Ada', birthday: '1990-01-02', anniversary: null,
      contact_dates: [{ label: 'Birthday', value: '1990-01-02' }, { label: 'Wedding', value: '2020-09-14' }],
    }] });

    const response = await fetch(`${base}/api/calendar/events?from=2026-01-01T00:00:00.000Z&to=2027-01-01T00:00:00.000Z`);
    const { events } = calendarEventsResponse(await response.json());

    expect(response.status).toBe(200);
    expect(events).toHaveLength(2);
    expect(events.map(event => event.summary)).toEqual(expect.arrayContaining(['Birthday: Ada', 'Wedding: Ada']));
  });

  it('projects a birthday without a year on leap day without inventing a birth year', async () => {
    mockEventRead({ contacts: [{
      id: 'contact-1', display_name: 'Ada', birthday: null, contact_dates: [{ label: 'Birthday', value: '--02-29' }],
    }] });
    const response = await fetch(`${base}/api/calendar/events?from=2028-02-01T00:00:00.000Z&to=2028-03-01T00:00:00.000Z`);
    expect(response.status).toBe(200);
    const { events } = calendarEventsResponse(await response.json());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ contact_date_label: 'Birthday', starts_at: '2028-02-29T00:00:00.000Z' });
  });

  it('keeps normalized-label collisions distinct and ignores malformed contact dates', async () => {
    mockEventRead({ contacts: [{
      id: 'contact-1', display_name: 'Ada', birthday: null, anniversary: null,
      contact_dates: [
        { label: 'Family Other', value: '2020-09-14' }, { label: 'Family-Other', value: '2020-09-14' },
        { label: 'Broken', value: 'not-a-date' }, { label: 'Impossible', value: '2020-02-30' },
      ],
    }] });

    const response = await fetch(`${base}/api/calendar/events?from=2026-09-01T00:00:00.000Z&to=2026-10-01T00:00:00.000Z`);
    const { events } = calendarEventsResponse(await response.json());

    expect(response.status).toBe(200);
    expect(events).toHaveLength(2);
    expect(new Set(events.map(event => event.uid)).size).toBe(2);
    expect(events.map(event => event.summary)).toEqual(expect.arrayContaining(['Family Other: Ada', 'Family-Other: Ada']));
  });

  // A materialised occurrence is returned straight from the store with no expansion at all.
  // This is the path that replaced walking every series from its origin, so it must actually
  // be exercised — and it must not leak the raw ICS, which the expansion path strips.
  it('serves a materialised occurrence without expanding the series', async () => {
    mockEventRead({ occurrences: [{
      id: 'event-1@20260907T070000Z', series_id: 'event-1', recurring: true,
      recurrence_id: '20260907T070000Z', starts_at: '2026-09-07T07:00:00.000Z', ends_at: '2026-09-07T07:30:00.000Z',
      all_day: false, timezone: 'Europe/Warsaw', summary: 'From the store', description: 'Stored body',
      location: null, url: null, organizer: null, attendees: [], calendar_id: 'calendar-1', uid: 'uid-1',
      etag: 'etag-1', invite_account_id: null, invitation_sequence: 0, source_message_id: null,
      source_folder: null, source_account_id: null, calendar_name: 'Personal', calendar_color: '#123456',
      source: 'local', read_only: false,
    }] });

    const response = await fetch(`${base}/api/calendar/events?from=2026-09-01T00:00:00.000Z&to=2026-10-01T00:00:00.000Z`);
    const { events, truncated } = calendarEventsResponse(await response.json());

    expect(response.status).toBe(200);
    expect(truncated).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: 'event-1@20260907T070000Z', series_id: 'event-1', summary: 'From the store',
      starts_at: '2026-09-07T07:00:00.000Z', description: 'Stored body',
    });
    expect(events[0]).not.toHaveProperty('raw_ical');
    // Nothing needed expansion, so no series is reported as incomplete.
    expect(events[0]).not.toHaveProperty('incompleteSeries');
  });

  it('merges materialised occurrences with the live fallback for uncovered events', async () => {
    // One event the worker has built, and one series it has not reached yet: both must appear,
    // which is what makes a lagging worker a performance problem rather than a missing event.
    const raw = outlookCalendar('09', 'DTSTAMP:20260901T090000Z\r\n');
    query.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('FROM calendar_occurrences o')) {
        return { rows: [{
          id: 'built-1', series_id: null, recurring: false, recurrence_id: '',
          starts_at: '2026-09-02T07:00:00.000Z', ends_at: '2026-09-02T08:00:00.000Z', all_day: false,
          timezone: null, summary: 'Built', description: null, location: null, url: null, organizer: null,
          attendees: [], calendar_id: 'calendar-1', uid: 'built-1', etag: 'etag-1', invite_account_id: null,
          invitation_sequence: 0, source_message_id: null, source_folder: null, source_account_id: null,
          calendar_name: 'Personal', calendar_color: '#123456', source: 'local', read_only: false,
        }] };
      }
      if (typeof sql === 'string' && sql.includes('contact_dates')) return { rows: [] };
      return { rows: [{ id: 'fallback-1', uid: 'fallback-1', summary: 'Fallback', starts_at: '2026-09-03T07:00:00Z', ends_at: '2026-09-03T08:00:00Z', all_day: false, description: null, location: null, url: null, organizer: null, attendees: [], raw_ical: raw, etag: 'etag-2', calendar_id: 'calendar-1', calendar_name: 'Personal', calendar_color: '#123456', source: 'local', read_only: false }] };
    });

    const response = await fetch(`${base}/api/calendar/events?from=2026-09-01T00:00:00.000Z&to=2026-10-01T00:00:00.000Z`);
    const { events } = calendarEventsResponse(await response.json());

    expect(response.status).toBe(200);
    // Ordering is by start time; the fallback event's summary comes from its ICS (the
    // expansion is authoritative over the denormalised row), so assert identity, not text.
    expect(events).toHaveLength(2);
    expect(events[0].summary).toBe('Built');
    expect(events[1].id).toBe('fallback-1');
  });

  // "Cancel this and every following occurrence". The series has to be ended by truncating
  // its rule: a `RECURRENCE-ID;RANGE=THISANDFUTURE` exception with STATUS:CANCELLED was
  // measured and leaves the series completely unchanged.
  describe('cancelling a series from an occurrence onward', () => {
    const daily = () => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:uid-1',
      'DTSTART;TZID=Europe/Warsaw:20260105T090000', 'DTEND;TZID=Europe/Warsaw:20260105T100000',
      'RRULE:FREQ=DAILY;COUNT=10', 'SUMMARY:Daily', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    const startsOf = (raw: string) => projectCalendarResource({ id: 'event-1', uid: 'uid-1', raw_ical: raw, summary: 'Daily' }, new Date('2026-01-01'), new Date('2026-03-01'))
      .map(event => {
        if (!event.starts_at) throw new Error('Projected calendar event is missing starts_at');
        return event.starts_at.toISOString().slice(5, 16);
      });
    const cancel = (body: unknown) => fetch(`${base}/api/calendar/events/event-1/occurrence`, {
      method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });

    it('ends the series just before the named occurrence', async () => {
      query.mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
        .mockResolvedValueOnce({ rows: [{ uid: 'uid-1', raw_ical: daily(), invite_account_id: null }] })
        .mockResolvedValueOnce({ rows: [] });

      const response = await cancel({ calendarId: 'calendar-1', recurrenceId: '2026-01-09T09:00:00', scope: 'following' });
      expect(response.status).toBe(200);
      expect(responseRecord(await response.json()).scope).toBe('following');

      const [, updateParameters] = queryCallContaining('UPDATE calendar_events SET raw_ical');
      // The stored resource itself must only produce the occurrences before the cut.
      const rawIcal = updateParameters[0];
      if (typeof rawIcal !== 'string') throw new Error('Updated calendar resource is not a string');
      expect(startsOf(rawIcal)).toEqual(['01-05T08:00', '01-06T08:00', '01-07T08:00', '01-08T08:00']);
    });

    it('removes the event when the cut leaves no occurrences at all', async () => {
      query.mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
        .mockResolvedValueOnce({ rows: [{ uid: 'uid-1', raw_ical: daily(), invite_account_id: null }] })
        .mockResolvedValueOnce({ rows: [] });

      const response = await cancel({ calendarId: 'calendar-1', recurrenceId: '2026-01-05T09:00:00', scope: 'following' });
      expect(response.status).toBe(200);
      // A series that produces nothing must not be left behind as an empty shell.
      const deletion = query.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('DELETE FROM calendar_events'));
      expect(deletion).toBeTruthy();
      expect(query.mock.calls.some(([sql]) => typeof sql === 'string' && sql.includes('UPDATE calendar_events SET raw_ical'))).toBe(false);
    });

    it('still cancels a single occurrence by default', async () => {
      query.mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
        .mockResolvedValueOnce({ rows: [{ uid: 'uid-1', raw_ical: daily(), invite_account_id: null }] })
        .mockResolvedValueOnce({ rows: [] });

      const response = await cancel({ calendarId: 'calendar-1', recurrenceId: '2026-01-09T09:00:00' });
      expect(response.status).toBe(200);
      expect(responseRecord(await response.json()).scope).toBe('single');

      const [, updateParameters] = queryCallContaining('UPDATE calendar_events SET raw_ical');
      const rawIcal = updateParameters[0];
      if (typeof rawIcal !== 'string') throw new Error('Updated calendar resource is not a string');
      // One occurrence is excluded; the rest of the series is untouched.
      expect(startsOf(rawIcal)).toHaveLength(9);
      expect(startsOf(rawIcal)).not.toContain('01-09T08:00');
      expect(startsOf(rawIcal)).toContain('01-14T08:00');
    });

    it('mutates an invited series occurrence and tells the attendees, in one sequence', async () => {
      query.mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
        .mockResolvedValueOnce({ rows: [{
          uid: 'uid-1', raw_ical: daily(), invite_account_id: 'account-1', invitation_sequence: 2,
          summary: 'Daily', description: null, location: null, starts_at: '2026-01-05T09:00:00.000Z',
          ends_at: '2026-01-05T10:00:00.000Z', all_day: false, attendees: ['guest@example.test'],
        }] })
        .mockResolvedValueOnce({ rows: [{ id: 'account-1', email_address: 'me@example.test', smtp_host: 'smtp.example.test' }] })
        .mockResolvedValueOnce({ rows: [] });

      const response = await cancel({ calendarId: 'calendar-1', recurrenceId: '2026-01-09T09:00:00', scope: 'following' });

      expect(response.status).toBe(200);
      // The series is truncated locally and the sequence advanced, so the cancellation is not a second
      // message a client would ignore as already seen.
      const [, updateParameters] = queryCallContaining('UPDATE calendar_events SET raw_ical');
      expect(String(updateParameters[0])).toContain('UNTIL=');
      expect(String(queryCallContaining('UPDATE calendar_events SET raw_ical')[0])).toContain('invitation_sequence = invitation_sequence + 1');
      // The attendees are told: an update whose rule no longer contains the removed occurrences.
      expect(sendCalendarInvitation).toHaveBeenCalledWith(expect.objectContaining({
        method: 'REQUEST', sequence: 3, attendees: ['guest@example.test'], uid: 'uid-1',
      }));
      expect(String((sendCalendarInvitation.mock.calls[0]?.[0] as { rrule?: string }).rrule)).toContain('UNTIL=');
    });

    it('cancels one occurrence of an invited series with a RECURRENCE-ID message', async () => {
      query.mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
        .mockResolvedValueOnce({ rows: [{
          uid: 'uid-1', raw_ical: daily(), invite_account_id: 'account-1', invitation_sequence: 0,
          summary: 'Daily', description: null, location: null, starts_at: '2026-01-05T09:00:00.000Z',
          ends_at: '2026-01-05T10:00:00.000Z', all_day: false, attendees: ['guest@example.test'],
        }] })
        .mockResolvedValueOnce({ rows: [{ id: 'account-1', email_address: 'me@example.test', smtp_host: 'smtp.example.test' }] })
        .mockResolvedValueOnce({ rows: [] });

      const response = await cancel({ calendarId: 'calendar-1', recurrenceId: '2026-01-09T09:00:00Z', scope: 'single' });

      expect(response.status).toBe(200);
      expect(sendCalendarInvitation).toHaveBeenCalledWith(expect.objectContaining({
        method: 'CANCEL', sequence: 1, recurrenceId: '2026-01-09T09:00:00Z',
      }));
    });

    it('edits this-and-following by truncating the series and starting a new one at the occurrence', async () => {
      query.mockResolvedValue({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
        .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
        .mockResolvedValueOnce({ rows: [{ uid: 'uid-1', raw_ical: daily(), invite_account_id: null }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const response = await fetch(`${base}/api/calendar/events/event-1/occurrence`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          calendarId: 'calendar-1', recurrenceId: '2026-01-09T09:00:00', scope: 'following',
          summary: 'Daily (moved)', startsAt: '2026-01-09T11:00:00.000Z', endsAt: '2026-01-09T12:00:00.000Z',
        }),
      });
      expect(response.status).toBe(200);

      // The earlier part is truncated, and the remainder becomes its own series whose UID is derived from the
      // master and the occurrence — so the same edit twice updates that remainder instead of adding a second.
      const [, truncateParameters] = queryCallContaining('UPDATE calendar_events SET raw_ical');
      const truncated = truncateParameters[0];
      if (typeof truncated !== 'string') throw new Error('Truncated calendar resource is not a string');
      expect(startsOf(truncated)).toHaveLength(4);
      expect(startsOf(truncated)).not.toContain('01-09T08:00');

      const insert = query.mock.calls.find(([statement]) => String(statement).includes('INSERT INTO calendar_events'));
      expect(insert).toBeDefined();
      const parameters = insert?.[1] as unknown[];
      expect(parameters[2]).toBe('uid-1#20260109T090000');
      expect(String(parameters[3])).toContain('RRULE:FREQ=DAILY;COUNT=10');
      expect(String(parameters[3])).toContain('SUMMARY:Daily (moved)');
      expect(String(parameters[3])).toContain('UID:uid-1#20260109T090000');
    });
  });

  it('requires a sender account and attendee list before sending invitations', async () => {
    const response = await fetch(`${base}/api/calendar/events`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        calendarId: 'calendar-1', sendInvites: true, attendees: ['guest@example.test'],
        startsAt: '2026-09-01T09:00:00.000Z', endsAt: '2026-09-01T10:00:00.000Z',
      }),
    });

    expect(response.status).toBe(400);
    expect((await response.json())).toEqual({ error: 'A sender account and at least one attendee are required for invitations' });
    expect(query).not.toHaveBeenCalled();
  });


  it('persists rejected POST invite recipients without an idempotency header (V4-07)', async () => {
    const sender = { id: 'account-1', email_address: 'owner@example.test', smtp_host: 'smtp.example.test', enabled: true };
    let storedPayload: { actions?: unknown } | null = null;
    let retryPayload: unknown;
    query.mockImplementation(async (statement: string, parameters?: unknown[]) => {
      if (statement.includes('FROM calendars')) return { rows: [{ id: 'calendar-1', source: 'local', read_only: false }] };
      if (statement.includes('FROM email_accounts')) return { rows: [sender] };
      if (statement.includes('FROM calendar_invitation_outbox') && statement.startsWith('SELECT')) return { rows: [] };
      if (statement.includes('INSERT INTO calendar_events')) return { rows: [{ id: 'event-1', calendar_id: 'calendar-1', uid: 'uid-1', invitation_sequence: 0 }] };
      if (statement.includes('INSERT INTO calendar_invitation_outbox')) { storedPayload = JSON.parse(String(parameters?.[4])); return { rows: [{ id: 'outbox-1' }] }; }
      if (statement.includes("SET status = 'processing'")) return { rows: [{ id: 'outbox-1', user_id: 'user-1', payload: storedPayload, invite_account_id: 'account-1' }], rowCount: 1 };
      if (statement.includes('SET claim_expires_at')) return { rows: [{ id: 'outbox-1' }], rowCount: 1 };
      if (statement.includes("SET status = 'failed'")) { retryPayload = JSON.parse(String(parameters?.[3])); return { rows: [{ attempts: 1 }], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    });
    sendCalendarInvitation.mockResolvedValueOnce({ accepted: ['accepted@example.test'], rejected: ['rejected@example.test'] });

    const response = await fetch(base + '/api/calendar/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ calendarId: 'calendar-1', summary: 'Planning', sendInvites: true, inviteAccountId: 'account-1', attendees: ['accepted@example.test', 'rejected@example.test'], startsAt: '2026-09-01T09:00:00.000Z', endsAt: '2026-09-01T10:00:00.000Z' }) });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ invitationStatus: { status: 'failed' } });
    expect(retryPayload).toEqual([expect.objectContaining({ attendees: ['rejected@example.test'] })]);
    const insert = query.mock.calls.find(([statement]) => String(statement).includes('INSERT INTO calendar_invitation_outbox'));
    expect(String(insert?.[1]?.[2])).toMatch(/^server:/);
  });

  it('uses only the selected owned SMTP account to deliver a calendar invitation', async () => {
    const sender = { id: 'account-1', email_address: 'owner@example.test', smtp_host: 'smtp.example.test', enabled: true };
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [sender] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'event-1', calendar_id: 'calendar-1', uid: 'uid-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-1' }] });

    const response = await fetch(`${base}/api/calendar/events`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        calendarId: 'calendar-1', summary: 'Planning', sendInvites: true, inviteAccountId: 'account-1', attendees: ['guest@example.test'],
        startsAt: '2026-09-01T09:00:00.000Z', endsAt: '2026-09-01T10:00:00.000Z',
      }),
    });

    expect(response.status).toBe(201);
    expect(queryCall(1)[0]).toContain('id = $1 AND user_id = $2');
    expect(queryCall(1)[1]).toEqual(['account-1', 'user-1']);
    expect(queryCall(3)[0]).toContain('attendees, invite_account_id');
    // attendees is a jsonb column: the driver must receive a JSON string, never a
    // JavaScript array (node-postgres would render that as a PostgreSQL array
    // literal, which jsonb rejects with "invalid input syntax for type json").
    expect(queryCall(3)[1]).toContainEqual(JSON.stringify(['guest@example.test']));
    expect(sendCalendarInvitation).not.toHaveBeenCalled();
  });

  it('stores a valid iCalendar representation when creating a local event', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [{ id: 'event-1', calendar_id: 'calendar-1', uid: 'uid-1', summary: 'Planning' }] })
      .mockResolvedValueOnce({ rows: [] });

    const response = await fetch(`${base}/api/calendar/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        calendarId: 'calendar-1', summary: 'Planning; review', description: 'Bring notes\nDiscuss scope',
        location: 'Room, 2', startsAt: '2026-09-01T09:00:00.000Z', endsAt: '2026-09-01T10:00:00.000Z',
      }),
    });

    expect(response.status).toBe(201);
    expect(queryCall(1)[0]).toContain('raw_ical');
    expect(queryCall(1)[1][3]).toMatch(/^BEGIN:VCALENDAR\r\nVERSION:2.0\r\n/);
    expect(queryCall(1)[1][3]).toContain('SUMMARY:Planning\\; review');
    expect(queryCall(1)[1][3]).toContain('DESCRIPTION:Bring notes\\nDiscuss scope');
    expect(queryCall(1)[1][3]).toContain('LOCATION:Room\\, 2');
    expect(queryCall(1)[1][3]).toContain('DTSTART:20260901T090000Z');
  });

  it('sanitizes a rich-text description and writes it as DESCRIPTION plus X-ALT-DESC', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [{ id: 'event-1', calendar_id: 'calendar-1', uid: 'uid-1', summary: 'Planning' }] })
      .mockResolvedValueOnce({ rows: [] });

    const response = await fetch(`${base}/api/calendar/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        calendarId: 'calendar-1', summary: 'Planning',
        description: '<p>Bring notes</p><script>steal()</script><p>Discuss scope</p>',
        startsAt: '2026-09-01T09:00:00.000Z', endsAt: '2026-09-01T10:00:00.000Z',
      }),
    });

    expect(response.status).toBe(201);
    // Stored value is the sanitized HTML, never the script.
    expect(queryCall(1)[1][5]).toBe('<p>Bring notes</p><p>Discuss scope</p>');
    const raw = queryCall(1)[1][3];
    // Plain calendar clients still get a readable DESCRIPTION, HTML clients get
    // the formatted alternative (RFC 5545 section 3.8.8.2).
    expect(raw).toContain('DESCRIPTION:Bring notes\\nDiscuss scope');
    expect(raw).toContain('X-ALT-DESC;FMTTYPE=text/html:<p>Bring notes</p><p>Discuss scope</p>');
    expect(raw).not.toContain('steal');
  });

  it('escapes lone carriage returns in local iCalendar text', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [{ id: 'event-1' }] });

    const response = await fetch(`${base}/api/calendar/events`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ calendarId: 'calendar-1', description: 'Details\rX-INJECTED: true', startsAt: '2026-09-01T09:00:00.000Z', endsAt: '2026-09-01T10:00:00.000Z' }),
    });

    expect(response.status).toBe(201);
    const rawIcal = queryCall(1)[1][3];
    expect(rawIcal).toContain('DESCRIPTION:Details\\nX-INJECTED: true');
    expect(rawIcal).not.toContain('\rX-INJECTED: true');
  });

  it('folds long serialized iCalendar content lines without splitting UTF-8 characters', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [{ id: 'event-1' }] });

    const response = await fetch(`${base}/api/calendar/events`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        calendarId: 'calendar-1', summary: `Release ${'ż'.repeat(40)}`,
        startsAt: '2026-09-01T09:00:00.000Z', endsAt: '2026-09-01T10:00:00.000Z',
      }),
    });

    expect(response.status).toBe(201);
    const rawIcal = queryStringParameter(1, 3);
    expect(rawIcal).toContain('SUMMARY:Release ');
    expect(rawIcal).toContain('\r\n ');
    for (const line of rawIcal.split('\r\n')) expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
  });

  it('uses DATE values for all-day events', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [{ id: 'event-1' }] })
      .mockResolvedValueOnce({ rows: [] });

    const response = await fetch(`${base}/api/calendar/events`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ calendarId: 'calendar-1', allDay: true, startsAt: '2026-09-01T00:00:00.000Z', endsAt: '2026-09-02T00:00:00.000Z' }),
    });

    expect(response.status).toBe(201);
    expect(queryCall(1)[1][3]).toContain('DTSTART;VALUE=DATE:20260901');
    expect(queryCall(1)[1][3]).toContain('DTEND;VALUE=DATE:20260902');
  });

  it('rejects creation in a read-only imported calendar', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'caldav', read_only: true }] });

    const response = await fetch(`${base}/api/calendar/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        calendarId: 'calendar-1',
        summary: 'Read-only event',
        startsAt: '2026-09-01T09:00:00.000Z',
        endsAt: '2026-09-01T10:00:00.000Z',
      }),
    });

    expect(response.status).toBe(403);
    expect((await response.json())).toEqual({ error: 'This calendar is read-only' });
  });
  it('updates only events in a writable calendar owned by the signed-in user', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [{ uid: "uid-1" }] })
      .mockResolvedValueOnce({ rows: [{ id: "event-1", calendar_id: "calendar-1", uid: "uid-1", etag: "etag-2", summary: "Updated" }] })
      .mockResolvedValueOnce({ rows: [] });

    const response = await fetch(`${base}/api/calendar/events/event-1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        calendarId: 'calendar-1',
        summary: 'Updated',
        startsAt: '2026-09-01T11:00:00.000Z',
        endsAt: '2026-09-01T12:00:00.000Z',
      }),
    });

    expect(response.status).toBe(200);
    expect(responseObject(await response.json(), 'event')).toMatchObject({ id: 'event-1', summary: 'Updated' });
    expect(queryCall(2)[0]).toContain("raw_ical = $1");
    expect(queryCall(2)[1][0]).toMatch(/^BEGIN:VCALENDAR\r\nVERSION:2.0\r\n/);
    expect(queryCall(2)[1][0]).toContain("UID:uid-1");
    expect(queryCall(2)[1][0]).toContain("SUMMARY:Updated");
    expect(queryCall(2)[1][0]).toContain("DTSTART:20260901T110000Z");
    expect(queryCall(2)[1]).toContain("event-1");
    expect(queryCall(2)[1]).toContain("user-1");
  });

  it('updates invitation metadata and sends changes with the existing event UID', async () => {
    const sender = { id: 'account-1', email_address: 'owner@example.test', smtp_host: 'smtp.example.test', enabled: true };
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [sender] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ uid: 'uid-1', attendees: ['guest@example.test'], invite_account_id: 'account-1', invitation_sequence: 0 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'event-1', calendar_id: 'calendar-1', uid: 'uid-1', attendees: ['guest@example.test'], invite_account_id: 'account-1', invitation_sequence: 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-1' }] });

    const response = await fetch(`${base}/api/calendar/events/event-1`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        calendarId: 'calendar-1', summary: 'Updated', sendInvites: true, inviteAccountId: 'account-1', attendees: ['guest@example.test'],
        startsAt: '2026-09-01T11:00:00.000Z', endsAt: '2026-09-01T12:00:00.000Z',
      }),
    });

    expect(response.status).toBe(200);
    expect(queryCall(4)[0]).toContain('invitation_sequence = CASE');
    expect(queryCall(4)[0]).toContain('invitation_sequence + 1');
    expect(queryCall(4)[0]).toContain('WHERE id = $13 AND calendar_id = $14 AND user_id = $15');
    expect(queryCall(4)[1]).toContainEqual(JSON.stringify(['guest@example.test']));
    expect(sendCalendarInvitation).not.toHaveBeenCalled();
    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(queryCall(3)[0]).toContain('FOR UPDATE');
  });

  it('cancels a previously sent invitation when invitations are removed', async () => {
    const sender = { id: 'account-1', email_address: 'owner@example.test', smtp_host: 'smtp.example.test', enabled: true };
    const existingEvent = {
      uid: 'uid-1', attendees: ['guest@example.test'], invite_account_id: 'account-1', invitation_sequence: 2,
      summary: 'Planning', description: 'Original details', location: 'Room 1',
      starts_at: '2026-09-01T09:00:00.000Z', ends_at: '2026-09-01T10:00:00.000Z', all_day: false,
    };
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [existingEvent] })
      .mockResolvedValueOnce({ rows: [sender] })
      .mockResolvedValueOnce({ rows: [{ id: 'event-1', calendar_id: 'calendar-1', uid: 'uid-1', attendees: [], invite_account_id: null, invitation_sequence: 3 }] });

    const response = await fetch(`${base}/api/calendar/events/event-1`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        calendarId: 'calendar-1', summary: 'Planning', attendees: [], sendInvites: false,
        startsAt: '2026-09-01T11:00:00.000Z', endsAt: '2026-09-01T12:00:00.000Z',
      }),
    });

    expect(response.status).toBe(200);
    expect(sendCalendarInvitation).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO calendar_invitation_outbox'))).toBe(true);
    expect(queryCall(2)[0]).not.toContain('enabled = true');
  });

  it('returns an uncertain cancellation result and durable operation reference (V7-01)', async () => {
    const sender = { id: 'account-1', email_address: 'owner@example.test', smtp_host: 'smtp.example.test', enabled: true };
    const existing = { uid: 'uid-1', attendees: ['guest@example.test'], invite_account_id: 'account-1', invitation_sequence: 2, summary: 'Planning', description: null, location: null, starts_at: '2026-09-01T09:00:00.000Z', ends_at: '2026-09-01T10:00:00.000Z', all_day: false };
    const event = { id: 'event-1', calendar_id: 'calendar-1', uid: 'uid-1', attendees: [], invite_account_id: null, invitation_sequence: 3 };
    query.mockImplementation(async (statement: string) => {
      if (statement.includes('FROM calendars')) return { rows: [{ id: 'calendar-1', source: 'local', read_only: false }] };
      if (statement.includes('FROM calendar_events') && statement.includes('FOR UPDATE')) return { rows: [existing] };
      if (statement.includes('FROM email_accounts')) return { rows: [sender] };
      if (statement.includes('UPDATE calendar_events SET raw_ical')) return { rows: [event] };
      if (statement.includes('INSERT INTO calendar_invitation_outbox')) return { rows: [{ id: 'cancel-1' }] };
      if (statement.includes('SET cancellation_outbox_id')) return { rows: [{ id: 'event-1' }] };
      if (statement.includes("SET status = 'processing'")) return { rows: [], rowCount: 0 };
      if (statement.includes('SELECT status, last_error')) return { rows: [{ status: 'uncertain', lastError: 'SMTP dispatch outcome is not confirmed' }] };
      return { rows: [] };
    });

    const response = await fetch(`${base}/api/calendar/events/event-1`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ calendarId: 'calendar-1', summary: 'Planning', attendees: [], sendInvites: false, startsAt: '2026-09-01T11:00:00.000Z', endsAt: '2026-09-01T12:00:00.000Z' }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      invitationStatus: { status: 'uncertain', lastError: 'SMTP dispatch outcome is not confirmed' },
      invitationOperation: { kind: 'cancellation', outboxId: 'cancel-1' },
    });
    expect(sendCalendarInvitation).not.toHaveBeenCalled();
  });

  it('rechecks every stored cancellation status without mutating the event (V7-01)', async () => {
    const event = { id: 'event-1', calendar_id: 'calendar-1', uid: 'uid-1', attendees: [], invite_account_id: null, cancellation_outbox_id: 'cancel-1' };
    for (const delivery of [
      { status: 'processing', lastError: null },
      { status: 'uncertain', lastError: 'SMTP dispatch outcome is not confirmed' },
      { status: 'failed', lastError: 'temporary SMTP rejection' },
      { status: 'sent', lastError: null },
    ]) {
      query.mockReset().mockImplementation(async (statement: string) => {
        if (statement.includes('FROM calendars')) return { rows: [{ id: 'calendar-1', source: 'local', read_only: false }] };
        if (statement.includes('JOIN calendar_invitation_outbox')) return { rows: [event] };
        if (statement.includes("SET status = 'processing'")) return { rows: [], rowCount: 0 };
        if (statement.includes('SELECT status, last_error')) return { rows: [delivery] };
        return { rows: [] };
      });
      const response = await fetch(`${base}/api/calendar/events/event-1/cancellation-delivery/retry`, { method: 'POST' });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ invitationStatus: delivery, operation: { kind: 'cancellation', outboxId: 'cancel-1' } });
      expect(query.mock.calls.some(([statement]) => statement.includes('UPDATE calendar_events SET raw_ical'))).toBe(false);
      expect(query.mock.calls.some(([statement]) => statement.includes('INSERT INTO calendar_invitation_outbox'))).toBe(false);
    }
    expect(sendCalendarInvitation).not.toHaveBeenCalled();
  });

  it('cancels attendees removed from an updated invitation', async () => {
    const sender = { id: 'account-1', email_address: 'owner@example.test', smtp_host: 'smtp.example.test', enabled: true };
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [sender] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        uid: 'uid-1', attendees: ['kept@example.test', 'removed@example.test'], invite_account_id: 'account-1', invitation_sequence: 2,
        summary: 'Planning', starts_at: '2026-09-01T09:00:00.000Z', ends_at: '2026-09-01T10:00:00.000Z', all_day: false,
      }] })
      .mockResolvedValueOnce({ rows: [{ id: 'event-1', uid: 'uid-1', attendees: ['kept@example.test'], invite_account_id: 'account-1', invitation_sequence: 3 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-1' }] });

    const response = await fetch(`${base}/api/calendar/events/event-1`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        calendarId: 'calendar-1', summary: 'Planning', sendInvites: true, inviteAccountId: 'account-1', attendees: ['kept@example.test'],
        startsAt: '2026-09-01T11:00:00.000Z', endsAt: '2026-09-01T12:00:00.000Z',
      }),
    });

    expect(response.status).toBe(200);
    expect(sendCalendarInvitation).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO calendar_invitation_outbox'))).toBe(true);
  });

  it('keeps the event unchanged when the previous invitation cannot be cancelled during an update', async () => {
    const sender = { id: 'account-1', email_address: 'owner@example.test', smtp_host: 'smtp.example.test', enabled: true };
    sendCalendarInvitation.mockRejectedValueOnce(new Error('SMTP unavailable'));
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [{
        uid: 'uid-1', attendees: ['guest@example.test'], invite_account_id: 'account-1', invitation_sequence: 2,
        summary: 'Planning', starts_at: '2026-09-01T09:00:00.000Z', ends_at: '2026-09-01T10:00:00.000Z', all_day: false,
      }] })
      .mockResolvedValueOnce({ rows: [sender] })
      .mockResolvedValueOnce({ rows: [{ id: 'event-1', uid: 'uid-1' }] });

    const response = await fetch(`${base}/api/calendar/events/event-1`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        calendarId: 'calendar-1', summary: 'Changed', sendInvites: false, attendees: [],
        startsAt: '2026-09-01T11:00:00.000Z', endsAt: '2026-09-01T12:00:00.000Z',
      }),
    });

    expect(response.status).toBe(200);
    expect(query.mock.calls.some(([sql]: unknown[]) => String(sql).includes('UPDATE calendar_events'))).toBe(true);
    expect(query.mock.calls.some(([sql]: unknown[]) => String(sql).includes('INSERT INTO calendar_invitation_outbox'))).toBe(true);
  });

  it('returns a cancellation failure for an idempotent update when the previous sender is unavailable', async () => {
    const newSender = { id: 'account-new', email_address: 'new@example.test', smtp_host: 'smtp.example.test', enabled: true };
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [newSender] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        uid: 'uid-1', attendees: ['guest@example.test'], invite_account_id: 'account-old', invitation_sequence: 2,
        summary: 'Planning', starts_at: '2026-09-01T09:00:00.000Z', ends_at: '2026-09-01T10:00:00.000Z', all_day: false,
      }] })
      .mockResolvedValueOnce({ rows: [] });

    const response = await fetch(`${base}/api/calendar/events/event-1`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', 'x-idempotency-key': 'retry-1' },
      body: JSON.stringify({
        calendarId: 'calendar-1', summary: 'Planning', sendInvites: true, inviteAccountId: 'account-new', attendees: ['guest@example.test'],
        startsAt: '2026-09-01T11:00:00.000Z', endsAt: '2026-09-01T12:00:00.000Z',
      }),
    });

    expect(response.status).toBe(502);
    expect((await response.json())).toEqual({ error: 'The previous invitation could not be cancelled, so the event was not changed.' });
    expect(query).toHaveBeenCalledTimes(5);
    expect(query.mock.calls.some(([sql]: unknown[]) => String(sql).includes('UPDATE calendar_events'))).toBe(false);
    expect(query.mock.calls.some(([sql]) => /(?:INSERT INTO|UPDATE) calendar_invitation_outbox/.test(sql))).toBe(false);
    expect(sendCalendarInvitation).not.toHaveBeenCalled();
  });

  it('continues the iCalendar sequence when invitations are enabled again', async () => {
    const sender = { id: 'account-1', email_address: 'owner@example.test', smtp_host: 'smtp.example.test', enabled: true };
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [sender] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ uid: 'uid-1', attendees: [], invite_account_id: null, invitation_sequence: 3 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'event-1', uid: 'uid-1', attendees: ['guest@example.test'], invite_account_id: 'account-1', invitation_sequence: 4 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-1' }] });

    const response = await fetch(`${base}/api/calendar/events/event-1`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        calendarId: 'calendar-1', summary: 'Planning', sendInvites: true, inviteAccountId: 'account-1', attendees: ['guest@example.test'],
        startsAt: '2026-09-01T11:00:00.000Z', endsAt: '2026-09-01T12:00:00.000Z',
      }),
    });

    expect(response.status).toBe(200);
    expect(sendCalendarInvitation).not.toHaveBeenCalled();
  });

  it('cancels the prior organizer invitation before changing sender accounts', async () => {
    const oldSender = { id: 'account-old', email_address: 'old@example.test', smtp_host: 'smtp.example.test', enabled: true };
    const newSender = { id: 'account-new', email_address: 'new@example.test', smtp_host: 'smtp.example.test', enabled: true };
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [newSender] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        uid: 'uid-1', attendees: ['guest@example.test'], invite_account_id: 'account-old', invitation_sequence: 2,
        summary: 'Planning', starts_at: '2026-09-01T09:00:00.000Z', ends_at: '2026-09-01T10:00:00.000Z', all_day: false,
      }] })
      .mockResolvedValueOnce({ rows: [oldSender] })
      .mockResolvedValueOnce({ rows: [{ id: 'event-1', uid: 'uid-1', attendees: ['guest@example.test'], invite_account_id: 'account-new', invitation_sequence: 3 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-1' }] });

    const response = await fetch(`${base}/api/calendar/events/event-1`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        calendarId: 'calendar-1', summary: 'Planning', sendInvites: true, inviteAccountId: 'account-new', attendees: ['guest@example.test'],
        startsAt: '2026-09-01T11:00:00.000Z', endsAt: '2026-09-01T12:00:00.000Z',
      }),
    });

    expect(response.status).toBe(200);
    expect(sendCalendarInvitation).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO calendar_invitation_outbox'))).toBe(true);
  });

  it('refuses an event update with an invalid range before querying the database', async () => {
    const response = await fetch(`${base}/api/calendar/events/event-1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ calendarId: 'calendar-1', startsAt: 'invalid', endsAt: '2026-09-01T12:00:00.000Z' }),
    });

    expect(response.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects newline-injected attendees on update before querying the database', async () => {
    const response = await fetch(`${base}/api/calendar/events/event-1`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ calendarId: 'calendar-1', attendees: ['guest@example.test\r\nBcc: victim@example.test'], startsAt: '2026-09-01T11:00:00.000Z', endsAt: '2026-09-01T12:00:00.000Z' }) });
    expect(response.status).toBe(400);
    expect((await response.json())).toEqual({ error: 'Attendees must be valid email addresses' });
    expect(query).not.toHaveBeenCalled();
  });

  it('deletes only an event from a writable calendar owned by the signed-in user', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [{ id: 'event-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'event-1' }] });

    const response = await fetch(`${base}/api/calendar/events/event-1?calendarId=calendar-1`, { method: 'DELETE' });

    expect(response.status).toBe(204);
    expect(queryCall(2)[0]).toContain('DELETE FROM calendar_events');
    expect(queryCall(2)[1]).toEqual(['event-1', 'calendar-1', 'user-1']);
  });

  it('keeps rejected deletion cancellations in the outbox after deleting the event (V3-03)', async () => {
    const sender = { id: 'account-1', email_address: 'owner@example.test', smtp_host: 'smtp.example.test', enabled: true };
    const event = { id: 'event-1', uid: 'uid-1', attendees: ['accepted@example.test', 'rejected@example.test'], invite_account_id: 'account-1', invitation_sequence: 2, summary: 'Planning', starts_at: '2026-09-01T09:00:00.000Z', ends_at: '2026-09-01T10:00:00.000Z', all_day: false };
    let failedPayload: unknown;
    query.mockImplementation(async (statement: string, parameters?: unknown[]) => {
      if (statement.includes('FROM calendars')) return { rows: [{ id: 'calendar-1', source: 'local', read_only: false }] };
      if (statement.includes('FROM calendar_events WHERE id = $1') && statement.includes('FOR UPDATE')) return { rows: [event] };
      if (statement.includes('FROM email_accounts')) return { rows: [sender] };
      if (statement.includes('INSERT INTO calendar_invitation_outbox')) return { rows: [{ id: 'outbox-1' }] };
      if (statement.startsWith('DELETE FROM calendar_events')) return { rows: [{ id: 'event-1' }] };
      if (statement.includes("SET status = 'processing'")) return { rows: [{ id: 'outbox-1', user_id: 'user-1', payload: { actions: [{ accountId: 'account-1', attendees: event.attendees, summary: event.summary, uid: event.uid, allDay: false, method: 'CANCEL', sequence: 3, startsAt: event.starts_at, endsAt: event.ends_at }] }, invite_account_id: null }], rowCount: 1 };
      if (statement.includes('SET claim_expires_at')) return { rows: [{ id: 'outbox-1' }], rowCount: 1 };
      if (statement.includes("SET status = 'failed'")) { failedPayload = JSON.parse(String(parameters?.[3])); return { rows: [{ attempts: 1 }], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    });
    sendCalendarInvitation.mockResolvedValueOnce({ accepted: ['accepted@example.test'], rejected: ['rejected@example.test'] });

    const response = await fetch(base + '/api/calendar/events/event-1?calendarId=calendar-1', { method: 'DELETE' });
    expect(response.status).toBe(204);
    expect(failedPayload).toEqual([expect.objectContaining({ method: 'CANCEL', attendees: ['rejected@example.test'] })]);
    expect(query.mock.calls.some(([statement]) => String(statement).startsWith('DELETE FROM calendar_events'))).toBe(true);
  });

  it('cancels an invitation when deleting its event', async () => {
    const sender = { id: 'account-1', email_address: 'owner@example.test', smtp_host: 'smtp.example.test', enabled: true };
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [{
        id: 'event-1', uid: 'uid-1', attendees: ['guest@example.test'], invite_account_id: 'account-1', invitation_sequence: 2,
        summary: 'Planning', starts_at: '2026-09-01T09:00:00.000Z', ends_at: '2026-09-01T10:00:00.000Z', all_day: false,
      }] })
      .mockResolvedValueOnce({ rows: [sender] })
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'event-1' }] });

    const response = await fetch(`${base}/api/calendar/events/event-1?calendarId=calendar-1`, { method: 'DELETE' });

    expect(response.status).toBe(204);
    expect(queryCall(1)[0]).toContain("SELECT uid, raw_ical, CASE WHEN jsonb_typeof(attendees) = 'array'");
    expect(queryCall(4)[0]).toContain('DELETE FROM calendar_events');
    expect(sendCalendarInvitation).not.toHaveBeenCalled();
    expect(queryCall(2)[0]).not.toContain('enabled = true');
    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(queryCall(1)[0]).toContain('FOR UPDATE');
  });

  it('keeps an invited event when its cancellation cannot be delivered', async () => {
    const sender = { id: 'account-1', email_address: 'owner@example.test', smtp_host: 'smtp.example.test', enabled: true };
    sendCalendarInvitation.mockRejectedValueOnce(new Error('SMTP unavailable'));
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [{
        id: 'event-1', uid: 'uid-1', attendees: ['guest@example.test'], invite_account_id: 'account-1', invitation_sequence: 2,
        summary: 'Planning', starts_at: '2026-09-01T09:00:00.000Z', ends_at: '2026-09-01T10:00:00.000Z', all_day: false,
      }] })
      .mockResolvedValueOnce({ rows: [sender] })
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'event-1' }] });

    const response = await fetch(`${base}/api/calendar/events/event-1?calendarId=calendar-1`, { method: 'DELETE' });

    expect(response.status).toBe(204);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO calendar_invitation_outbox'))).toBe(true);
  });

  it('persists an invitation outbox row for an idempotent send', async () => {
    const sender = { id: 'account-1', email_address: 'owner@example.test', smtp_host: 'smtp.example.test', enabled: true };
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [sender] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'event-1', calendar_id: 'calendar-1', uid: 'uid-1', invitation_sequence: 0 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-1' }], rowCount: 1 });
    const response = await fetch(`${base}/api/calendar/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Idempotency-Key': 'invite-1' }, body: JSON.stringify({ calendarId: 'calendar-1', summary: 'Planning', sendInvites: true, inviteAccountId: 'account-1', attendees: ['guest@example.test'], startsAt: '2026-09-01T09:00:00.000Z', endsAt: '2026-09-01T10:00:00.000Z' }) });
    expect(response.status).toBe(201);
    expect(sendCalendarInvitation).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]: unknown[]) => String(sql).includes('calendar_invitation_outbox'))).toBe(true);
  });

  it('rolls back the event when the invitation outbox insert fails', async () => {
    const sender = { id: 'account-1', email_address: 'owner@example.test', smtp_host: 'smtp.example.test', enabled: true };
    query.mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] }).mockResolvedValueOnce({ rows: [sender] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: 'event-1', uid: 'uid-1' }] }).mockRejectedValueOnce(new Error('outbox unavailable'));
    const response = await fetch(`${base}/api/calendar/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Idempotency-Key': 'invite-rollback' }, body: JSON.stringify({ calendarId: 'calendar-1', sendInvites: true, inviteAccountId: 'account-1', attendees: ['guest@example.test'], startsAt: '2026-09-01T09:00:00.000Z', endsAt: '2026-09-01T10:00:00.000Z' }) });
    expect(response.status).toBe(500);
    expect(sendCalendarInvitation).not.toHaveBeenCalled();
  });

  it('cancels removed attendees once and returns the same result for a duplicate idempotent update', async () => {
    const sender = { id: 'account-1', email_address: 'owner@example.test', smtp_host: 'smtp.example.test', enabled: true };
    const existing = { uid: 'uid-1', attendees: ['kept@example.test', 'removed@example.test'], invite_account_id: 'account-1', invitation_sequence: 2, summary: 'Planning', starts_at: '2026-09-01T09:00:00.000Z', ends_at: '2026-09-01T10:00:00.000Z', all_day: false };
    const event = { id: 'event-1', calendar_id: 'calendar-1', uid: 'uid-1', attendees: ['kept@example.test'], invite_account_id: 'account-1', invitation_sequence: 3 };
    let outbox: { id?: string; [key: string]: unknown } | null;
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM calendars')) return { rows: [{ id: 'calendar-1', source: 'local', read_only: false }] };
      if (sql.includes('FROM email_accounts')) return { rows: [sender] };
      if (sql.includes('FROM calendar_invitation_outbox')) return { rows: outbox ? [outbox] : [] };
      if (sql.includes('FROM calendar_events') && sql.includes('FOR UPDATE')) return { rows: [existing] };
      if (sql.includes('FROM calendar_events')) return { rows: [event] };
      if (sql.includes('UPDATE calendar_events')) return { rows: [event] };
      if (sql.includes('INSERT INTO calendar_invitation_outbox')) { outbox = { id: 'outbox-1', event_id: 'event-1', request_fingerprint: queryParameter(params, 3) }; return { rows: [{ id: 'outbox-1' }] }; }
      if (sql.includes("SET status = 'processing'")) return { rows: [{ id: 'outbox-1' }], rowCount: 1 };
      if (sql.includes('UPDATE calendar_invitation_outbox')) return { rows: [{ id: 'outbox-1' }], rowCount: 1 };
      return { rows: [] };
    });
    const body = { calendarId: 'calendar-1', summary: 'Planning', sendInvites: true, inviteAccountId: 'account-1', attendees: ['kept@example.test'], startsAt: '2026-09-01T11:00:00.000Z', endsAt: '2026-09-01T12:00:00.000Z' };
    const first = await fetch(`${base}/api/calendar/events/event-1`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'X-Idempotency-Key': 'patch-1' }, body: JSON.stringify(body) });
    const second = await fetch(`${base}/api/calendar/events/event-1`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'X-Idempotency-Key': 'patch-1' }, body: JSON.stringify(body) });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(sendCalendarInvitation).not.toHaveBeenCalled();
    expect(query.mock.calls.filter(([sql]: unknown[]) => String(sql).includes('UPDATE calendar_events')).length).toBe(1);
  });

  it('rejects reuse of an idempotency key for a different update target', async () => {
    const sender = { id: 'account-1', smtp_host: 'smtp.example.test', enabled: true };
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [sender] })
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-1', event_id: 'event-other', request_fingerprint: 'different' }] });
    const response = await fetch(`${base}/api/calendar/events/event-1`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'X-Idempotency-Key': 'same-key' }, body: JSON.stringify({ calendarId: 'calendar-1', sendInvites: true, inviteAccountId: 'account-1', attendees: ['guest@example.test'], startsAt: '2026-09-01T11:00:00.000Z', endsAt: '2026-09-01T12:00:00.000Z' }) });
    expect(response.status).toBe(409);
    expect(sendCalendarInvitation).not.toHaveBeenCalled();
  });

  it('resends a failed invitation when the same idempotent POST is retried', async () => {
    const sender = { id: 'account-1', email_address: 'owner@example.test', smtp_host: 'smtp.example.test', enabled: true };
    const event = { id: 'event-1', calendar_id: 'calendar-1', uid: 'uid-1', invitation_sequence: 0 };
    let outbox: { id?: string; [key: string]: unknown } | null;
    sendCalendarInvitation.mockRejectedValueOnce(new Error('SMTP unavailable'));
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM calendars')) return { rows: [{ id: 'calendar-1', source: 'local', read_only: false }] };
      if (sql.includes('FROM email_accounts')) return { rows: [sender] };
      if (sql.includes('FROM calendar_invitation_outbox')) {
        // The stored payload is what a retry re-sends; the account is resolved by id.
        return { rows: outbox ? [{ ...outbox, status: 'failed', last_error: 'SMTP unavailable', payload: { actions: [{ accountId: 'account-1', attendees: ['guest@example.test'], summary: 'Planning', uid: 'uid-1', allDay: false, method: 'REQUEST', sequence: 0, startsAt: '2026-09-01T09:00:00.000Z', endsAt: '2026-09-01T10:00:00.000Z' }] } }] : [] };
      }
      if (sql.includes('INSERT INTO calendar_events')) return { rows: [event] };
      if (sql.includes('INSERT INTO calendar_invitation_outbox')) { outbox = { id: 'outbox-1', event_id: event.id, request_fingerprint: queryParameter(params, 3) }; return { rows: [{ id: 'outbox-1' }] }; }
      if (sql.includes("SET status = 'processing'")) return { rows: [{ id: 'outbox-1' }], rowCount: 1 };
      if (sql.includes('UPDATE calendar_invitation_outbox')) return { rows: [{ id: 'outbox-1' }], rowCount: 1 };
      if (sql.includes('FROM calendar_events')) return { rows: [event] };
      return { rows: [] };
    });
    const body = { calendarId: 'calendar-1', summary: 'Planning', sendInvites: true, inviteAccountId: 'account-1', attendees: ['guest@example.test'], startsAt: '2026-09-01T09:00:00.000Z', endsAt: '2026-09-01T10:00:00.000Z' };

    const first = await fetch(`${base}/api/calendar/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Idempotency-Key': 'post-failed' }, body: JSON.stringify(body) });
    const second = await fetch(`${base}/api/calendar/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Idempotency-Key': 'post-failed' }, body: JSON.stringify(body) });

    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ invitationStatus: { status: 'failed', lastError: 'no invitation actions are available for delivery' } });
    // A retry of an undelivered invitation must actually send it again, not replay
    // the earlier error — that was the reported bug.
    expect(second.status).toBe(201);
    expect(await second.json()).toMatchObject({ invitationStatus: { status: 'failed', lastError: 'no invitation actions are available for delivery' } });
    expect(sendCalendarInvitation).not.toHaveBeenCalled();
    // The idempotency key still guarantees a single event row.
    expect(query.mock.calls.filter(([sql]: unknown[]) => String(sql).includes('INSERT INTO calendar_events')).length).toBe(1);
  });

  it('does not resend an invitation the outbox already delivered', async () => {
    const sender = { id: 'account-1', email_address: 'owner@example.test', smtp_host: 'smtp.example.test', enabled: true };
    const event = { id: 'event-1', calendar_id: 'calendar-1', uid: 'uid-1', invitation_sequence: 0 };
    let outbox: { id?: string; [key: string]: unknown } | null;
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM calendars')) return { rows: [{ id: 'calendar-1', source: 'local', read_only: false }] };
      if (sql.includes('FROM email_accounts')) return { rows: [sender] };
      if (sql.includes('FROM calendar_invitation_outbox')) return { rows: outbox ? [{ ...outbox, status: 'sent', last_error: null, payload: { actions: [] } }] : [] };
      if (sql.includes('INSERT INTO calendar_events')) return { rows: [event] };
      if (sql.includes('INSERT INTO calendar_invitation_outbox')) { outbox = { id: 'outbox-1', event_id: event.id, request_fingerprint: queryParameter(params, 3) }; return { rows: [{ id: 'outbox-1' }] }; }
      if (sql.includes("SET status = 'processing'")) return { rows: [{ id: 'outbox-1' }], rowCount: 1 };
      if (sql.includes('UPDATE calendar_invitation_outbox')) return { rows: [{ id: 'outbox-1' }], rowCount: 1 };
      if (sql.includes('FROM calendar_events')) return { rows: [event] };
      return { rows: [] };
    });
    const body = { calendarId: 'calendar-1', summary: 'Planning', sendInvites: true, inviteAccountId: 'account-1', attendees: ['guest@example.test'], startsAt: '2026-09-01T09:00:00.000Z', endsAt: '2026-09-01T10:00:00.000Z' };

    await fetch(`${base}/api/calendar/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Idempotency-Key': 'post-sent' }, body: JSON.stringify(body) });
    const second = await fetch(`${base}/api/calendar/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Idempotency-Key': 'post-sent' }, body: JSON.stringify(body) });

    expect(second.status).toBe(201);
    const payload = responseRecord(await second.json());
    expect(payload).toMatchObject({ invitationStatus: { status: 'sent', lastError: null } });
    expect(payload.invitationError).toBeUndefined();
    // A sent row is never claimed or delivered again.
    expect(sendCalendarInvitation).not.toHaveBeenCalled();
  });

  it('resends a failed invitation when the same idempotent PATCH is retried', async () => {
    const sender = { id: 'account-1', email_address: 'owner@example.test', smtp_host: 'smtp.example.test', enabled: true };
    const existing = { uid: 'uid-1', attendees: [], invite_account_id: null, invitation_sequence: 0, summary: 'Planning', starts_at: '2026-09-01T09:00:00.000Z', ends_at: '2026-09-01T10:00:00.000Z', all_day: false };
    const event = { id: 'event-1', calendar_id: 'calendar-1', uid: 'uid-1', attendees: ['guest@example.test'], invite_account_id: 'account-1', invitation_sequence: 0 };
    let outbox: { id?: string; [key: string]: unknown } | null;
    sendCalendarInvitation.mockRejectedValueOnce(new Error('SMTP unavailable'));
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM calendars')) return { rows: [{ id: 'calendar-1', source: 'local', read_only: false }] };
      if (sql.includes('FROM email_accounts')) return { rows: [sender] };
      if (sql.includes('FROM calendar_invitation_outbox')) {
        return { rows: outbox ? [{ ...outbox, status: 'failed', last_error: 'SMTP unavailable', payload: { actions: [{ accountId: 'account-1', attendees: ['guest@example.test'], summary: 'Planning', uid: 'uid-1', allDay: false, method: 'REQUEST', sequence: 0, startsAt: '2026-09-01T11:00:00.000Z', endsAt: '2026-09-01T12:00:00.000Z' }] } }] : [] };
      }
      if (sql.includes('FOR UPDATE')) return { rows: [existing] };
      if (sql.includes('UPDATE calendar_events')) return { rows: [event] };
      if (sql.includes('INSERT INTO calendar_invitation_outbox')) { outbox = { id: 'outbox-1', event_id: event.id, request_fingerprint: queryParameter(params, 3) }; return { rows: [{ id: 'outbox-1' }] }; }
      if (sql.includes("SET status = 'processing'")) return { rows: [{ id: 'outbox-1' }], rowCount: 1 };
      if (sql.includes('UPDATE calendar_invitation_outbox')) return { rows: [{ id: 'outbox-1' }], rowCount: 1 };
      if (sql.includes('FROM calendar_events')) return { rows: [event] };
      return { rows: [] };
    });
    const body = { calendarId: 'calendar-1', summary: 'Planning', sendInvites: true, inviteAccountId: 'account-1', attendees: ['guest@example.test'], startsAt: '2026-09-01T11:00:00.000Z', endsAt: '2026-09-01T12:00:00.000Z' };

    const first = await fetch(`${base}/api/calendar/events/event-1`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'X-Idempotency-Key': 'patch-failed' }, body: JSON.stringify(body) });
    const second = await fetch(`${base}/api/calendar/events/event-1`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'X-Idempotency-Key': 'patch-failed' }, body: JSON.stringify(body) });

    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ invitationStatus: { status: 'failed', lastError: 'no invitation actions are available for delivery' } });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ invitationStatus: { status: 'failed', lastError: 'no invitation actions are available for delivery' } });
    expect(sendCalendarInvitation).not.toHaveBeenCalled();
    expect(query.mock.calls.filter(([sql]: unknown[]) => String(sql).includes('UPDATE calendar_events')).length).toBe(1);
  });

});

it('recovers metadata for already imported events without returning the raw ICS', async () => {
  mockEventRead({ events: [{ id: 'event-1', description: null, location: null, attendees: [], starts_at: '2026-09-10T07:00:00Z', raw_ical: outlookCalendar('09', 'DESCRIPTION:Existing agenda\r\nLOCATION:Office\r\nATTENDEE:mailto:jane@example.test\r\n') }] });
  const response = await fetch(`${base}/api/calendar/events?from=2026-09-01&to=2026-10-01`);
  expect(response.status).toBe(200);
  const { events } = calendarEventsResponse(await response.json());
  expect(events[0]).toMatchObject({ description: 'Existing agenda', location: 'Office', attendees: ['jane@example.test'] });
  expect(events[0]).not.toHaveProperty('raw_ical');
});

describe('adding mail invitations to a local calendar', () => {
 const raw = outlookCalendar('09', 'DTSTAMP:20260901T090000Z\r\nORGANIZER:mailto:team@example.test\r\nATTENDEE:mailto:jane@example.test\r\nDESCRIPTION:Agenda\r\n').replace('VERSION:2.0', 'VERSION:2.0\r\nMETHOD:REQUEST');
 it('scopes invitation reads to the owner and exposes metadata without raw ICS', async () => {
   query.mockResolvedValueOnce({ rows: [{ raw_ical: raw }] })
     // The read also looks up the local copy this message was imported into, so the
     // reader can show the invitation as already added.
     .mockResolvedValueOnce({ rows: [] });
   const response = await fetch(`${base}/api/calendar/invitations/message-1`);
   expect(response.status).toBe(200);
   const body = responseRecord(await response.json());
   expect(responseObject(body, 'invitation')).toMatchObject({ description: 'Agenda', method: 'REQUEST', localEvent: null });
   expect(responseObject(body, 'invitation').raw).toBeUndefined();
   expect(queryCall(0)[1]).toEqual(['message-1', 'user-1']);
   expect(queryCall(0)[0]).toContain('a.user_id = $2');
 });
 it('reports the local copy a message was imported into', async () => {
   query.mockResolvedValueOnce({ rows: [{ raw_ical: raw }] })
     .mockResolvedValueOnce({ rows: [{ id: 'event-1', calendar_id: 'calendar-1', invitation_sequence: 2, starts_at: null, ends_at: null, all_day: false }] });
   const response = await fetch(`${base}/api/calendar/invitations/message-1`);
   expect(response.status).toBe(200);
   expect(responseObject(await response.json(), 'invitation').localEvent).toEqual({
     id: 'event-1', calendarId: 'calendar-1', sequence: 2, startsAt: null, endsAt: null, allDay: false,
   });
   // Scoped to this user and this message, so a foreign event can never be reported as the
   // copy this message created.
   expect(queryCall(1)[0]).toContain('source_message_id = $1');
   expect(queryCall(1)[1]).toEqual(['message-1', 'user-1']);
 });
 it('withdraws the imported copy when the organizer cancels', async () => {
   const cancelled = outlookCalendar('09', 'DTSTAMP:20260901T090000Z\r\nORGANIZER:mailto:team@example.test\r\nSEQUENCE:3\r\nSTATUS:CANCELLED\r\n').replace('VERSION:2.0', 'VERSION:2.0\r\nMETHOD:CANCEL');
   query.mockResolvedValueOnce({ rows: [{ raw_ical: cancelled }] })
     .mockResolvedValueOnce({ rows: [{ id: 'event-1', calendar_id: 'calendar-1', invitation_sequence: 1, starts_at: null, ends_at: null, all_day: false }] })
     .mockResolvedValueOnce({ rows: [{ id: 'event-1' }] });
   const response = await fetch(`${base}/api/calendar/invitations/message-1`, { method: 'DELETE' });
   expect(response.status).toBe(200);
   expect((await response.json())).toMatchObject({ removed: true, calendarId: 'calendar-1' });
   const deletion = query.mock.calls[2];
   expect(deletion[0]).toContain('source_message_id = $3');
   // A locally-owned event (one that invited attendees of its own) is never auto-removed.
   expect(deletion[0]).toContain('invite_account_id IS NULL');
   expect(deletion[1]).toEqual(['event-1', 'user-1', 'message-1']);
 });
 it('refuses a cancellation older than the imported copy', async () => {
   const cancelled = outlookCalendar('09', 'DTSTAMP:20260901T090000Z\r\nORGANIZER:mailto:team@example.test\r\nSEQUENCE:1\r\nSTATUS:CANCELLED\r\n').replace('VERSION:2.0', 'VERSION:2.0\r\nMETHOD:CANCEL');
   query.mockResolvedValueOnce({ rows: [{ raw_ical: cancelled }] })
     .mockResolvedValueOnce({ rows: [{ id: 'event-1', calendar_id: 'calendar-1', invitation_sequence: 5, starts_at: null, ends_at: null, all_day: false }] });
   const response = await fetch(`${base}/api/calendar/invitations/message-1`, { method: 'DELETE' });
   // A newer update may have arrived since this cancellation, so it must not delete.
   expect(response.status).toBe(409);
 });
 it('reports no copy to withdraw when the invitation was never added', async () => {
   query.mockResolvedValueOnce({ rows: [{ raw_ical: raw }] }).mockResolvedValueOnce({ rows: [] });
   const response = await fetch(`${base}/api/calendar/invitations/message-1`, { method: 'DELETE' });
   expect(response.status).toBe(404);
 });
 it('adds a scoped local copy and retains description without sending mail', async () => {
   query.mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
     .mockResolvedValueOnce({ rows: [{ raw_ical: raw }] }).mockResolvedValueOnce({ rows: [{ id: 'event-1' }] });
   const response = await fetch(`${base}/api/calendar/invitations/message-1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ calendarId: 'calendar-1' }) });
   expect(response.status).toBe(200);
   const [insertSql, insertParameters] = queryCall(2);
   expect(queryStringParameter(2, 3)).not.toContain('METHOD:REQUEST');
   expect(queryStringParameter(2, 3)).toContain(`UID:${queryStringParameter(2, 2)}`);
   expect(queryParameter(insertParameters, 9)).toBe('Agenda');
   expect(insertSql).toContain('calendar_events.invitation_sequence < EXCLUDED.invitation_sequence');
   expect(sendCalendarInvitation).not.toHaveBeenCalled();
 });
 it('rejects a foreign message and a read-only calendar', async () => {
   query.mockResolvedValueOnce({ rows: [] });
   expect((await fetch(`${base}/api/calendar/invitations/foreign`)).status).toBe(404);
   query.mockResolvedValueOnce({ rows: [{ id: 'remote', source: 'caldav', read_only: true }] });
   expect((await fetch(`${base}/api/calendar/invitations/message-1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ calendarId: 'remote' }) })).status).toBe(403);
 });
});

it('updates one occurrence without replacing the base-event range or description', async () => {
  const raw = outlookCalendar('09', 'RRULE:FREQ=WEEKLY;COUNT=4\r\nDESCRIPTION:Base agenda\r\n');
  query.mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
    .mockResolvedValueOnce({ rows: [{ uid: 'synthetic-exchange-event', raw_ical: raw }] }).mockResolvedValueOnce({ rows: [] });
  const response = await fetch(`${base}/api/calendar/events/event-1/occurrence`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ calendarId: 'calendar-1', recurrenceId: '2026-09-17T09:00:00', summary: 'Changed instance', startsAt: '2026-09-17T10:00:00Z', endsAt: '2026-09-17T11:00:00Z', attendees: [] }) });
  expect(response.status).toBe(200);
  const updatedRaw = queryCall(2)[1][0];
  expect(updatedRaw).toContain('RRULE:FREQ=WEEKLY;COUNT=4');
  expect(updatedRaw).toContain('DESCRIPTION:Base agenda');
  expect(updatedRaw).toContain('SUMMARY:Changed instance');
  expect(updatedRaw).toContain('RECURRENCE-ID;TZID=Central European Standard Time:20260917T090000');
  expect(queryCall(2)[0]).not.toContain('starts_at =');
});

describe('recurring event creation and series editing', () => {
  const baseEvent = (extra = '') => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:uid-1',
    'DTSTART:20260901T090000Z', 'DTEND:20260901T100000Z', 'SUMMARY:Old', extra,
    'END:VEVENT', 'END:VCALENDAR'].filter(Boolean).join('\r\n');
  const exception = ['BEGIN:VEVENT', 'UID:uid-1', 'RECURRENCE-ID:20260903T090000Z',
    'DTSTART:20260903T110000Z', 'DTEND:20260903T120000Z', 'SUMMARY:Moved', 'END:VEVENT'].join('\r\n');
  const timeFields = { startsAt: '2026-09-01T09:00:00.000Z', endsAt: '2026-09-01T10:00:00.000Z' };
  const create = (recurrence: unknown) => fetch(`${base}/api/calendar/events`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ calendarId: 'calendar-1', summary: 'Standup', ...timeFields, recurrence }),
  });
  const patchSeries = (calendarId: string, body: Record<string, unknown>) => fetch(`${base}/api/calendar/events/event-1`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ calendarId, ...timeFields, attendees: [], ...body }),
  });
  const storedSeriesEvent = (raw: string) => ({
    uid: 'uid-1', raw_ical: raw, attendees: [], invite_account_id: null, invitation_sequence: 0,
    summary: 'Old', description: null, location: null, all_day: false,
    starts_at: timeFields.startsAt, ends_at: timeFields.endsAt,
  });
  const updatedRaw = (): string => {
    const raw = queryCallContaining('UPDATE calendar_events SET raw_ical')[1][0];
    if (typeof raw !== 'string') throw new Error('Updated calendar resource is not a string');
    return raw;
  };

  it('creates a recurring event by rendering the rule into the stored resource', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [{ id: 'event-1', calendar_id: 'calendar-1', uid: 'uid-1', summary: 'Standup' }] });

    const response = await create({ frequency: 'weekly', interval: 2, byWeekday: [1, 3] });
    expect(response.status).toBe(201);
    expect(queryStringParameter(1, 3)).toContain('RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE');
  });

  it('renders an all-day rule with a date-valued UNTIL', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [{ id: 'event-1' }] });

    const response = await fetch(`${base}/api/calendar/events`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        calendarId: 'calendar-1', summary: 'All day', allDay: true,
        startsAt: '2026-09-01T00:00:00.000Z', endsAt: '2026-09-02T00:00:00.000Z',
        recurrence: { frequency: 'daily', until: '2026-12-31' },
      }),
    });
    expect(response.status).toBe(201);
    expect(queryStringParameter(1, 3)).toContain('RRULE:FREQ=DAILY;UNTIL=20261231');
  });

  it('rejects an invalid recurrence before writing anything', async () => {
    query.mockResolvedValue({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] });

    const response = await create({ frequency: 'hourly' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'recurrence.frequency must be none, daily, weekly, monthly or yearly' });
    expect(query.mock.calls.some(([statement]) => String(statement).includes('INSERT INTO calendar_events'))).toBe(false);
  });

  it('updates the whole series rule while keeping the editor-owned fields', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [storedSeriesEvent(baseEvent('RRULE:FREQ=DAILY;COUNT=5\r\n'))] })
      .mockResolvedValueOnce({ rows: [{ id: 'event-1', calendar_id: 'calendar-1', uid: 'uid-1', summary: 'Renamed' }] });

    const response = await patchSeries('calendar-1', { summary: 'Renamed', recurrence: { frequency: 'weekly', byWeekday: [2] } });
    expect(response.status).toBe(200);
    const raw = updatedRaw();
    expect(raw).toContain('RRULE:FREQ=WEEKLY;BYDAY=TU');
    expect(raw).not.toContain('FREQ=DAILY');
    expect(raw).toContain('SUMMARY:Renamed');
  });

  it('clears the rule and the orphaned overrides when the series becomes a single event', async () => {
    const withException = baseEvent('RRULE:FREQ=DAILY;COUNT=5\r\n').replace('END:VCALENDAR', `${exception}\r\nEND:VCALENDAR`);
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [storedSeriesEvent(withException)] })
      .mockResolvedValueOnce({ rows: [{ id: 'event-1' }] });

    const response = await patchSeries('calendar-1', { recurrence: null });
    expect(response.status).toBe(200);
    const raw = updatedRaw();
    expect(raw).not.toContain('RRULE');
    expect(raw).not.toContain('RECURRENCE-ID');
  });

  it('keeps the stored rule when a series edit does not mention recurrence', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [storedSeriesEvent(baseEvent('RRULE:FREQ=DAILY;COUNT=5\r\n'))] })
      .mockResolvedValueOnce({ rows: [{ id: 'event-1' }] });

    const response = await patchSeries('calendar-1', { summary: 'Renamed only' });
    expect(response.status).toBe(200);
    expect(updatedRaw()).toContain('RRULE:FREQ=DAILY;COUNT=5');
  });

  it('returns the parsed rule from the single-event read the series editor opens', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'event-1', calendar_id: 'calendar-1', uid: 'uid-1', summary: 'Standup', attendees: [], recurring: true, raw_ical: baseEvent('RRULE:FREQ=WEEKLY;BYDAY=MO') }] });

    const response = await fetch(`${base}/api/calendar/events/event-1`);
    expect(response.status).toBe(200);
    const event = responseObject(await response.json(), 'event');
    expect(event.recurrence).toMatchObject({ frequency: 'weekly', byWeekday: [1], interval: 1, custom: false });
    // The raw iCalendar body is never part of the response.
    expect(event.raw_ical).toBeUndefined();
  });

  it('404s the series read for an event the user does not own', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect((await fetch(`${base}/api/calendar/events/someone-elses`)).status).toBe(404);
  });
});
