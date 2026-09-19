import { describe, expect, it } from 'vitest';
import { classifyGoogleError, GoogleApiError, googleUrl } from './googleApiClient.js';
import { formatGoogleBirthday, personToVCardContact } from './googlePeople.js';
import type { GooglePerson } from './googlePeople.js';

const headers = (values: Record<string, string> = {}): Headers => new Headers(values);

describe('classifyGoogleError', () => {
  it('maps an unauthorized call to a re-authorize problem, not a rate limit', () => {
    const error = classifyGoogleError(401, { error: { message: 'Invalid Credentials' } }, headers());
    expect(error).toMatchObject({ code: 'PROVIDER_AUTH_REQUIRED', retryable: false });
  });

  it('separates a quota 403 from a missing-scope 403', () => {
    const quota = classifyGoogleError(403, { error: { errors: [{ reason: 'rateLimitExceeded' }] } }, headers({ 'retry-after': '30' }));
    expect(quota).toMatchObject({ code: 'RATE_LIMITED', retryable: true, retryAfterSeconds: 30 });
    const scopes = classifyGoogleError(403, { error: { errors: [{ reason: 'insufficientPermissions' }] } }, headers());
    expect(scopes).toMatchObject({ code: 'INSUFFICIENT_SCOPES', retryable: false });
  });

  it('treats an expired sync cursor as 410, distinct from a missing resource', () => {
    expect(classifyGoogleError(410, {}, headers()).code).toBe('INVALID_SYNC_CURSOR');
    expect(classifyGoogleError(404, {}, headers()).code).toBe('RESOURCE_NOT_FOUND');
  });

  it('marks server errors and 429 as retryable', () => {
    expect(classifyGoogleError(503, {}, headers()).retryable).toBe(true);
    const limited = classifyGoogleError(429, {}, headers({ 'retry-after': '5' }));
    expect(limited).toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: 5 });
  });

  it('is a typed error carrying the provider reason for diagnostics', () => {
    const error = classifyGoogleError(400, { error: { message: 'Bad request', status: 'INVALID_ARGUMENT' } }, headers());
    expect(error).toBeInstanceOf(GoogleApiError);
    expect(error.providerReason).toBe('INVALID_ARGUMENT');
  });
});

describe('googleUrl', () => {
  it('omits undefined, null and empty parameters', () => {
    const url = new URL(googleUrl('https://people.googleapis.com/v1', '/people/me/connections', {
      personFields: 'names', pageSize: 500, pageToken: undefined, syncToken: null, requestSyncToken: true,
    }));
    expect(url.searchParams.get('personFields')).toBe('names');
    expect(url.searchParams.get('pageSize')).toBe('500');
    expect(url.searchParams.get('requestSyncToken')).toBe('true');
    expect(url.searchParams.has('pageToken')).toBe(false);
    expect(url.searchParams.has('syncToken')).toBe(false);
  });
});

describe('formatGoogleBirthday', () => {
  it('keeps a full date and a partial one without inventing a year', () => {
    expect(formatGoogleBirthday({ year: 1990, month: 1, day: 2 })).toBe('1990-01-02');
    expect(formatGoogleBirthday({ month: 9, day: 14 })).toBe('--09-14');
    expect(formatGoogleBirthday({ year: 1990 })).toBeNull();
    expect(formatGoogleBirthday(null)).toBeNull();
  });
});

