import { requireCompleteMultistatus } from '../utils/davXml.js';
// Minimal CardDAV *client* — discovers address books on a remote server (e.g.
// Nextcloud) and pulls vCards. One-way/read-only: we never write back.
//
// Flow: current-user-principal -> addressbook-home-set -> enumerate collections
// -> addressbook-query REPORT for each book's vCards. Uses native fetch with the
// WebDAV verbs PROPFIND/REPORT and HTTP Basic auth. Host is SSRF-validated up
// front (reusing the same policy IMAP/SMTP hosts use).

import { XMLParser } from 'fast-xml-parser';
import { validateHost } from './hostValidation.js';
import { davAuthenticatedFetch } from './davHttpAuth.js';
import { toAppError } from '../utils/errors.js';

interface DavRequestOptions {
  username: string;
  password: string;
  depth?: number | string | null;
  body?: unknown;
  allowPrivate?: boolean;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,   // <d:response> -> response, so parsing is namespace-agnostic
  trimValues: false,      // preserve vCard line structure inside <address-data>
  // Large CardDAV REPORTs can exceed fast-xml-parser's 1000-expansion default.
  // Raise it generously while preserving the previous depth setting.
  processEntities: { maxTotalExpansions: 10_000_000, maxExpansionDepth: 10 },
});

/** The credentials + policy one DAV request carries. */
interface DavCredentials { username: string; password: string; allowPrivate?: boolean }

const toArray = <T>(x: T | T[] | null | undefined): T[] => (Array.isArray(x) ? x : x == null ? [] : [x]);

async function assertHostAllowed(url: string, allowPrivate: boolean): Promise<void> {
  let hostname;
  try { hostname = new URL(url).hostname; }
  catch { throw new Error('Invalid server URL'); }
  const err = await validateHost(hostname, { allowPrivate });
  if (err) throw new Error(err);
}

async function dav(method: string, url: string, { username, password, depth, body, allowPrivate = false }: DavRequestOptions) {
  // Re-validate on every request: hrefs returned by the server (principal, home
  // set, book URLs) are attacker-influenced and could point at internal hosts.
  await assertHostAllowed(url, allowPrivate);
  const headers: Record<string, string> = {
    'Content-Type': 'application/xml; charset=utf-8',
  };
  if (depth != null) headers.Depth = String(depth);
  let res;
  try {
    // safeFetch validates every redirect hop's IP (well-known discovery relies on
    // the server's 301 redirect), honouring the admin private-host policy.
    res = await davAuthenticatedFetch(
      url,
      { method, headers, body: body as RequestInit['body'], redirect: 'follow', signal: AbortSignal.timeout(30000) },
      { username, password },
      { allowPrivate },
    );
  } catch (caught) {
    const err = toAppError(caught);
    if (err.name === 'TimeoutError') throw new Error('CardDAV server did not respond (timed out)', { cause: caught });
    throw new Error(`Could not reach the CardDAV server: ${err.message}`, { cause: caught });
  }
  if (res.status === 401) throw new Error('Authentication failed — check the username and app password');
  if (!res.ok && res.status !== 207) {
    throw new Error(`CardDAV request failed (${res.status} ${res.statusText})`);
  }
  return res.text();
}

// Merge the <prop> blocks from every 2xx propstat of a <response> into one object.
// A propstat carrying a non-2xx status (e.g. 404 for unsupported props) is skipped;
// a propstat with no status line at all is treated as usable.
interface DavPropBlock {
  resourcetype?: Record<string, unknown>;
  displayname?: unknown;
  getetag?: unknown;
  // PROPFIND/REPORT merges arbitrary namespace-stripped property names into this
  // object (current-user-principal, addressbook-home-set, address-data, ...).
  [propName: string]: unknown;
}

type DavPropStat = { status?: unknown; prop?: Record<string, unknown> };

function propsOf(response: { propstat?: DavPropStat | DavPropStat[] }): DavPropBlock {
  const merged: DavPropBlock = {};
  for (const ps of toArray(response.propstat)) {
    const status = typeof ps.status === 'string' ? ps.status : '';
    if (status && !/\b2\d\d\b/.test(status)) continue;
    Object.assign(merged, ps.prop || {});
  }
  return merged;
}

function textOf(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'object' && node !== null && '#text' in node) return String((node as Record<string, unknown>)['#text']);
  return '';
}

