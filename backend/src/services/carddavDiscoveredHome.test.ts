import { beforeEach, expect, it, vi } from 'vitest';
const boundary = vi.hoisted(() => ({ request: vi.fn(), validateHost: vi.fn() }));
vi.mock('./davCollectionClient.js', async original => ({ ...(await original<typeof import('./davCollectionClient.js')>()), davCollectionRequest: boundary.request }));
vi.mock('./hostValidation.js', async original => ({ ...(await original<typeof import('./hostValidation.js')>()), validateHost: boundary.validateHost }));
import { discoverAddressBookSnapshot } from './carddavClient.js';
const input = { serverUrl: 'https://dav.example.test/calendars/', homeSetUrl: 'https://dav.example.test/books/', username: 'owner', password: 'app-password' };
beforeEach(() => { vi.resetAllMocks(); boundary.validateHost.mockResolvedValue(null); });
it('syncs the discovered CardDAV home instead of returning to a calendar-only principal', async () => {
  boundary.request.mockResolvedValue(new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">
    <d:response><d:href>/books/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
    <d:response><d:href>/books/private/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><c:addressbook/></d:resourcetype><d:displayname>Private</d:displayname></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
    </d:multistatus>`, { status: 207 }));
  expect(await discoverAddressBookSnapshot(input)).toMatchObject({ homeUrl: input.homeSetUrl, collections: [{ url: `${input.homeSetUrl}private/`, displayName: 'Private' }] });
  expect(boundary.request).toHaveBeenCalledOnce();
  expect(boundary.request.mock.calls[0][0]).toMatchObject({ url: input.homeSetUrl, username: input.username, password: input.password });
  expect(boundary.request.mock.calls[0][1]).toMatchObject({ method: 'PROPFIND', headers: { Depth: '1' } });
});
it.each(['https://other.example.test/books/', 'http://dav.example.test/books/'])('does not replay credentials to an unsafe stored home (%s)', async homeSetUrl => {
  await expect(discoverAddressBookSnapshot({ ...input, homeSetUrl })).rejects.toThrow();
  expect(boundary.request).not.toHaveBeenCalled();
});
