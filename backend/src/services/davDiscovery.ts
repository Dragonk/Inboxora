import { extractHref } from './carddavClient.js';
import { davCollectionRequest, ownProperties, normalizeDavCollectionUrl, parseDavCollectionSnapshot, type DavCollectionSnapshot } from './davCollectionClient.js';
import { getConnectionPolicy } from './connectionPolicy.js';
import { validateHost, validateHostLiteral } from './hostValidation.js';

export interface DavCredentials { serverUrl: string; username: string; password: string }
export interface DavDiscovery { calendars: DavCollectionSnapshot | null; contacts: DavCollectionSnapshot | null }
export class DavAccountError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}
const XML = '<?xml version="1.0" encoding="utf-8"?>';
const envelope = (properties: string) => `${XML}<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="urn:ietf:params:xml:ns:carddav"><d:prop>${properties}</d:prop></d:propfind>`;

export async function discoverDavAccount(input: DavCredentials): Promise<DavDiscovery> {
  let serverUrl: string;
  try { serverUrl = normalizeDavCollectionUrl(input.serverUrl); }
  catch { throw new DavAccountError('DAV_INVALID_URL'); }
  const policy = await getConnectionPolicy();
  const parsed = new URL(serverUrl);
  // DNS failure does not prove a public HTTP host is private. Permit plaintext
  // only for literal private/local hosts when the administrator explicitly allows it.
  if (parsed.protocol === 'http:' && (!policy.allowPrivateHosts || !validateHostLiteral(parsed.hostname))) {
    throw new DavAccountError('DAV_HTTPS_REQUIRED');
  }
  if (await validateHost(parsed.hostname, { allowPrivate: policy.allowPrivateHosts })) throw new DavAccountError('DAV_HOST_BLOCKED');
  const request = async (url: string, props: string, depth = '0') => {
    const response = await davCollectionRequest({ url, username: input.username, password: input.password, allowPrivate: policy.allowPrivateHosts }, {
      method: 'PROPFIND', headers: { Depth: depth, 'Content-Type': 'application/xml; charset=utf-8' }, body: envelope(props),
      signal: AbortSignal.timeout(30_000),
    });
    if ([401, 403].includes(response.status)) throw new DavAccountError('DAV_AUTH_FAILED');
    if ([404, 405, 501].includes(response.status)) return null;
    if (response.status !== 207) throw new DavAccountError('DAV_DISCOVERY_FAILED', 502);
    return { xml: await response.text(), url: response.url || url };
  };
  const discover = async (kind: 'caldav' | 'carddav'): Promise<DavCollectionSnapshot | null> => {
    const property = kind === 'caldav' ? 'calendar-home-set' : 'addressbook-home-set';
    const requested = kind === 'caldav' ? '<c:calendar-home-set/>' : '<a:addressbook-home-set/>';
    const type = kind === 'caldav' ? 'calendar' : 'addressbook';
    for (const candidate of [serverUrl, `${parsed.origin}/.well-known/${kind}`]) {
      const root = await request(candidate, '<d:current-user-principal/>' + requested + '<d:resourcetype/>');
      if (!root) continue;
      const principal = extractHref(root.xml, 'current-user-principal', root.url);
      let home = extractHref(root.xml, property, root.url);
      if (!home && principal) {
        const result = await request(principal, requested);
        if (result) home = extractHref(result.xml, property, result.url);
      }
      if (home) {
        const result = await request(home, '<d:resourcetype/><d:displayname/>', '1');
        if (!result) throw new DavAccountError('DAV_DISCOVERY_FAILED', 502);
        return parseDavCollectionSnapshot(result.xml, result.url, type);
      }
      // A user may paste the exact calendar/book URL instead of a server root.
      // The strict snapshot parser validates identity, namespace and complete status.
      const props = ownProperties(root.xml, root.url);
      if (props.resourcetype && typeof props.resourcetype === 'object' && Object.hasOwn(props.resourcetype, type)) {
        return parseDavCollectionSnapshot(root.xml, root.url, type);
      }
      // The other service may advertise a separate principal via its well-known endpoint.
    }
    return null;
  };
  try {
    const [calendars, contacts] = await Promise.all([discover('caldav'), discover('carddav')]);
    if (!calendars && !contacts) throw new DavAccountError('DAV_NOT_SUPPORTED');
    return { calendars, contacts };
  } catch (error) {
    if (error instanceof DavAccountError) throw error;
    throw new DavAccountError('DAV_DISCOVERY_FAILED', 502);
  }
}
