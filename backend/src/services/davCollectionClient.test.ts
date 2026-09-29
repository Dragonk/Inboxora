import { afterEach, describe, expect, it, vi } from 'vitest';
import * as davTransport from './davHttpAuth.js';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { deleteDavCollection, discoverDavCollectionDeleteCapability, inspectDavCollection, normalizeDavCollectionUrl, parseDavCollectionSnapshot, resolveDavHref } from './davCollectionClient.js';
import { discoverAddressBookSnapshot, parseCards } from './carddavClient.js';

const envelope = (responses: string) => `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav" xmlns:cal="urn:ietf:params:xml:ns:caldav">${responses}</d:multistatus>`;
const entry = (href: string, props: string, code = 200) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 ${code} Status</d:status></d:propstat></d:response>`;
const home = entry('/home/', '<d:resourcetype><d:collection/></d:resourcetype>');
const book = entry('/home/book/', '<d:resourcetype><d:collection/><c:addressbook/></d:resourcetype>');
const base = 'https://dav.example/home/';
const servers: Server[] = [];
async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No TCP listener');
  return `http://127.0.0.1:${address.port}`;
}
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }))); });

describe('authoritative DAV collection snapshots', () => {
  it('accepts a complete empty home and a complete populated home', () => {
    expect(parseDavCollectionSnapshot(envelope(home), base, 'addressbook').collections).toEqual([]);
    expect(parseDavCollectionSnapshot(envelope(home + book), base, 'addressbook').collections).toEqual([{ url: `${base}book/`, displayName: 'Contacts' }]);
  });
  it.each([
    envelope(book), envelope(''), envelope('<d:error/>'), '<html>Login</html>', envelope(home + book).slice(0, -10),
    envelope(home + entry('/home/book/', '<d:resourcetype/>', 403)),
    envelope(home + entry('/home/book/', '<d:displayname>Hidden</d:displayname>')),
    envelope(home + book.replace('HTTP/1.1 200 Status', 'HTTP/1.1 401 Unauthorized')),
    envelope(home + book.replace('<d:status>HTTP/1.1 200 Status</d:status>', '')),
    envelope(home + book.replace('/home/book/', '/other/book/')),
    envelope(home + book.replace('/home/book/', 'https://evil.example/home/book/')),
    envelope(home + book + book),
  ])('rejects incomplete/malformed/out-of-scope snapshot %#', raw => {
    expect(() => parseDavCollectionSnapshot(raw, base, 'addressbook')).toThrow();
  });
  it('allows unsupported optional properties while requiring successful resourcetype', () => {
    const optional = '<d:propstat><d:prop><d:displayname/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>';
    expect(parseDavCollectionSnapshot(envelope(home + book.replace('</d:response>', `${optional}</d:response>`)), base, 'addressbook').collections).toHaveLength(1);
    expect(() => parseDavCollectionSnapshot(envelope(home.replace('200 Status', '404 Not Found')), base, 'addressbook')).toThrow(/resourcetype/);
  });
  it('does not mistake extension namespaces for an authoritative DAV home', () => {
    const spoofed = envelope(home + book).replace('xmlns:d="DAV:"', 'xmlns:d="urn:unrelated"');
    expect(() => parseDavCollectionSnapshot(spoofed, base, 'addressbook')).toThrow();
  });
  it('retains observed URLs even when a resource is no longer advertised as an address book', () => {
    const changedType = book.replace('<c:addressbook/>', '<x:other xmlns:x="urn:extension"/>');
    const snapshot = parseDavCollectionSnapshot(envelope(home + changedType), base, 'addressbook');
    expect(snapshot.collections).toEqual([]);
    expect(snapshot.resourceUrls).toEqual([base, `${base}book/`]);
  });
  it('normalizes a trailing slash without conflating different homes or encoded path separators', () => {
    expect(normalizeDavCollectionUrl('https://DAV.example:443/home/%62ook')).toBe(`${base}book/`);
    expect(normalizeDavCollectionUrl('https://dav.example/other')).not.toBe(normalizeDavCollectionUrl(base));
    expect(() => normalizeDavCollectionUrl(`${base}a%2Fb/`)).toThrow();
    expect(() => resolveDavHref('https://user:secret@dav.example/home', base)).toThrow();
  });
  it.each([401, 403, 404, 410, 500, 507])('rejects failed REPORT response status %s instead of treating it as empty', code => {
    const raw = envelope(`<d:response><d:href>/home/book/a.vcf</d:href><d:status>HTTP/1.1 ${code} Error</d:status></d:response>`);
    expect(() => parseCards(raw, `${base}book/`)).toThrow();
  });
  it('rejects a multistatus error envelope as an empty REPORT', () => {
    expect(() => parseCards(envelope('<d:error><d:number-of-matches-within-limits/></d:error>'), base)).toThrow(/incomplete/);
  });
  it('rejects a REPORT resource from another address book', () => {
    const raw = envelope(entry('/other/book/a.vcf', '<c:address-data>BEGIN:VCARD\nFN:Other\nEND:VCARD</c:address-data>'));
    expect(() => parseCards(raw, `${base}book/`)).toThrow(/outside/);
  });
  it('rejects a failed required REPORT payload even with successful optional properties', () => {
    const raw = envelope(entry('/home/book/a.vcf', '<d:getetag>e</d:getetag>').replace('</d:response>', '<d:propstat><d:prop><c:address-data/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>'));
    expect(() => parseCards(raw, `${base}book/`)).toThrow(/incomplete/);
  });
});

