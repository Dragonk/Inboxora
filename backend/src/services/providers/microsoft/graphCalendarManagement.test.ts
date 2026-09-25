import { describe, expect, it, vi } from 'vitest';
import { GraphApiError } from './graphApiClient.js';
import { createGraphManagedCalendar, deleteGraphManagedCalendar, inspectGraphCalendarManagement, GraphCalendarProtectionError, GraphCalendarManagementResponseError, GRAPH_CALENDAR_MANAGEMENT_SELECT } from './graphCalendarManagement.js';
vi.mock('../../providerTokenService.js', () => ({ getMicrosoftAccessToken: vi.fn(async () => ({ accessToken: 'test-token' })) }));
const options = { userId: 'u', connectionId: 'c', config: { clientId: 'c', clientSecret: 's', redirectUri: 'https://example.test/cb', providerRedirectUri: 'https://example.test/provider-cb', tenantId: 'common' } };
const base = 'https://graph.microsoft.com/v1.0';
const owner = 'owner@example.test';
const secondary = { id: 's', canEdit: true, owner: { address: owner }, isDefaultCalendar: false };
function transport(...bodies: unknown[]) {
  const fetchImpl = vi.fn<typeof fetch>();
  for (const body of bodies) fetchImpl.mockResolvedValueOnce(Response.json(body));
  return fetchImpl;
}
describe('Graph calendar collection management', () => {
  it('creates a name-only calendar resource', async () => {
    const fetchImpl = transport({ id: 'new-id', name: 'Work' });
    expect(await createGraphManagedCalendar({ ...options, fetchImpl }, 'Work')).toEqual({ id: 'new-id', name: 'Work' });
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(`${base}/me/calendars`, expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'Work' }) }));
  });
  it.each([null, {}, { id: '' }, { id: 3 }, { id: '..' }])('refuses malformed create confirmation: %j', async body => {
    const fetchImpl = transport(body);
    await expect(createGraphManagedCalendar({ ...options, fetchImpl }, 'Work')).rejects.toBeInstanceOf(GraphCalendarManagementResponseError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('encodes opaque IDs, requests authoritative metadata, then deletes exact collection', async () => {
    const id = 'https://evil.test/a?x=1#/%2f';
    const fetchImpl = transport({ ...secondary, id }, { id: 'default-id' });
    fetchImpl.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await deleteGraphManagedCalendar({ ...options, fetchImpl }, id, owner.toUpperCase());
    const calls = fetchImpl.mock.calls;
    const target = new URL(String(calls[0][0]));
    expect(target.origin).toBe('https://graph.microsoft.com');
    expect(target.pathname).toBe(`/v1.0/me/calendars/${encodeURIComponent(id)}`);
    expect(target.searchParams.get('$select')).toBe(GRAPH_CALENDAR_MANAGEMENT_SELECT);
    const primary = new URL(String(calls[1][0]));
    expect(primary.pathname).toBe('/v1.0/me/calendar'); expect(primary.searchParams.get('$select')).toBe('id');
    expect(calls.map(([, init]) => init?.method)).toEqual(['GET', 'GET', 'DELETE']);
    expect(calls[2][0]).toBe(`${base}/me/calendars/${encodeURIComponent(id)}`);
  });
  it.each([
    [{ ...secondary, isDefaultCalendar: true }, { id: 'p' }, 'default_calendar'],
    [secondary, { id: 's' }, 'default_calendar'],
    [{ ...secondary, canEdit: false }, { id: 'p' }, 'not_editable'],
    [{ ...secondary, canEdit: undefined }, { id: 'p' }, 'metadata_missing'],
    [{ ...secondary, owner: { address: 'other@example.test' } }, { id: 'p' }, 'not_owner'],
    [{ ...secondary, owner: undefined }, { id: 'p' }, 'owner_unverified'],
    [{ ...secondary, owner: { name: owner } }, { id: 'p' }, 'owner_unverified'],
    [{ ...secondary, owner: { address: 'Display Name' } }, { id: 'p' }, 'owner_unverified'],
    [{ ...secondary, id: 'different' }, { id: 'p' }, 'identity_mismatch'],
    [secondary, {}, 'metadata_missing'],
    [null, { id: 'p' }, 'metadata_missing'],
    [{ ...secondary, isDefaultCalendar: null }, { id: 'p' }, 'metadata_missing'],
  ])('refuses unsafe metadata without DELETE (%j)', async (metadata, primary, reason) => {
    const fetchImpl = transport(metadata, primary);
    await expect(deleteGraphManagedCalendar({ ...options, fetchImpl }, 's', owner)).rejects.toMatchObject({ name: 'GraphCalendarProtectionError', reason });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });
  it.each(['', ' ', '.', '..'])('refuses unsafe id %j before HTTP', async id => {
    const fetchImpl = transport();
    await expect(deleteGraphManagedCalendar({ ...options, fetchImpl }, id, owner)).rejects.toBeInstanceOf(GraphCalendarProtectionError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each(['', 'Alias'])('requires a verified provider mailbox identity %j', async identity => {
    const fetchImpl = transport();
    await expect(deleteGraphManagedCalendar({ ...options, fetchImpl }, 's', identity)).rejects.toMatchObject({ reason: 'owner_unverified' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('rechecks permission on delete instead of trusting earlier inspection', async () => {
    const fetchImpl = transport(secondary, { id: 'p' }, { ...secondary, canEdit: false }, { id: 'p' });
    expect(await inspectGraphCalendarManagement({ ...options, fetchImpl }, 's', owner)).toEqual({ canDelete: true, calendarId: 's', defaultCalendarId: 'p', ownerAddress: owner });
    await expect(deleteGraphManagedCalendar({ ...options, fetchImpl }, 's', owner)).rejects.toMatchObject({ reason: 'not_editable' });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
  it.each([0, 1])('propagates API metadata failure at read %i without DELETE/retry', async index => {
    const fetchImpl = transport(...(index ? [secondary] : []));
    fetchImpl.mockResolvedValueOnce(Response.json({ error: { code: 'ServiceUnavailable' } }, { status: 503 }));
    await expect(deleteGraphManagedCalendar({ ...options, fetchImpl }, 's', owner)).rejects.toBeInstanceOf(GraphApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(index + 1);
  });
  it.each([200, 202])('does not treat delete HTTP %i as confirmed', async status => {
    const fetchImpl = transport(secondary, { id: 'p' }); fetchImpl.mockResolvedValueOnce(new Response(null, { status }));
    await expect(deleteGraphManagedCalendar({ ...options, fetchImpl }, 's', owner)).rejects.toMatchObject({ name: 'GraphCalendarManagementResponseError', operation: 'delete' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it('never treats an accepted create as confirmed or automatically retries', async () => {
    const fetchImpl = transport(); fetchImpl.mockResolvedValueOnce(Response.json({ id: 'maybe' }, { status: 202 }));
    await expect(createGraphManagedCalendar({ ...options, fetchImpl }, 'Work')).rejects.toBeInstanceOf(GraphCalendarManagementResponseError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('propagates uncertain network errors from create/delete without extra dispatch', async () => {
    const failure = new Error('connection lost');
    const createFetch = transport(); createFetch.mockRejectedValueOnce(failure);
    await expect(createGraphManagedCalendar({ ...options, fetchImpl: createFetch }, 'Work')).rejects.toBe(failure);
    expect(createFetch).toHaveBeenCalledTimes(1);
    const deleteFetch = transport(secondary, { id: 'p' }); deleteFetch.mockRejectedValueOnce(failure);
    await expect(deleteGraphManagedCalendar({ ...options, fetchImpl: deleteFetch }, 's', owner)).rejects.toBe(failure);
    expect(deleteFetch).toHaveBeenCalledTimes(3);
  });
  it('honors pre-cancelled options before create', async () => {
    const fetchImpl = transport(); const controller = new AbortController(); controller.abort();
    await expect(createGraphManagedCalendar({ ...options, fetchImpl, signal: controller.signal }, 'Work')).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
