import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { davAuthenticatedFetch } from './davHttpAuth.js';

export interface DavCollectionInput { url: string; username: string; password: string; allowPrivate?: boolean }
export interface DavTypedCollectionInput extends DavCollectionInput { kind: 'calendar' | 'addressbook' }
export interface DavCollectionSnapshot {
  homeUrl: string;
  /** All direct responses, including resources whose current type is not a book. */
  resourceUrls: string[];
  collections: Array<{ url: string; displayName: string; color?: string }>;
}
export type DavCollectionDeleteResult = { status: 'confirmed' | 'refused' | 'unknown'; httpStatus?: number; reason?: string };
export interface DavCollectionDeleteCapability { allowed: boolean; reason: string }

const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, trimValues: false });
const qualifiedParser = new XMLParser({ ignoreAttributes: false, trimValues: false });
const array = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : typeof record(value)['#text'] === 'string' ? String(record(value)['#text']).trim() : '';

function elementNames(node: Record<string, unknown>): string[] {
  return Object.keys(node).filter(name => !name.startsWith('@_')
    && !(name === '#text' && typeof node[name] === 'string' && !node[name].trim()));
}

/** Destructive capability checks must distinguish DAV/CalDAV/CardDAV names from
 * similarly named extension elements. Discovery retains its existing parser. */
function qualifiedDavTree(value: unknown, inherited: Record<string, string> = {}): unknown {
  if (Array.isArray(value)) return value.map(item => qualifiedDavTree(item, inherited));
  if (!value || typeof value !== 'object') return value;
  const node = record(value);
  const namespaces = { ...inherited };
  for (const [name, uri] of Object.entries(node)) {
    if (name === '@_xmlns' && typeof uri === 'string') namespaces[''] = uri;
    if (name.startsWith('@_xmlns:') && typeof uri === 'string') namespaces[name.slice(8)] = uri;
  }
  const result: Record<string, unknown> = {};
  for (const [name, child] of Object.entries(node)) {
    if (name.startsWith('@_') || name.startsWith('?') || name === '#text') { result[name] = child; continue; }
    // Declarations on a child also qualify that child's own element name.
    const children = Array.isArray(child) ? child : [child];
    for (const item of children) {
      const declarations = { ...namespaces };
      for (const [attribute, uri] of Object.entries(record(item))) {
        if (attribute === '@_xmlns' && typeof uri === 'string') declarations[''] = uri;
        if (attribute.startsWith('@_xmlns:') && typeof uri === 'string') declarations[attribute.slice(8)] = uri;
      }
      const colon = name.indexOf(':');
      const local = colon < 0 ? name : name.slice(colon + 1);
      const uri = declarations[colon < 0 ? '' : name.slice(0, colon)] ?? '';
      const recognized = (uri === 'DAV:' && !['calendar', 'addressbook'].includes(local))
        || (uri === 'urn:ietf:params:xml:ns:caldav' && ['calendar', 'schedule-inbox', 'schedule-outbox'].includes(local))
        || (uri === 'urn:ietf:params:xml:ns:carddav' && local === 'addressbook');
      const qualified = recognized ? local : `{${uri}}${local}`;
      const converted = qualifiedDavTree(item, namespaces);
      if (Object.hasOwn(result, qualified)) result[qualified] = [...array(result[qualified]), converted];
      else result[qualified] = converted;
    }
  }
  return result;
}

/** Preserve home paths: only origin, unreserved escapes and collection trailing slash are canonicalized. */
export function normalizeDavCollectionUrl(value: string): string {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || /%(?:2f|5c|00)/i.test(url.pathname)) {
    throw new Error('Invalid DAV collection URL');
  }
  url.pathname = url.pathname.replace(/%[0-9a-f]{2}/gi, escape => {
    const character = String.fromCharCode(parseInt(escape.slice(1), 16));
    return /[A-Za-z0-9_~-]/.test(character) ? character : escape.toUpperCase();
  }).replace(/\/?$/, '/');
  return url.href;
}