// fast-xml-parser decodes named XML entities (&amp; -> &) but leaves numeric
// character references (&#13;, &#xE9;) as literal text. Nextcloud/SabreDAV encodes
// each vCard line's trailing CR as &#13; inside <address-data> so the CRLF endings
// survive XML line-ending normalization; without decoding, every parsed field keeps
// a literal "&#13;" (and an empty property renders as just "&#13;"). Decode decimal
// and hex references back to their characters — the vCard parser then handles the
// restored CR/LF normally. Named entities are left for the XML parser to resolve.
function decodeXmlCharRefs(str: string) {
  return str.replace(/&#([xX][0-9a-fA-F]+|\d+);/g, (match, code: string) => {
    const cp = (code[0] === 'x' || code[0] === 'X')
      ? parseInt(code.slice(1), 16)
      : parseInt(code, 10);
    // Reject out-of-range and surrogate code points; leave those references as-is.
    if (!Number.isFinite(cp) || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return match;
    try { return String.fromCodePoint(cp); }
    catch { return match; }
  });
}

// Resolve an href (often an absolute path) against the request URL's origin.
function absolute(href: string, baseUrl: string): string {
  try { return new URL(href, baseUrl).href; }
  catch { return href; }
}

// Pure: pull a single href-valued property out of a PROPFIND multistatus, by its
// namespace-stripped local name (e.g. 'current-user-principal'). Exported for testing.
export function extractHref(xmlText: unknown, key: string, baseUrl: string): string | null {
  const xml = parser.parse(String(xmlText ?? ''));
  const response = toArray(xml?.multistatus?.response)[0];
  if (!response) return null;
  const val: unknown = propsOf(response)[key];
  const href = val !== null && typeof val === 'object' && 'href' in val ? val.href ?? val : val;
  const text = textOf(href) || (typeof href === 'string' ? href : '');
  return text ? absolute(text, baseUrl) : null;
}

// PROPFIND for a single href-valued property. `key` is the expected local name in
// the response (passed explicitly rather than derived from the request markup).
async function propfindHref(url: string, propXml: string, key: string, creds: DavCredentials): Promise<string | null> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<propfind xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav"><prop>${propXml}</prop></propfind>`;
  return extractHref(await dav('PROPFIND', url, { ...creds, depth: 0, body }), key, url);
}

