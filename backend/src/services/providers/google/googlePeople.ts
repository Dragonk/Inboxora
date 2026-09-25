import { googleApiFetch, googleApiJson, googleApiVoid, googleUrl } from './googleApiClient.js';
import type { GoogleApiOptions } from './googleApiClient.js';
import type { VCardContact } from '../../../utils/vcard.js';

/**
 * Google People API read adapter (P09, contacts).
 *
 * Personal contacts only: the source is `people/me` connections, not the
 * organization directory and not "Other contacts". The resource name is the
 * identity the sync layer links to; a person's e-mail address is never used as a
 * key, because two contacts can share one and a contact may have none.
 */

export const PEOPLE_API_BASE = 'https://people.googleapis.com/v1';
export const PERSON_FIELDS = [
  'names', 'nicknames', 'emailAddresses', 'phoneNumbers', 'organizations',
  'biographies', 'urls', 'addresses', 'birthdays', 'metadata',
  // Anniversaries and instant-message handles have columns in the contacts table and are mapped
  // below; asking for them costs nothing extra in the same request.
  'events', 'imClients',
].join(',');
const MAX_PAGE_SIZE = 1000;

export interface GooglePersonDate {
  year?: number;
  month?: number;
  day?: number;
}

/** One `names` entry. `unstructuredName` is the form a contact with only a display name is written as. */
export interface GooglePersonName {
  displayName?: string | null;
  givenName?: string | null;
  familyName?: string | null;
  unstructuredName?: string | null;
  metadata?: { primary?: boolean | null } | null;
}

export interface GooglePerson {
  resourceName: string;
  etag?: string | null;
  metadata?: {
    deleted?: boolean | null;
    sources?: Array<{ type?: string | null; id?: string | null; etag?: string | null }> | null;
  } | null;
  names?: GooglePersonName[] | null;
  nicknames?: Array<{ value?: string | null }> | null;
  emailAddresses?: Array<{ value?: string | null; type?: string | null; metadata?: { primary?: boolean | null } | null }> | null;
  phoneNumbers?: Array<{ value?: string | null; type?: string | null; metadata?: { primary?: boolean | null } | null }> | null;
  organizations?: Array<{ name?: string | null; title?: string | null; department?: string | null }> | null;
  biographies?: Array<{ value?: string | null }> | null;
  urls?: Array<{ value?: string | null; type?: string | null }> | null;
  addresses?: Array<{
    type?: string | null; streetAddress?: string | null; extendedAddress?: string | null;
    poBox?: string | null; locality?: string | null; region?: string | null;
    postalCode?: string | null; country?: string | null;
  }> | null;
  birthdays?: Array<{ date?: GooglePersonDate | null; text?: string | null }> | null;
  events?: Array<{ type?: string; date?: { year?: number; month?: number; day?: number } }>;
  imClients?: Array<{ username?: string; protocol?: string }>;
}

export interface ConnectionsPage {
  people: GooglePerson[];
  nextPageToken: string | null;
  nextSyncToken: string | null;
}

function primaryFirst<T extends { metadata?: { primary?: boolean | null } | null }>(items: T[] | null | undefined): T[] {
  const list = Array.isArray(items) ? [...items] : [];
  return list.sort((left, right) => Number(Boolean(right.metadata?.primary)) - Number(Boolean(left.metadata?.primary)));
}

/** Google date → the partial-date form the vCard layer understands. */
export function formatGoogleBirthday(date: GooglePersonDate | null | undefined): string | null {
  if (!date || !date.month || !date.day) return null;
  const month = String(date.month).padStart(2, '0');
  const day = String(date.day).padStart(2, '0');
  if (!date.year) return `--${month}-${day}`;
  return `${String(date.year).padStart(4, '0')}-${month}-${day}`;
}

function typeOf(value: string | null | undefined): string {
  const normalized = (value || 'other').toLowerCase().replace(/[^a-z]/g, '');
  return normalized || 'other';
}

/**
 * Map one People connection to the vCard shape. `uid` is assigned by the caller
 * so the local contact keeps a stable identity derived from the resource name.
 */
export function personToVCardContact(person: GooglePerson, uid: string): VCardContact {
  const names = primaryFirst(person.names);
  const primaryName = names[0];
  const emails = primaryFirst(person.emailAddresses).map(entry => ({
    value: entry.value ?? '',
    type: typeOf(entry.type),
    primary: Boolean(entry.metadata?.primary),
  })).filter(entry => entry.value);
  const phones = primaryFirst(person.phoneNumbers).map(entry => ({
    value: entry.value ?? '',
    type: typeOf(entry.type),
    primary: Boolean(entry.metadata?.primary),
  })).filter(entry => entry.value);
  const organization = person.organizations?.[0] ?? null;
  const addresses = (person.addresses ?? []).map(address => ({
    type: typeOf(address.type),
    pobox: address.poBox ?? '',
    extended: address.extendedAddress ?? '',
    street: address.streetAddress ?? '',
    locality: address.locality ?? '',
    region: address.region ?? '',
    postalCode: address.postalCode ?? '',
    country: address.country ?? '',
  })).filter(address => Object.entries(address).some(([key, value]) => key !== 'type' && value));

  return {
    uid,
    displayName: primaryName?.displayName ?? (emails[0]?.value ?? null),
    firstName: primaryName?.givenName ?? null,
    lastName: primaryName?.familyName ?? null,
    emails,
    phones,
    organization: organization?.name ?? null,
    title: organization?.title ?? null,
    nickname: person.nicknames?.[0]?.value ?? null,
    notes: person.biographies?.[0]?.value ?? null,
    urls: (person.urls ?? []).map(url => ({ value: url.value ?? '', type: typeOf(url.type) })).filter(url => url.value),
    addresses,
    birthday: formatGoogleBirthday(person.birthdays?.[0]?.date),
    // An anniversary is a dated event of type `anniversary`; People API returns others too.
    anniversary: formatGoogleBirthday((person.events ?? []).find(event => event.type === 'anniversary')?.date),
    instantMessages: (person.imClients ?? [])
      .map(client => ({ value: client.username ?? '', type: typeOf(client.protocol) }))
      .filter(entry => entry.value),
  };
}