/** Every server-supplied href is untrusted, including principals and redirects. */
export function resolveDavHref(href: string, base: string): string {
  if (!href.trim() || href.includes('\\') || [...href].some(character => character.charCodeAt(0) < 32)) throw new Error('Invalid DAV href');
  const url = new URL(href.trim(), base);
  if (url.origin !== new URL(base).origin || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
    throw new Error('DAV href must remain on the configured origin');
  }
  return url.href;
}

/** Follow DAV discovery redirects only after checking origin, before auth can be replayed. */
export async function davCollectionRequest(input: DavCollectionInput, init: RequestInit): Promise<Response> {
  let url = resolveDavHref(input.url, input.url);
  for (let hop = 0; hop < 6; hop++) {
    const response = await davAuthenticatedFetch(url, { ...init, redirect: 'manual', signal: init.signal ?? AbortSignal.timeout(30_000) }, input, { allowPrivate: input.allowPrivate });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (init.method === 'DELETE') return response;
    const location = response.headers.get('location');
    await response.arrayBuffer();
    if (!location) throw new Error('DAV redirect has no location');
    url = resolveDavHref(location, url);
  }
  throw new Error('Too many DAV redirects');
}

function status(value: unknown): number | null {
  const match = /^HTTP\/\d+(?:\.\d+)?\s+(\d{3})(?:\s|$)/.exec(text(value));
  return match ? Number(match[1]) : null;
}

function responses(raw: string, qualified = false): Record<string, unknown>[] {
  if (XMLValidator.validate(raw) !== true || /<!DOCTYPE/i.test(raw)) throw new Error('DAV server returned an invalid multistatus response');
  const parsed: unknown = qualified ? qualifiedDavTree(qualifiedParser.parse(raw)) : parser.parse(raw);
  const root = record(parsed);
  if (!Object.hasOwn(root, 'multistatus') || Object.keys(root).some(key => key !== 'multistatus' && !key.startsWith('?'))) throw new Error('DAV server returned an invalid multistatus response');
  const multistatus = record(root.multistatus);
  if (Object.keys(multistatus).some(key => !['response', 'responsedescription', 'sync-token'].includes(key) && !key.startsWith('@_') && !(key === '#text' && !text(multistatus[key])))) throw new Error('DAV server returned an incomplete multistatus response');
  return array(multistatus.response).map(value => {
    const response = record(value);
    if (!text(response.href)) throw new Error('DAV response has no href');
    if (Object.hasOwn(response, 'status')) {
      const code = status(response.status);
      if (code === null || code < 200 || code >= 300) throw new Error('DAV server returned an incomplete collection response');
    }
    return response;
  });
}

function properties(response: Record<string, unknown>, strict = false): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const seen = new Set<string>();
  const blocks = array(response.propstat);
  if (!blocks.length) throw new Error('DAV response has no property statuses');
  for (const value of blocks) {
    const block = record(value);
    const code = status(block.status);
    // Unsupported optional properties may be 404; authorization/server/partial errors are never authoritative.
    if (code === null || (code !== 404 && (code < 200 || code >= 300))) throw new Error('DAV server returned an incomplete property response');
    if (strict) {
      for (const name of elementNames(record(block.prop))) {
        if (seen.has(name)) throw new Error('DAV response contains duplicate property statuses');
        seen.add(name);
      }
    }
    if (code >= 200 && code < 300) Object.assign(result, record(block.prop));
  }
  return result;
}

