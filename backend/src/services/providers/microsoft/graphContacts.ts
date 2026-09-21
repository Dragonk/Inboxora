import { graphDelete, graphGet, graphPatch, graphPost, graphUrl } from './graphApiClient.js';
import type { GraphApiOptions } from './graphApiClient.js';
import type { VCardContact } from '../../../utils/vcard.js';

/**
 * Microsoft Graph contacts read adapter (P09, contacts).
 *
 * Outlook contacts live in contact folders; the default folder is addressed by its
 * well-known name, so a renamed folder still syncs. The Graph contact id is the
 * identity — an e-mail address is never used as a key, because two contacts can
 * share one and a contact may have none.
 */

// `anniversary` is deliberately absent. The v1.0 `contact` resource has no such property, and the beta resource
// names it `weddingAnniversary` — so requesting it here was wrong in both versions and can fail the whole
// `$select` (GRAPH-03). A local anniversary is therefore not mapped from Graph, which is stated rather than
// guessed: nothing is requested and nothing is sent back.
const CONTACT_SELECT = [
  'id', 'displayName', 'givenName', 'surname', 'nickName',
  'emailAddresses', 'businessPhones', 'homePhones', 'mobilePhone',
  'companyName', 'jobTitle', 'department', 'personalNotes', 'birthday',
  'businessHomePage', 'businessAddress', 'homeAddress', 'otherAddress', 'categories', 'imAddresses',
].join(',');

export interface GraphContactFolder {
  id: string;
  displayName?: string | null;
  parentFolderId?: string | null;
  wellKnownName?: string | null;
}
export interface GraphPhysicalAddress {
  street?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  countryOrRegion?: string | null;
}

export interface GraphContact {
  id: string;
  displayName?: string | null;
  givenName?: string | null;
  surname?: string | null;
  nickName?: string | null;
  emailAddresses?: Array<{ address?: string | null; name?: string | null }> | null;
  businessPhones?: string[] | null;
  homePhones?: string[] | null;
  mobilePhone?: string | null;
  companyName?: string | null;
  jobTitle?: string | null;
  department?: string | null;
  personalNotes?: string | null;
  birthday?: string | null;
  imAddresses?: string[] | null;
  businessHomePage?: string | null;
  businessAddress?: GraphPhysicalAddress | null;
  homeAddress?: GraphPhysicalAddress | null;
  otherAddress?: GraphPhysicalAddress | null;
  categories?: string[] | null;
  /** Present on a delta page for an entry that was deleted. */
  removed?: { reason?: string | null } | null;
}

export interface GraphContactsPage {
  contacts: GraphContact[];
  /** Absolute URL for the next page, as Graph provides it. */
  nextLink: string | null;
  /** Absolute delta URL to store as the cursor. */
  deltaLink: string | null;
}

function addressOf(address: GraphPhysicalAddress | null | undefined, type: string): Record<string, string> | null {
  if (!address) return null;
  const mapped: Record<string, string> = {
    type,
    pobox: '',
    extended: '',
    street: address.street ?? '',
    locality: address.city ?? '',
    region: address.state ?? '',
    postalCode: address.postalCode ?? '',
    country: address.countryOrRegion ?? '',
  };
  return Object.entries(mapped).some(([key, value]) => key !== 'type' && value) ? mapped : null;
}