// Find the user's principal URL. Tries the given URL, then RFC 6764 well-known
// discovery (Nextcloud users usually enter just the base URL, which 301-redirects
// from /.well-known/carddav to the DAV context — fetch follows that automatically).
async function resolvePrincipal(serverUrl: string, creds: DavCredentials): Promise<string> {
  const origin = new URL(serverUrl).origin;
  const candidates = [serverUrl, `${origin}/.well-known/carddav`];
  let lastErr;
  for (const base of candidates) {
    try {
      const principal = await propfindHref(base, '<current-user-principal/>', 'current-user-principal', creds);
      if (principal) return principal;
    } catch (caught) {
      const err = toAppError(caught);
      if (/Authentication failed/.test(err.message)) throw err; // wrong creds — stop trying
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;
  return serverUrl; // some servers expose the home set directly at the given URL
}

// Discover every address book on the server for these credentials.
// Returns [{ url, displayName }].
export async function discoverAddressBooks({ serverUrl, username, password, allowPrivate = false }: { serverUrl: string; username: string; password: string; allowPrivate?: boolean }): Promise<Array<{ url: string; displayName: string }>> {
  await assertHostAllowed(serverUrl, allowPrivate);
  const creds = { username, password, allowPrivate };

  const principal = await resolvePrincipal(serverUrl, creds);
  const homeSet = await propfindHref(principal, '<C:addressbook-home-set/>', 'addressbook-home-set', creds)
    || principal;

  // Enumerate collections under the home set (Depth: 1).
  const body = `<?xml version="1.0" encoding="utf-8"?>
<propfind xmlns="DAV:" xmlns:cs="http://calendarserver.org/ns/"><prop>
  <resourcetype/><displayname/><cs:getctag/></prop></propfind>`;
  const xmlText = await dav('PROPFIND', homeSet, { ...creds, depth: 1, body });
  const books = parseAddressBooks(xmlText, homeSet);
  if (!books.length) throw new Error('No address books found for this account');
  return books;
}

// Pure: extract address-book collections from a PROPFIND multistatus. Exported
// for testing. Returns [{ url, displayName }].
export function parseAddressBooks(xmlText: unknown, baseUrl: string): Array<{ url: string; displayName: string }> {
  const xml = parser.parse(String(xmlText ?? ''));
  const books = [];
  for (const response of toArray(xml?.multistatus?.response)) {
    const props = propsOf(response);
    const rt = props.resourcetype || {};
    if (!('addressbook' in rt)) continue; // only address book collections
    const href = textOf(response.href) || response.href;
    if (!href) continue;
    books.push({
      url: absolute(href, baseUrl),
      displayName: textOf(props.displayname) || 'Contacts',
    });
  }
  return books;
}

// Fetch every vCard in an address book via a filter-less addressbook-query REPORT.
// Returns [{ href, etag, vcard }].
/**
 * Whether a PROPFIND's `current-user-privilege-set` grants a write (DAV-02).
 *
 * The audit's DAV-02: the source's permission was **asserted** as `read_write` for every collection, so the
 * interface offered writes the server then refused. The server's own answer to this property is the fact that was
 * missing, and these are the privileges that mean "writing is accepted here" — `write` itself, writing the content
 * (`write-content`), changing properties (`write-properties`), and the collection-level bind/unbind. A set that
 * names only read privileges is `read_only`; **null** means the server did not tell us (the property was absent or
 * unreadable), which is deliberately not collapsed into either answer: guessing `read_only` there would refuse
 * writes that work.
 *
 * Pure and exported: the interpretation of a server's document is exactly what should be tested without a server.
 */
export function davWriteAccessFromPrivilegeSet(xmlText: unknown): 'read_write' | 'read_only' | null {
  let xml: { multistatus?: { response?: unknown } };
  try {
    xml = parser.parse(String(xmlText ?? '')) as { multistatus?: { response?: unknown } };
  } catch {
    // A document that cannot be parsed is a server that did not answer the question — the same as one that omits
    // the property, and deliberately not an error: discovery must be able to fail without failing the pull.
    return null;
  }
  const response = toArray(xml?.multistatus?.response)[0];
  if (!response) return null;
  const value: unknown = propsOf(response)['current-user-privilege-set'];
  if (value == null) return null;
  const privileges = toArray((value as { privilege?: unknown })?.privilege)
    .map(entry => {
      if (typeof entry === 'string') return entry.trim();
      if (entry && typeof entry === 'object') {
        const names = Object.keys(entry as Record<string, unknown>);
        return names.length > 0 ? names[0] : '';
      }
      return '';
    })
    .filter(Boolean);
  if (privileges.length === 0) return null;
  const writes = new Set(['write', 'write-content', 'write-properties', 'bind', 'unbind']);
  return privileges.some(privilege => writes.has(privilege)) ? 'read_write' : 'read_only';
}

/** Ask one collection what this user may do with it. A server that will not say leaves the caller's value alone. */
export async function discoverDavWriteAccess(input: {
  url: string;
  username: string;
  password: string;
  allowPrivate?: boolean;
}): Promise<'read_write' | 'read_only' | null> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<propfind xmlns="DAV:"><prop><current-user-privilege-set/></prop></propfind>`;
  try {
    const xmlText = await dav('PROPFIND', input.url, {
      username: input.username, password: input.password, depth: 0, body, allowPrivate: input.allowPrivate ?? false,
    });
    return davWriteAccessFromPrivilegeSet(xmlText);
  } catch (caught) {
    // A collection that cannot be asked is not evidence of anything: the caller keeps what it has.
    console.warn('Could not read a DAV collection\'s privileges:', toAppError(caught).message);
    return null;
  }
}

export async function fetchAddressBookCards({ url, username, password, allowPrivate = false }: { url: string; username: string; password: string; allowPrivate?: boolean }): Promise<Array<{ href: string; etag: string | null; vcard: string }>> {
  await assertHostAllowed(url, allowPrivate);
  const body = `<?xml version="1.0" encoding="utf-8"?>
<C:addressbook-query xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav"><prop>
  <getetag/><C:address-data/></prop></C:addressbook-query>`;
  const xmlText = await dav('REPORT', url, { username, password, depth: 1, body, allowPrivate });
  return parseCards(xmlText, url);
}

// Pure: extract vCards from an addressbook-query/REPORT multistatus. Exported for
// testing. Returns [{ href, etag, vcard }].
export function parseCards(xmlText: unknown, baseUrl: string): Array<{ href: string; etag: string | null; vcard: string }> {
  const xml = parser.parse(String(xmlText ?? ''));
  const responses = toArray(xml?.multistatus?.response);
  if (responses.some(response => /\b507\b/.test(textOf(response.status)))) {
    throw new Error('CardDAV server returned a truncated address book response');
  }
  requireCompleteMultistatus(String(xmlText ?? ''), xml);
  const cards = [];
  for (const response of responses) {
    const props = propsOf(response);
    const vcard = decodeXmlCharRefs(textOf(props['address-data'])).trim();
    if (!vcard) continue; // collection self-entry or a non-vCard resource
    cards.push({
      href: absolute(textOf(response.href) || response.href, baseUrl),
      etag: (textOf(props.getetag) || '').replace(/"/g, ''),
      vcard,
    });
  }
  return cards;
}