async function provider(options: {
  deletion?: number; privilege?: string; methods?: string; inspect?: number;
  kind?: 'calendar' | 'addressbook'; resourceType?: string;
  optionalMethods?: 'omitted' | '404' | '403' | 'malformed'; allow?: string; optionsStatus?: number;
} = {}) {
  let deletes = 0;
  let optionsCalls = 0;
  const kind = options.kind ?? 'addressbook';
  const origin = await listen((request, response) => {
    if (request.method === 'DELETE') { deletes++; response.writeHead(options.deletion ?? 204).end(options.deletion === 207 ? envelope(entry('/home/book/a.vcf', '', 403)) : undefined); return; }
    if (request.method === 'OPTIONS') { optionsCalls++; response.writeHead(options.optionsStatus ?? 200, { Allow: options.allow ?? 'PROPFIND, REPORT, DELETE' }).end(); return; }
    if (options.inspect) { response.writeHead(options.inspect).end(); return; }
    const resourceType = options.resourceType ?? `<d:resourcetype><d:collection/><${kind === 'calendar' ? 'cal:calendar' : 'c:addressbook'}/></d:resourcetype>`;
    const methods = options.optionalMethods === 'malformed' ? '<d:supported-method-set>invalid</d:supported-method-set>'
      : options.optionalMethods ? '' : `<d:supported-method-set><d:supported-method name="${options.methods ?? 'DELETE'}"/></d:supported-method-set>`;
    let raw = entry(request.url || '/', request.url === '/home/'
      ? `<d:current-user-privilege-set><d:privilege><d:${options.privilege ?? 'unbind'}/></d:privilege></d:current-user-privilege-set>`
      : resourceType + methods);
    if (request.url !== '/home/' && ['404', '403'].includes(options.optionalMethods ?? '')) {
      raw = raw.replace('</d:response>', `<d:propstat><d:prop><d:supported-method-set/></d:prop><d:status>HTTP/1.1 ${options.optionalMethods} Unavailable</d:status></d:propstat></d:response>`);
    }
    response.writeHead(207, { 'Content-Type': 'application/xml' });
    response.end(envelope(raw));
  });
  return { input: { kind, url: `${origin}/home/book/`, username: 'synthetic', password: 'synthetic', allowPrivate: true }, deletes: () => deletes, optionsCalls: () => optionsCalls };
}