export function parseDavCollectionSnapshot(raw: string, home: string, kind: 'calendar' | 'addressbook'): DavCollectionSnapshot {
  const homeUrl = normalizeDavCollectionUrl(home);
  const collections: DavCollectionSnapshot['collections'] = [];
  const seen = new Set<string>();
  let foundHome = false;
  for (const response of responses(raw, true)) {
    const url = normalizeDavCollectionUrl(resolveDavHref(text(response.href), homeUrl));
    if (seen.has(url)) throw new Error('DAV server returned duplicate collection responses');
    seen.add(url);
    const props = properties(response);
    if (!Object.hasOwn(props, 'resourcetype')) throw new Error('DAV collection response is missing resourcetype');
    if (props.resourcetype !== '' && (props.resourcetype === null || typeof props.resourcetype !== 'object' || Array.isArray(props.resourcetype))) throw new Error('DAV response has an invalid resourcetype');
    const resourceType = record(props.resourcetype);
    if (url === homeUrl) {
      if (!Object.hasOwn(resourceType, 'collection')) throw new Error('DAV home is not a collection');
      foundHome = true;
    } else if (!url.startsWith(homeUrl) || url.slice(homeUrl.length).replace(/\/$/, '').includes('/')) {
      throw new Error('DAV collection response is outside the requested home');
    }
    if (Object.hasOwn(resourceType, kind)) {
      if (!Object.hasOwn(resourceType, 'collection')) throw new Error('DAV resource is not a collection');
      collections.push({ url, displayName: text(props.displayname) || (kind === 'calendar' ? 'Calendar' : 'Contacts'), ...(text(props['calendar-color']) ? { color: text(props['calendar-color']) } : {}) });
    }
  }
  if (!foundHome) throw new Error('DAV collection snapshot is missing its home response');
  return { homeUrl, resourceUrls: [...seen], collections };
}