/**
 * One page of personal connections. A fresh baseline asks for a sync token on
 * every page of that baseline, as required by the People API contract; an
 * incremental run never asks for a new token. The caller owns this run-level
 * intent and passes it unchanged while only `pageToken` advances.
 */
export async function fetchConnectionsPage(options: GoogleApiOptions, input: {
  pageToken?: string | null;
  syncToken?: string | null;
  pageSize?: number;
  /** Run-level sync-token intent. A full baseline keeps this true on every page. */
  requestSyncToken?: boolean;
} = {}): Promise<ConnectionsPage> {
  const pageSize = Number.isFinite(input.pageSize) && Number(input.pageSize) > 0
    ? Math.min(MAX_PAGE_SIZE, Math.floor(Number(input.pageSize)))
    : MAX_PAGE_SIZE;
  // The default preserves the historic single-request adapter API. Sync callers
  // pass a run-level value explicitly so page two cannot silently change baseline
  // semantics by merely carrying a page token.
  const requestSyncToken = input.requestSyncToken ?? !input.syncToken;
  const url = googleUrl(PEOPLE_API_BASE, '/people/me/connections', {
    personFields: PERSON_FIELDS,
    pageSize,
    pageToken: input.pageToken ?? undefined,
    syncToken: input.syncToken ?? undefined,
    requestSyncToken: requestSyncToken ? true : undefined,
  });
  const body = await googleApiFetch<{
    connections?: GooglePerson[] | null;
    nextPageToken?: string | null;
    nextSyncToken?: string | null;
  }>(options, url);
  return {
    people: Array.isArray(body.connections) ? body.connections : [],
    nextPageToken: body.nextPageToken ?? null,
    nextSyncToken: body.nextSyncToken ?? null,
  };
}

// ── Writes (P09, contacts CRUD) ──────────────────────────────────────────────
//
// A contact is addressed by its **resource name**, the identity the read path already stores in
// `remote_object_links.object_remote_id`; an e-mail address is never a key, because two contacts can
// share one and a contact may have none.

/**
 * The fields a contact write may set.
 *
 * This is deliberately the same set `personToVCardContact` projects back, so a write and the read
 * that follows it agree: a field the read path ignores is not written, because the next sync would
 * drop the local copy of it and the user's change would vanish without an error.
 */
export const PERSON_WRITE_FIELDS = [
  'names', 'nicknames', 'emailAddresses', 'phoneNumbers', 'organizations',
  'biographies', 'urls', 'addresses', 'birthdays', 'events', 'imClients',
] as const;

/** The People body a create/update sends: every member optional, because a write sets what it has. */
export type GooglePersonWrite = Partial<Omit<GooglePerson, 'resourceName'>> & { resourceName?: string };

/**
 * The path segment for one person, or `null` when the stored name is not one this adapter may put in
 * a URL. Validating rather than encoding is what keeps a stored value from turning into a second path
 * segment; the read path only ever stores `people/*`.
 */
export function personResourcePath(resourceName: string): string | null {
  return /^(?:people|otherContacts)\/[A-Za-z0-9_-]+$/.test(resourceName) ? resourceName : null;
}

/** `people.createContact`. Google assigns the resource name and etag the link is recorded from. */
export async function createGooglePerson(options: GoogleApiOptions, person: GooglePersonWrite): Promise<GooglePerson | null> {
  return googleApiJson<GooglePerson>(options, googleUrl(PEOPLE_API_BASE, '/people:createContact', { personFields: PERSON_FIELDS }), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(person),
  });
}

/**
 * `people.updateContact`.
 *
 * `resourcePath` must be a value {@link personResourcePath} accepted. `updateFields` is the mask the
 * payload was built for: a field named in the mask that the body sends as an empty list is cleared,
 * and a field the body omits is left as it was — which is what makes "the local contact is the whole
 * desired state" true without clearing fields the caller never had.
 */
export async function updateGooglePerson(
  options: GoogleApiOptions,
  resourcePath: string,
  person: GooglePersonWrite,
  updateFields: readonly string[],
): Promise<GooglePerson | null> {
  return googleApiJson<GooglePerson>(
    options,
    googleUrl(PEOPLE_API_BASE, `/${resourcePath}:updateContact`, {
      personFields: PERSON_FIELDS,
      updatePersonFields: updateFields.join(','),
    }),
    { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(person) },
  );
}

/** `people.deleteContact`. Google answers `200` with an empty body. */
export async function deleteGooglePerson(options: GoogleApiOptions, resourcePath: string): Promise<void> {
  await googleApiVoid(options, googleUrl(PEOPLE_API_BASE, `/${resourcePath}:deleteContact`, {}), { method: 'DELETE' });
}