describe('localhost collection deletion', () => {
  it('keeps the configured request path when slash normalization is only an identity comparison', async () => {
    const calls: string[] = [];
    const origin = await listen((request, response) => {
      calls.push(`${request.method} ${request.url}`);
      if (request.url === '/home/book/') { response.writeHead(404).end(); return; }
      if (request.method === 'DELETE') { response.writeHead(204).end(); return; }
      const props = request.url === '/home/'
        ? '<d:current-user-privilege-set><d:privilege><d:unbind/></d:privilege></d:current-user-privilege-set>'
        : '<d:resourcetype><d:collection/><c:addressbook/></d:resourcetype><d:supported-method-set><d:supported-method name="DELETE"/></d:supported-method-set>';
      response.writeHead(207).end(envelope(entry(request.url || '/', props)));
    });
    expect(await deleteDavCollection({ kind: 'addressbook', url: `${origin}/home/book`, username: 'synthetic', password: 'synthetic', allowPrivate: true })).toMatchObject({ status: 'confirmed', httpStatus: 204 });
    expect(calls).toContain('DELETE /home/book');
    expect(calls.some(call => call.endsWith('/home/book/'))).toBe(false);
  });
  it.each([200, 204, 404, 410])('does not confirm DELETE %s from a different response identity', async status => {
    const server = await provider();
    const original = davTransport.davAuthenticatedFetch;
    let writes = 0;
    const spy = vi.spyOn(davTransport, 'davAuthenticatedFetch').mockImplementation(async (...args) => {
      if (args[1]?.method === 'DELETE') {
        writes++;
        const response = new Response(null, { status });
        Object.defineProperty(response, 'url', { value: 'https://different.example.test/other-book/' });
        return response;
      }
      return original(...args);
    });
    try {
      expect(await deleteDavCollection(server.input)).toMatchObject({ status: 'unknown' });
      expect(writes).toBe(1);
    } finally { spy.mockRestore(); }
  });

  it.each([200, 204, 404, 410])('confirms DELETE status %s only after explicit capability checks', async deletion => {
    const server = await provider({ deletion });
    expect(await deleteDavCollection(server.input)).toMatchObject({ status: 'confirmed', httpStatus: deletion });
    expect(server.deletes()).toBe(1);
  });
  it.each([202, 207, 500])('preserves uncertain DELETE status %s without retry', async deletion => {
    const server = await provider({ deletion });
    expect(await deleteDavCollection(server.input)).toMatchObject({ status: 'unknown', httpStatus: deletion });
    expect(server.deletes()).toBe(1);
  });
  it.each(['read', 'write-content', 'write'])('refuses generic privilege %s without explicit parent unbind', async privilege => {
    const server = await provider({ privilege });
    expect(await deleteDavCollection(server.input)).toMatchObject({ status: 'refused' });
    expect(server.deletes()).toBe(0);
  });
  it('requires advertised DELETE even with parent unbind', async () => {
    const server = await provider({ methods: 'PUT' });
    expect((await discoverDavCollectionDeleteCapability(server.input)).allowed).toBe(false);
    expect(await deleteDavCollection(server.input)).toMatchObject({ status: 'refused' });
    expect(server.deletes()).toBe(0);
    expect(server.optionsCalls()).toBe(0);
  });
  it.each([401, 403, 500, 202])('does not interpret read-back status %s as absent', async inspect => {
    const server = await provider({ inspect });
    expect(await inspectDavCollection(server.input)).toBe('unknown');
  });
  it.each([404, 410])('confirms read-back absence on %s without mutation', async inspect => {
    const server = await provider({ inspect });
    expect(await inspectDavCollection(server.input)).toBe('missing');
    expect(await deleteDavCollection(server.input)).toMatchObject({ status: 'confirmed' });
    expect(server.deletes()).toBe(0);
  });
  it.each(['calendar', 'addressbook'] as const)('allows an exact %s resource with DAV:all on its parent', async kind => {
    const server = await provider({ kind, privilege: 'all' });
    expect(await inspectDavCollection(server.input)).toBe('present');
    expect(await deleteDavCollection(server.input)).toMatchObject({ status: 'confirmed' });
    expect(server.deletes()).toBe(1);
  });
  it.each([
    '<d:resourcetype><d:collection/></d:resourcetype>',
    '<d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>',
    '', '<d:resourcetype/>',
    '<d:resourcetype><d:collection/><c:addressbook/><d:principal/></d:resourcetype>',
    '<d:resourcetype><d:collection/><c:addressbook/><cal:schedule-inbox/></d:resourcetype>',
    '<d:resourcetype><d:collection/><c:addressbook/><cal:schedule-outbox/></d:resourcetype>',
    '<d:resourcetype><d:collection/><c:addressbook/><cal:calendar-home/></d:resourcetype>',
    '<d:resourcetype><d:collection/><fake:addressbook xmlns:fake="urn:fake"/></d:resourcetype>',
    '<d:resourcetype><d:collection/><d:addressbook/></d:resourcetype>',
    '<d:resourcetype><d:collection/><c:addressbook>invalid</c:addressbook></d:resourcetype>',
  ])('refuses wrong/generic/special resource type %# despite DELETE and parent unbind', async resourceType => {
    const server = await provider({ resourceType });
    expect(await inspectDavCollection(server.input)).toBe('unknown');
    expect((await discoverDavCollectionDeleteCapability(server.input)).allowed).toBe(false);
    expect(await deleteDavCollection(server.input)).toMatchObject({ status: 'refused' });
    expect(server.deletes()).toBe(0);
    expect(server.optionsCalls()).toBe(0);
  });
  it.each(['omitted', '404'] as const)('uses OPTIONS only for %s supported-method-set', async optionalMethods => {
    const server = await provider({ optionalMethods });
    expect(await deleteDavCollection(server.input)).toMatchObject({ status: 'confirmed' });
    expect(server.optionsCalls()).toBe(1);
    expect(server.deletes()).toBe(1);
  });
  it.each(['403', 'malformed'] as const)('does not fall back to OPTIONS for %s supported-method-set', async optionalMethods => {
    const server = await provider({ optionalMethods });
    expect(await deleteDavCollection(server.input)).toMatchObject({ status: 'refused' });
    expect(server.optionsCalls()).toBe(0);
    expect(server.deletes()).toBe(0);
  });
  it.each(['PROPFIND, REPORT', 'X-DELETE', 'delete'])('refuses an OPTIONS Allow without the DELETE token: %s', async allow => {
    const server = await provider({ optionalMethods: '404', allow });
    expect(await deleteDavCollection(server.input)).toMatchObject({ status: 'refused' });
    expect(server.optionsCalls()).toBe(1);
    expect(server.deletes()).toBe(0);
  });
  it.each([202, 207, 401, 403, 500])('does not authorize from failed/uncertain OPTIONS status %s', async optionsStatus => {
    const server = await provider({ optionalMethods: 'omitted', optionsStatus });
    expect(await deleteDavCollection(server.input)).toMatchObject({ status: 'refused' });
    expect(server.deletes()).toBe(0);
  });
  it('never authorizes a root resource even when it claims the expected kind', async () => {
    const server = await provider();
    const input = { ...server.input, url: new URL('/', server.input.url).href };
    expect(await inspectDavCollection(input)).toBe('unknown');
    expect(await deleteDavCollection(input)).toMatchObject({ status: 'refused' });
    expect(server.deletes()).toBe(0);
  });
  it.each(['all', 'unbind'])('rejects an extension namespace masquerading as DAV:%s', async privilege => {
    let deletes = 0;
    const origin = await listen((request, response) => {
      if (request.method === 'DELETE') deletes++;
      const props = request.url === '/home/'
        ? `<d:current-user-privilege-set><d:privilege><fake:${privilege} xmlns:fake="urn:fake"/></d:privilege></d:current-user-privilege-set>`
        : '<d:resourcetype><d:collection/><c:addressbook/></d:resourcetype><d:supported-method-set><d:supported-method name="DELETE"/></d:supported-method-set>';
      response.writeHead(207).end(envelope(entry(request.url || '/', props)));
    });
    expect(await deleteDavCollection({ kind: 'addressbook', url: `${origin}/home/book/`, username: 'synthetic', password: 'synthetic', allowPrivate: true })).toMatchObject({ status: 'refused' });
    expect(deletes).toBe(0);
  });
  it('does not interpret a same-origin redirect to a different missing resource as absence', async () => {
    let deletes = 0;
    const origin = await listen((request, response) => {
      if (request.method === 'DELETE') deletes++;
      if (request.url === '/home/book/') response.writeHead(302, { Location: '/missing/' }).end();
      else response.writeHead(404).end();
    });
    const input = { kind: 'addressbook' as const, url: `${origin}/home/book/`, username: 'synthetic', password: 'synthetic', allowPrivate: true };
    expect(await inspectDavCollection(input)).toBe('unknown');
    expect(await deleteDavCollection(input)).toMatchObject({ status: 'refused' });
    expect(deletes).toBe(0);
  });
  it.each([
    { target: true, body: '<d:resourcetype><d:collection/></d:resourcetype>' },
    { target: false, body: '<d:current-user-privilege-set><d:privilege><d:unbind>invalid</d:unbind></d:privilege></d:current-user-privilege-set>' },
    { target: false, body: '<d:current-user-privilege-set><d:privilege><d:all><d:read/></d:all></d:privilege></d:current-user-privilege-set>' },
    { target: true, body: '<d:supported-method-set><d:supported-method name="DELETE">invalid</d:supported-method></d:supported-method-set>' },
  ])('refuses malformed or contradictory capability properties %#', async malformed => {
    let deletes = 0;
    const origin = await listen((request, response) => {
      if (request.method === 'DELETE') deletes++;
      const isTarget = request.url !== '/home/';
      const props = isTarget
        ? '<d:resourcetype><d:collection/><c:addressbook/></d:resourcetype><d:supported-method-set><d:supported-method name="DELETE"/></d:supported-method-set>'
        : '<d:current-user-privilege-set><d:privilege><d:unbind/></d:privilege></d:current-user-privilege-set>';
      const raw = entry(request.url || '/', props);
      const extra = `<d:propstat><d:prop>${malformed.body}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>`;
      response.writeHead(207).end(envelope(isTarget === malformed.target
        ? malformed.target ? raw.replace('</d:response>', extra + '</d:response>') : entry(request.url || '/', malformed.body)
        : raw));
    });
    expect(await deleteDavCollection({ kind: 'addressbook', url: `${origin}/home/book/`, username: 'synthetic', password: 'synthetic', allowPrivate: true })).toMatchObject({ status: 'refused' });
    expect(deletes).toBe(0);
  });
  it('blocks cross-origin OPTIONS redirects before credential replay', async () => {
    let attackerRequests = 0;
    let deletes = 0;
    const attacker = await listen((_request, response) => {
      attackerRequests++;
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="untrusted"' }).end();
    });
    const origin = await listen((request, response) => {
      if (request.method === 'DELETE') deletes++;
      if (request.method === 'OPTIONS') { response.writeHead(302, { Location: `${attacker}/capability/` }).end(); return; }
      response.writeHead(207).end(envelope(entry(request.url || '/', '<d:resourcetype><d:collection/><c:addressbook/></d:resourcetype>')));
    });
    expect(await deleteDavCollection({ kind: 'addressbook', url: `${origin}/home/book/`, username: 'synthetic', password: 'synthetic', allowPrivate: true })).toMatchObject({ status: 'refused' });
    expect(attackerRequests).toBe(0);
    expect(deletes).toBe(0);
  });
  it('recognizes correctly scoped default namespaces for type and parent privileges', async () => {
    let deletes = 0;
    const origin = await listen((request, response) => {
      if (request.method === 'DELETE') { deletes++; response.writeHead(204).end(); return; }
      const props = request.url === '/home/'
        ? '<current-user-privilege-set><privilege><all/></privilege></current-user-privilege-set>'
        : '<resourcetype><collection/><calendar xmlns="urn:ietf:params:xml:ns:caldav"/></resourcetype><supported-method-set><supported-method name="DELETE"/></supported-method-set>';
      response.writeHead(207).end(`<multistatus xmlns="DAV:"><response><href>${request.url}</href><propstat><prop>${props}</prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`.replaceAll('><', '>\n  <'));
    });
    expect(await deleteDavCollection({ kind: 'calendar', url: `${origin}/home/calendar/`, username: 'synthetic', password: 'synthetic', allowPrivate: true })).toMatchObject({ status: 'confirmed' });
    expect(deletes).toBe(1);
  });
  it('accepts same-origin well-known redirects using the final resource identity', async () => {
    const origin = await listen((request, response) => {
      if (request.url === '/' || request.url === '/.well-known/carddav') { response.writeHead(301, { Location: '/dav/' }).end(); return; }
      response.writeHead(207);
      if (request.url === '/dav/') response.end(envelope(entry('/dav/', '<d:current-user-principal><d:href>/principal/</d:href></d:current-user-principal>')));
      else if (request.url === '/principal/') response.end(envelope(entry('/principal/', '<c:addressbook-home-set><d:href>/home/</d:href></c:addressbook-home-set>')));
      else response.end(envelope(home + book));
    });
    const snapshot = await discoverAddressBookSnapshot({ serverUrl: `${origin}/`, username: 'synthetic', password: 'synthetic', allowPrivate: true });
    expect(snapshot).toMatchObject({ homeUrl: `${origin}/home/`, collections: [{ url: `${origin}/home/book/` }] });
  });
  it('does not follow cross-origin discovery hrefs or redirects even when private hosts are allowed', async () => {
    let leakedRequests = 0;
    const attacker = await listen((_request, response) => { leakedRequests++; response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="attack"' }).end(); });
    for (const redirect of [true, false]) {
      const origin = await listen((request, response) => {
        if (redirect) { response.writeHead(302, { Location: `${attacker}/principal` }).end(); return; }
        response.writeHead(207).end(envelope(entry(request.url || '/', `<d:current-user-principal><d:href>${attacker}/principal</d:href></d:current-user-principal>`)));
      });
      await expect(discoverAddressBookSnapshot({ serverUrl: `${origin}/`, username: 'synthetic', password: 'synthetic', allowPrivate: true })).rejects.toThrow(/origin/);
    }
    expect(leakedRequests).toBe(0);
  });
});