async function propfind(input: DavCollectionInput, propertyXml: string): Promise<Response> {
  return davCollectionRequest(input, { method: 'PROPFIND', headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' }, body: `<propfind xmlns="DAV:"><prop>${propertyXml}</prop></propfind>` });
}

export function ownProperties(raw: string, url: string): Record<string, unknown> {
  const entries = responses(raw, true);
  if (entries.length !== 1 || normalizeDavCollectionUrl(resolveDavHref(text(entries[0].href), url)) !== normalizeDavCollectionUrl(url)) throw new Error('DAV response does not identify the requested collection');
  return properties(entries[0], true);
}

function typedTargetUrl(input: DavTypedCollectionInput): string {
  if (input.kind !== 'calendar' && input.kind !== 'addressbook') throw new Error('Expected DAV collection kind is required');
  const url = resolveDavHref(input.url, input.url);
  if (new URL(normalizeDavCollectionUrl(url)).pathname === '/') throw new Error('Deleting or reconciling a DAV root is unsupported');
  return url;
}

function emptyMarker(value: unknown): boolean {
  return value === '' || (typeof value === 'object' && value !== null && !Array.isArray(value)
    && elementNames(record(value)).length === 0);
}

function isExpectedCollection(props: Record<string, unknown>, kind: DavTypedCollectionInput['kind']): boolean {
  const resourceType = record(props.resourcetype);
  // Only an ordinary collection of this exact kind is deletable. Principal,
  // home, scheduling and mixed/extension resource types are not leaf collections.
  const names = elementNames(resourceType);
  return names.length === 2 && names.includes('collection') && names.includes(kind)
    && emptyMarker(resourceType.collection) && emptyMarker(resourceType[kind]);
}

function assertResponseIdentity(response: Response, url: string): void {
  if (response.url && normalizeDavCollectionUrl(resolveDavHref(response.url, url)) !== normalizeDavCollectionUrl(url)) {
    throw new Error('DAV response changed the requested collection identity');
  }
}

export async function discoverDavCollectionDeleteCapability(input: DavTypedCollectionInput): Promise<DavCollectionDeleteCapability> {
  try {
    const url = typedTargetUrl(input);
    const response = await propfind({ ...input, url }, '<supported-method-set/><resourcetype/>');
    assertResponseIdentity(response, url);
    if (response.status !== 207) return { allowed: false, reason: `Collection capability request failed (${response.status})` };
    const props = ownProperties(await response.text(), url);
    if (!isExpectedCollection(props, input.kind)) return { allowed: false, reason: `Remote resource is not an ordinary ${input.kind} collection` };
    let supportsDelete: boolean;
    if (Object.hasOwn(props, 'supported-method-set')) {
      const methodSet = record(props['supported-method-set']);
      const methods = array(methodSet['supported-method']);
      supportsDelete = elementNames(methodSet).every(name => name === 'supported-method')
        && methods.every(method => emptyMarker(method) && typeof record(method)['@_name'] === 'string')
        && methods.some(method => record(method)['@_name'] === 'DELETE');
    } else {
      // An omitted/404 optional property can fall back to OPTIONS. Explicit
      // denial, malformed statuses or an advertised set without DELETE cannot.
      const options = await davCollectionRequest(input, { method: 'OPTIONS' });
      assertResponseIdentity(options, url);
      supportsDelete = [200, 204].includes(options.status)
        && (options.headers.get('Allow') ?? '').split(',').map(method => method.trim()).includes('DELETE');
      await options.arrayBuffer();
    }
    if (!supportsDelete) return { allowed: false, reason: 'Server did not explicitly advertise collection DELETE' };
    const parentUrl = new URL('../', normalizeDavCollectionUrl(url)).href;
    const parent = await propfind({ ...input, url: parentUrl }, '<current-user-privilege-set/>');
    assertResponseIdentity(parent, parentUrl);
    if (parent.status !== 207) return { allowed: false, reason: `Parent privilege request failed (${parent.status})` };
    const parentProps = ownProperties(await parent.text(), parentUrl);
    const privileges = array(record(parentProps['current-user-privilege-set']).privilege);
    if (!privileges.some(privilege => {
      const names = elementNames(record(privilege));
      return names.length === 1 && ['unbind', 'all'].includes(names[0]) && emptyMarker(record(privilege)[names[0]]);
    })) return { allowed: false, reason: 'Server did not explicitly grant unbind or DAV:all on the parent collection' };
    return { allowed: true, reason: 'Collection kind, DELETE and parent unbind permission explicitly verified' };
  } catch (error) {
    return { allowed: false, reason: error instanceof Error ? error.message : 'Collection capabilities could not be verified' };
  }
}

/** Read-only recovery: failure/denial/type mismatch is not absence, and must not cause a DELETE retry. */
export async function inspectDavCollection(input: DavTypedCollectionInput): Promise<'present' | 'missing' | 'unknown'> {
  try {
    const url = typedTargetUrl(input);
    const response = await propfind(input, '<resourcetype/>');
    assertResponseIdentity(response, url);
    if ([404, 410].includes(response.status)) return 'missing';
    if (response.status !== 207) return 'unknown';
    const props = ownProperties(await response.text(), url);
    return isExpectedCollection(props, input.kind) ? 'present' : 'unknown';
  } catch {
    // This result explicitly preserves uncertain state for the durable caller.
    return 'unknown';
  }
}

/** Caller must persist intent before invoking this method, then persist the returned outcome. */
export async function deleteDavCollection(input: DavTypedCollectionInput): Promise<DavCollectionDeleteResult> {
  if (await inspectDavCollection(input) === 'missing') return { status: 'confirmed', reason: 'Collection is already absent' };
  const capability = await discoverDavCollectionDeleteCapability(input);
  if (!capability.allowed) return { status: 'refused', reason: capability.reason };
  try {
    const response = await davCollectionRequest(input, { method: 'DELETE' });
    assertResponseIdentity(response, input.url);
    const httpStatus = response.status;
    if ([200, 204, 404, 410].includes(httpStatus)) return { status: 'confirmed', httpStatus };
    if ([401, 403, 405].includes(httpStatus)) return { status: 'refused', httpStatus, reason: 'Provider refused collection deletion' };
    // 207 can describe a partially completed recursive delete, and 202 is only acceptance.
    return { status: 'unknown', httpStatus, reason: 'Provider did not confirm complete collection deletion' };
  } catch (error) {
    return { status: 'unknown', reason: error instanceof Error ? error.message : 'Collection deletion outcome is unknown' };
  }
}
