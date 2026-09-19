import { graphGet, graphUrl } from './graphApiClient.js';
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

export const DEFAULT_CONTACT_FOLDER = 'contacts';
const CONTACT_SELECT = [
  'id', 'displayName', 'givenName', 'surname', 'nickName',
  'emailAddresses', 'businessPhones', 'homePhones', 'mobilePhone',
  'companyName', 'jobTitle', 'department', 'personalNotes', 'birthday', 'anniversary',
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
  anniversary?: string | null;
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
    // Graph's anniversary is the same timestamp shape as its birthday, and an IM address is a bare
    // string with no protocol, so it is typed `other` rather than guessed at.
    anniversary: normalizeGraphBirthday(contact.anniversary),
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

/**
 * One page of a contact folder. A delta page carries deletions as entries with an
 * `@removed` marker and ends with `@odata.deltaLink`, which the caller stores.
 */
export async function fetchContactsPage(options: GraphApiOptions, input: {
  folderId?: string;
  nextLink?: string | null;
  deltaLink?: string | null;
  top?: number;
} = {}): Promise<GraphContactsPage> {
  const top = Number.isFinite(input.top) && Number(input.top) > 0 ? Math.min(999, Math.floor(Number(input.top))) : 200;
  // A caller-provided link is already a complete, absolute Graph URL.
  const url = input.nextLink ?? input.deltaLink ?? graphUrl(
    `/me/contactFolders/${encodeURIComponent(input.folderId ?? DEFAULT_CONTACT_FOLDER)}/contacts/delta`,
    { $select: CONTACT_SELECT, $top: top },
  );
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