describe('personToVCardContact', () => {
  const person: GooglePerson = {
    resourceName: 'people/c123456',
    etag: 'etag-1',
    names: [
      { displayName: 'Ada Lovelace', givenName: 'Ada', familyName: 'Lovelace', metadata: { primary: true } },
      { displayName: 'A. Lovelace', givenName: 'A.' },
    ],
    nicknames: [{ value: 'Ada' }],
    emailAddresses: [
      { value: 'secondary@example.test', type: 'home' },
      { value: 'ada@example.test', type: 'work', metadata: { primary: true } },
    ],
    phoneNumbers: [{ value: '+48 600 000 000', type: 'mobile', metadata: { primary: true } }],
    organizations: [{ name: 'Analytical Engines', title: 'Mathematician' }],
    biographies: [{ value: 'First programmer' }],
    urls: [{ value: 'https://example.test/ada', type: 'home' }],
    addresses: [{ type: 'home', streetAddress: 'St James Square', locality: 'London', country: 'UK' }],
    birthdays: [{ date: { year: 1815, month: 12, day: 10 } }],
  };

  it('maps the primary name and keeps the address-book identity separate from the e-mail', () => {
    const contact = personToVCardContact(person, 'google-c123456');
    expect(contact).toMatchObject({
      uid: 'google-c123456',
      displayName: 'Ada Lovelace',
      firstName: 'Ada',
      lastName: 'Lovelace',
      organization: 'Analytical Engines',
      title: 'Mathematician',
      nickname: 'Ada',
      notes: 'First programmer',
      birthday: '1815-12-10',
    });
    // The primary e-mail is listed first, and the address is mapped to the vCard keys.
    expect(contact.emails?.[0]).toMatchObject({ value: 'ada@example.test', type: 'work', primary: true });
    expect(contact.addresses?.[0]).toMatchObject({ type: 'home', street: 'St James Square', locality: 'London', country: 'UK' });
    expect(contact.phones?.[0]).toMatchObject({ value: '+48 600 000 000', type: 'mobile' });
  });

  it('accepts a person without a name, an e-mail or a phone', () => {
    const contact = personToVCardContact({ resourceName: 'people/c9' }, 'google-c9');
    expect(contact.displayName).toBeNull();
    expect(contact.emails).toEqual([]);
    expect(contact.phones).toEqual([]);
    expect(contact.birthday).toBeNull();
  });

  it('drops empty entries instead of writing blank fields', () => {
    const contact = personToVCardContact({
      resourceName: 'people/c10',
      emailAddresses: [{ value: '', type: 'work' }, { value: 'a@b.test' }],
      urls: [{ value: '' }],
      addresses: [{ type: 'home' }],
    }, 'google-c10');
    expect(contact.emails).toEqual([{ value: 'a@b.test', type: 'other', primary: false }]);
    expect(contact.urls).toEqual([]);
    expect(contact.addresses).toEqual([]);
  });
});

describe('personToVCardContact carries the fields with local columns', () => {
  it('maps an anniversary event and an instant-message handle', async () => {
    const { personToVCardContact } = await import('./googlePeople.js');
    const parsed = personToVCardContact({
      resourceName: 'people/c1',
      names: [{ displayName: 'Ada Lovelace', givenName: 'Ada', familyName: 'Lovelace' }],
      emailAddresses: [{ value: 'ada@example.test', type: 'work' }],
      phoneNumbers: [],
      birthdays: [{ date: { year: 1815, month: 12, day: 10 } }],
      events: [
        { type: 'other', date: { year: 2000, month: 1, day: 1 } },
        { type: 'anniversary', date: { year: 1835, month: 7, day: 8 } },
      ],
      imClients: [{ username: 'ada', protocol: 'jabber' }, { protocol: 'skype' }],
    }, 'book-1');
    expect(parsed.birthday).toBe('1815-12-10');
    // The dated `other` event must not be mistaken for the anniversary.
    expect(parsed.anniversary).toBe('1835-07-08');
    // A handle with no username is not a handle.
    expect(parsed.instantMessages).toEqual([{ value: 'ada', type: 'jabber' }]);
  });

  it('leaves both empty when the person has neither', async () => {
    const { personToVCardContact } = await import('./googlePeople.js');
    const parsed = personToVCardContact({ resourceName: 'people/c2', names: [{ displayName: 'Anon' }] }, 'book-1');
    expect(parsed.anniversary).toBeNull();
    expect(parsed.instantMessages).toEqual([]);
  });
});
