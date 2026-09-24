import { describe, expect, it, vi } from 'vitest';
import { GoogleApiError } from './googleApiClient.js';
import { createGoogleManagedCalendar, deleteGoogleManagedCalendar, inspectGoogleCalendarManagement, GoogleCalendarProtectionError, GoogleCalendarManagementResponseError } from './googleCalendarManagement.js';
vi.mock('../../providerTokenService.js', () => ({ getGoogleAccessToken: vi.fn(async () => ({ accessToken: 'test-token' })) }));
const base = 'https://www.googleapis.com/calendar/v3';
const options = { userId: 'u', connectionId: 'c', config: { clientId: 'c', clientSecret: 's', redirectUri: 'https://example.test/cb' } };
function transport(...bodies: unknown[]) {
  const fetchImpl = vi.fn<typeof fetch>();
  for (const body of bodies) fetchImpl.mockResolvedValueOnce(Response.json(body));
  return fetchImpl;
}
describe('Google calendar collection management', () => {
  it('creates name-only via Calendar resource, not CalendarList', async () => {
    const fetchImpl = transport({ id: 'new-id', summary: 'Work' });
    expect(await createGoogleManagedCalendar({ ...options, fetchImpl }, 'Work')).toEqual({ id: 'new-id', summary: 'Work' });
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(`${base}/calendars`, expect.objectContaining({ method: 'POST', body: JSON.stringify({ summary: 'Work' }) }));
  });
  it.each([null, {}, { id: '' }, { id: 3 }, { id: '..' }])('does not claim create success without an ID: %j', async body => {
    const fetchImpl = transport(body);
    await expect(createGoogleManagedCalendar({ ...options, fetchImpl }, 'Work')).rejects.toBeInstanceOf(GoogleCalendarManagementResponseError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('encodes opaque IDs, checks canonical primary, allows omitted secondary primary flag, then deletes the collection', async () => {
    const id = 'https://evil.test/a?x=1#/%2f';
    const fetchImpl = transport({ id, accessRole: 'owner' }, { id: 'primary-id' });
    fetchImpl.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await deleteGoogleManagedCalendar({ ...options, fetchImpl }, id);
    expect(fetchImpl.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      [`${base}/users/me/calendarList/${encodeURIComponent(id)}`, 'GET'],
      [`${base}/calendars/primary`, 'GET'],
      [`${base}/calendars/${encodeURIComponent(id)}`, 'DELETE'],
    ]);
  });
  it.each([
    [{ id: 'secondary', accessRole: 'owner', primary: true }, { id: 'primary' }, 'primary_calendar'],
    [{ id: 'secondary', accessRole: 'owner', primary: false }, { id: 'secondary' }, 'primary_calendar'],
    [{ id: 'secondary', accessRole: 'writer' }, { id: 'primary' }, 'not_owner'],
    [{ id: 'secondary', accessRole: 'reader' }, { id: 'primary' }, 'not_owner'],
    [{ id: 'other', accessRole: 'owner' }, { id: 'primary' }, 'identity_mismatch'],
    [{ id: 'secondary' }, { id: 'primary' }, 'metadata_missing'],
    [{ id: 'secondary', accessRole: 'owner' }, {}, 'metadata_missing'],
    [{ id: 'secondary', accessRole: 'owner', primary: null }, { id: 'primary' }, 'metadata_missing'],
    [null, { id: 'primary' }, 'metadata_missing'],
  ])('refuses protected or ambiguous metadata without DELETE (%j)', async (metadata, primary, reason) => {
    const fetchImpl = transport(metadata, primary);
    await expect(deleteGoogleManagedCalendar({ ...options, fetchImpl }, 'secondary')).rejects.toMatchObject({ name: 'GoogleCalendarProtectionError', reason });
    expect(fetchImpl.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it.each(['', ' ', '.', '..'])('rejects unsafe ID %j before HTTP', async id => {
    const fetchImpl = transport();
    await expect(deleteGoogleManagedCalendar({ ...options, fetchImpl }, id)).rejects.toBeInstanceOf(GoogleCalendarProtectionError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('inspection does not authorize a later delete after privileges change', async () => {
    const fetchImpl = transport({ id: 's', accessRole: 'owner', primary: false }, { id: 'p' }, { id: 's', accessRole: 'reader' }, { id: 'p' });
    expect(await inspectGoogleCalendarManagement({ ...options, fetchImpl }, 's')).toEqual({ canDelete: true, calendarId: 's', primaryCalendarId: 'p' });
    await expect(deleteGoogleManagedCalendar({ ...options, fetchImpl }, 's')).rejects.toMatchObject({ reason: 'not_owner' });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
  it.each([0, 1])('propagates metadata API failure at read %i without DELETE/retry', async index => {
    const fetchImpl = transport(...(index ? [{ id: 's', accessRole: 'owner' }] : []));
    fetchImpl.mockResolvedValueOnce(Response.json({ error: { message: 'unavailable' } }, { status: 503 }));
    await expect(deleteGoogleManagedCalendar({ ...options, fetchImpl }, 's')).rejects.toBeInstanceOf(GoogleApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(index + 1);
  });
  it('propagates uncertain create/delete transport errors without hidden retries', async () => {
    const failure = new Error('connection lost');
    const createFetch = transport(); createFetch.mockRejectedValueOnce(failure);
    await expect(createGoogleManagedCalendar({ ...options, fetchImpl: createFetch }, 'Work')).rejects.toBe(failure);
    expect(createFetch).toHaveBeenCalledTimes(1);
    const deleteFetch = transport({ id: 's', accessRole: 'owner' }, { id: 'p' }); deleteFetch.mockRejectedValueOnce(failure);
    await expect(deleteGoogleManagedCalendar({ ...options, fetchImpl: deleteFetch }, 's')).rejects.toBe(failure);
    expect(deleteFetch).toHaveBeenCalledTimes(3);
  });
  it.each([200, 202])('does not treat delete HTTP %i as confirmed', async status => {
    const fetchImpl = transport({ id: 's', accessRole: 'owner' }, { id: 'p' }); fetchImpl.mockResolvedValueOnce(new Response(null, { status }));
    await expect(deleteGoogleManagedCalendar({ ...options, fetchImpl }, 's')).rejects.toMatchObject({ name: 'GoogleCalendarManagementResponseError', operation: 'delete' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it('does not treat accepted create as confirmed even with an id', async () => {
    const fetchImpl = transport(); fetchImpl.mockResolvedValueOnce(Response.json({ id: 'maybe' }, { status: 202 }));
    await expect(createGoogleManagedCalendar({ ...options, fetchImpl }, 'Work')).rejects.toBeInstanceOf(GoogleCalendarManagementResponseError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('honors an already cancelled caller before creating', async () => {
    const fetchImpl = transport(); const controller = new AbortController(); controller.abort();
    await expect(createGoogleManagedCalendar({ ...options, fetchImpl, signal: controller.signal }, 'Work')).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