/** Graph's birthday is an ISO timestamp; the vCard layer wants the date part. */
export function normalizeGraphBirthday(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

/**
 * Map one Graph contact to the vCard shape. `uid` is assigned by the caller so the
 * local contact keeps a stable identity derived from the Graph contact id.
 */
export function graphContactToVCard(contact: GraphContact, uid: string): VCardContact {
  // Graph does not label e-mail addresses; the first one is the primary.
  const emails = (contact.emailAddresses ?? [])
    .map((entry, index) => ({ value: entry.address ?? '', type: 'other', primary: index === 0 }))
    .filter(entry => entry.value);
  const phones = [
    ...(contact.businessPhones ?? []).map(value => ({ value, type: 'work' })),
    ...(contact.homePhones ?? []).map(value => ({ value, type: 'home' })),
    ...(contact.mobilePhone ? [{ value: contact.mobilePhone, type: 'cell' }] : []),
  ].filter(entry => entry.value);
  const addresses = [
    addressOf(contact.businessAddress, 'work'),
    addressOf(contact.homeAddress, 'home'),
    addressOf(contact.otherAddress, 'other'),
  ].filter((address): address is Record<string, string> => address !== null);

  return {
    uid,
    displayName: contact.displayName ?? emails[0]?.value ?? null,
    firstName: contact.givenName ?? null,
    lastName: contact.surname ?? null,
    emails,
    phones,
    organization: contact.companyName ?? null,
    title: contact.jobTitle ?? null,
    role: contact.department ?? null,
    nickname: contact.nickName ?? null,
    notes: contact.personalNotes ?? null,
    urls: contact.businessHomePage ? [{ value: contact.businessHomePage, type: 'work' }] : [],
    addresses,
    categories: (contact.categories ?? []).filter(Boolean),
    birthday: normalizeGraphBirthday(contact.birthday),
    // Graph v1.0 exposes no anniversary property (beta names a different one), so there is nothing to map. The
    // local column keeps whatever the user or another source put there; it is not cleared by a provider sync.
    anniversary: null,
    // An IM address is a bare string with no protocol, so it is typed `other` rather than guessed at.
    instantMessages: (contact.imAddresses ?? []).filter(Boolean).map(value => ({ value, type: 'other' })),
  };
}

/** Stable local identity derived from the Graph contact id, never the e-mail. */
export function contactUidForGraphContact(id: string): string {
  return `msgraph-${id}`;
}

interface GraphCollection<T> {
  value?: T[] | null;
  '@odata.nextLink'?: string | null;
  '@odata.deltaLink'?: string | null;
}

/** One contact folder of the mailbox. */
export interface GraphContactFolder {
  id: string;
  displayName?: string | null;
  /** Null for a top-level folder; the default "Contacts" folder is one of those. */
  parentFolderId?: string | null;
}

/**
 * The mailbox's contact folders.
 *
 * `contactFolder` has **no well-known-name property** — unlike `mailFolder`, whose `wellKnownName` this codebase
 * already had to stop selecting (GRAPH-01). Addressing the default folder as `/me/contactFolders/contacts/...`
 * therefore asked Graph for a folder whose id is the literal string "contacts", which is not what the default
 * folder's id is, so the request could not be answered (GRAPH-03). The real ids are discovered here instead.
 */
export async function discoverGraphContactFolders(options: GraphApiOptions): Promise<GraphContactFolder[]> {
  const folders: GraphContactFolder[] = [];
  let url: string | null = graphUrl('/me/contactFolders', { $select: 'id,displayName,parentFolderId', $top: 100 });
  for (let page = 0; page < 20 && url; page += 1) {
    const body: GraphCollection<GraphContactFolder> = await graphGet<GraphCollection<GraphContactFolder>>(options, url);
    for (const folder of body.value ?? []) {
      if (folder?.id) folders.push(folder);
    }
    url = body['@odata.nextLink'] ?? null;
  }
  return folders;
}

/**
 * The folder a mailbox's default contacts live in: a top-level folder, preferring the one Outlook names
 * "Contacts". Returns null when discovery gave no usable top-level folder — the caller must then fail rather
 * than guess an id, which is what produced the unusable literal before.
 */
export function defaultGraphContactFolder(folders: readonly GraphContactFolder[]): GraphContactFolder | null {
  const topLevel = folders.filter(folder => !folder.parentFolderId);
  return topLevel.find(folder => (folder.displayName ?? '').trim().toLowerCase() === 'contacts')
    ?? topLevel.find(folder => (folder.displayName ?? '').trim().toLowerCase().startsWith('contact'))
    ?? topLevel[0]
    ?? null;
}

/**
 * One page of a contact folder. A delta page carries deletions as entries with an
 * `@removed` marker and ends with `@odata.deltaLink`, which the caller stores.
 */
export async function fetchContactsPage(options: GraphApiOptions, input: {
  /** The provider's own contact-folder id. Required unless a complete `nextLink`/`deltaLink` is supplied. */
  folderId?: string;
  nextLink?: string | null;
  deltaLink?: string | null;
  top?: number;
} = {}): Promise<GraphContactsPage> {
  const top = Number.isFinite(input.top) && Number(input.top) > 0 ? Math.min(999, Math.floor(Number(input.top))) : 200;
  const folderId = (input.folderId ?? '').trim();
  // A caller-provided link is already a complete, absolute Graph URL.
  const url = input.nextLink ?? input.deltaLink
    ?? (folderId
      ? graphUrl(`/me/contactFolders/${encodeURIComponent(folderId)}/contacts/delta`, { $select: CONTACT_SELECT, $top: top })
      // `contactFolder` has no well-known-name property, so there is no id to default to: the literal `contacts`
      // this used to send addressed a folder Graph cannot resolve (GRAPH-03).
      : (() => { throw new Error('A Microsoft contact folder id is required to read a contact delta'); })());
  const body = await graphGet<GraphCollection<GraphContact & { '@removed'?: { reason?: string } }>>(options, url);
  return {
    contacts: (Array.isArray(body.value) ? body.value : []).map(entry => {
      const removed = (entry as { '@removed'?: { reason?: string } })['@removed'];
      return removed ? { ...entry, removed } : entry;
    }),
    nextLink: body['@odata.nextLink'] ?? null,
    deltaLink: body['@odata.deltaLink'] ?? null,
  };
}

/**
 * The Graph contact fields a write sends.
 *
 * Only fields the local model can express are sent, and a **PATCH** sends only the ones the caller
 * supplied: Graph treats an omitted property as "leave it alone" and an explicit `null` as "clear it",
 * so a partial update must not be built by sending empty strings for everything else — that would erase
 * the contact's other details.
 */
export interface GraphContactPayload {
  displayName?: string;
  givenName?: string;
  surname?: string;
  nickName?: string;
  emailAddresses?: Array<{ address: string; name?: string }>;
  businessPhones?: string[];
  homePhones?: string[];
  mobilePhone?: string;
  companyName?: string;
  jobTitle?: string;
  department?: string;
  personalNotes?: string;
  businessHomePage?: string;
  businessAddress?: GraphPhysicalAddress;
  homeAddress?: GraphPhysicalAddress;
  otherAddress?: GraphPhysicalAddress;
  categories?: string[];
  imAddresses?: string[];
  birthday?: string;
}

/** The vCard address columns Graph uses, so a round trip through the sync is lossless. */
function graphAddressOf(address: { type?: string; [key: string]: string | undefined } | undefined): GraphPhysicalAddress | null {
  if (!address) return null;
  const mapped: GraphPhysicalAddress = {
    street: address.street ?? '',
    city: address.locality ?? '',
    state: address.region ?? '',
    postalCode: address.postalCode ?? '',
    countryOrRegion: address.country ?? '',
  };
  return Object.values(mapped).some(value => value) ? mapped : null;
}

/** Graph's birthday is a date-time; the local model stores a date. */
function graphDate(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[1]}-${match[2]}-${match[3]}T00:00:00Z` : undefined;
}

/**
 * Map a local contact onto Graph's contact shape.
 *
 * `full` distinguishes a **create** from a **patch**: a create states every field (a new contact has no
 * other details to preserve, and an explicit empty value is what makes the local copy authoritative),
 * while a patch sends only what the caller provided so untouched fields keep their provider value.
 */
export function vCardToGraphContact(contact: VCardContact, options: { full: boolean }): GraphContactPayload {
  const payload: GraphContactPayload = {};
  const emails = (contact.emails ?? []).filter(entry => entry.value?.trim());
  const phones = (contact.phones ?? []).filter(entry => entry.value?.trim());

  if (options.full || contact.displayName !== undefined) payload.displayName = contact.displayName ?? '';
  if (options.full || contact.firstName !== undefined) payload.givenName = contact.firstName ?? '';
  if (options.full || contact.lastName !== undefined) payload.surname = contact.lastName ?? '';
  if (options.full || contact.nickname !== undefined) payload.nickName = contact.nickname ?? '';
  if (options.full || contact.emails !== undefined) {
    // The primary address is the one the local model marks (or the first), and Graph keeps the order.
    const ordered = [...emails].sort((a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary)));
    payload.emailAddresses = ordered.map(entry => ({ address: String(entry.value).trim(), name: contact.displayName ?? undefined }));
  }
  if (options.full || contact.phones !== undefined) {
    payload.businessPhones = phones.filter(entry => entry.type === 'work').map(entry => String(entry.value).trim());
    payload.homePhones = phones.filter(entry => entry.type === 'home').map(entry => String(entry.value).trim());
    const mobile = phones.find(entry => entry.type === 'cell' || entry.type === 'mobile');
    payload.mobilePhone = mobile ? String(mobile.value).trim() : '';
  }
  if (options.full || contact.organization !== undefined) payload.companyName = contact.organization ?? '';
  if (options.full || contact.title !== undefined) payload.jobTitle = contact.title ?? '';
  if (options.full || contact.role !== undefined) payload.department = contact.role ?? '';
  if (options.full || contact.notes !== undefined) payload.personalNotes = contact.notes ?? '';
  if (options.full || contact.urls !== undefined) {
    payload.businessHomePage = contact.urls?.find(entry => entry.value)?.value ?? '';
  }
  if (options.full || contact.addresses !== undefined) {
    const byType = (type: string) => graphAddressOf((contact.addresses ?? []).find(address => address.type === type));
    payload.businessAddress = byType('work') ?? undefined;
    payload.homeAddress = byType('home') ?? undefined;
    payload.otherAddress = byType('other') ?? undefined;
  }
  if (options.full || contact.categories !== undefined) payload.categories = contact.categories ?? [];
  if (options.full || contact.instantMessages !== undefined) {
    payload.imAddresses = (contact.instantMessages ?? []).map(entry => entry.value).filter((value): value is string => Boolean(value));
  }
  if (options.full || contact.birthday !== undefined) payload.birthday = graphDate(contact.birthday);
  // No anniversary: Graph v1.0 has no such property, so a local anniversary is deliberately not pushed rather
  // than sent as a field the service rejects or ignores (GRAPH-03).
  return payload;
}

/**
 * The Graph resource path for one contact folder's contacts.
 *
 * The folder id is **required**: `contactFolder` has no well-known-name property, so the literal `contacts` this
 * once defaulted to is not a folder Graph can resolve (GRAPH-03). Callers hold the discovered id — the collection
 * link's `remote_id` — and a missing one is a bug in the caller, not a request to send.
 */
export function graphContactsPath(folderId: string | null | undefined): string {
  const id = typeof folderId === 'string' ? folderId.trim() : '';
  if (!id) throw new Error('A Microsoft contact folder id is required to address a contact');
  return `/me/contactFolders/${encodeURIComponent(id)}/contacts`;
}

export async function createGraphContact(api: GraphApiOptions, folderId: string | null | undefined, payload: GraphContactPayload): Promise<GraphContact | null> {
  return graphPost<GraphContact>(api, graphContactsPath(folderId), payload);
}

/**
 * Patch one contact. Graph addresses a contact by its own id rather than by its folder, so the id is the
 * only identity a write needs; the folder is kept on the local link for the read path.
 */
export async function patchGraphContact(api: GraphApiOptions, contactId: string, payload: GraphContactPayload): Promise<GraphContact | null> {
  return graphPatch<GraphContact>(api, `/me/contacts/${encodeURIComponent(contactId)}`, payload);
}

export async function deleteGraphContact(api: GraphApiOptions, contactId: string): Promise<void> {
  await graphDelete(api, `/me/contacts/${encodeURIComponent(contactId)}`);
}
