import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ create: vi.fn(), patch: vi.fn(), remove: vi.fn() }));

vi.mock('./graphContacts.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./graphContacts.js')>()),
  createGraphContact: mocks.create,
  patchGraphContact: mocks.patch,
  deleteGraphContact: mocks.remove,
}));

import { GraphApiError } from './graphApiClient.js';
import { graphContactMutationAdapter } from './graphContactWrites.js';
import { vCardToGraphContact } from './graphContacts.js';

const api = { userId: 'user-1', connectionId: 'connection-1' };
const adapter = () => graphContactMutationAdapter({ api });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockResolvedValue({ id: 'AAMkAD-1' });
  mocks.patch.mockResolvedValue({ id: 'AAMkAD-1' });
  mocks.remove.mockResolvedValue(undefined);
});

describe('mapping a local contact onto Graph', () => {
  it('states every modelled field on a create', () => {
    const payload = vCardToGraphContact({
      displayName: 'Ada',
      firstName: 'Ada',
      lastName: 'Lovelace',
      emails: [{ value: 'second@example.test' }, { value: 'ada@example.test', primary: true }],
      phones: [{ value: '+1', type: 'work' }, { value: '+2', type: 'home' }, { value: '+3', type: 'cell' }],
      organization: 'Analytical',
      title: 'Engineer',
      role: 'R&D',
      notes: 'note',
      urls: [{ value: 'https://example.test' }],
      addresses: [{ type: 'work', street: '1 Main', locality: 'London', region: 'ENG', postalCode: 'N1', country: 'UK' }],
      categories: ['friends'],
      instantMessages: [{ value: 'ada-im' }],
      birthday: '1815-12-10',
    }, { full: true });

    expect(payload).toMatchObject({
      displayName: 'Ada', givenName: 'Ada', surname: 'Lovelace',
      companyName: 'Analytical', jobTitle: 'Engineer', department: 'R&D', personalNotes: 'note',
      businessHomePage: 'https://example.test', categories: ['friends'], imAddresses: ['ada-im'],
      birthday: '1815-12-10T00:00:00Z',
      businessPhones: ['+1'], homePhones: ['+2'], mobilePhone: '+3',
      businessAddress: { street: '1 Main', city: 'London', state: 'ENG', postalCode: 'N1', countryOrRegion: 'UK' },
    });
    // The locally marked primary address leads, so Graph keeps the same default.
    expect(payload.emailAddresses?.map(entry => entry.address)).toEqual(['ada@example.test', 'second@example.test']);
  });

  it('sends only the fields a patch supplied, so other provider fields survive', () => {
    const payload = vCardToGraphContact({ displayName: 'Ada' }, { full: false });
    expect(Object.keys(payload)).toEqual(['displayName']);
  });

  it('omits an unusable date instead of writing a wrong one', () => {
    expect(vCardToGraphContact({ birthday: 'not-a-date' }, { full: true }).birthday).toBeUndefined();
  });
});

describe('a Graph contact write reports what actually happened', () => {
  it('reports a create that returned an identity as committed', async () => {
    await expect(adapter().perform({ operation: 'create', folderId: 'contacts' }, { operationId: 'op', signal: new AbortController().signal }))
      .resolves.toEqual({ status: 'committed', value: { contact: { id: 'AAMkAD-1' } } });
  });

  it('refuses to call a create without an identity committed', async () => {
    mocks.create.mockResolvedValueOnce({});
    await expect(adapter().perform({ operation: 'create', folderId: 'contacts' }, { operationId: 'op', signal: new AbortController().signal }))
      .resolves.toEqual({ status: 'outcome_unknown', code: 'CONTACT_ID_MISSING' });
  });

  it('classifies a throttle as retryable with the provider’s own delay', async () => {
    mocks.patch.mockRejectedValueOnce(new GraphApiError({ code: 'RATE_LIMITED', message: 'slow', status: 429, retryable: true, retryAfterSeconds: 12 }));
    await expect(adapter().perform({ operation: 'update', contactId: 'AAMkAD-1', payload: { displayName: 'x' } }, { operationId: 'op', signal: new AbortController().signal }))
      .resolves.toEqual({ status: 'retryable', code: 'RATE_LIMITED', retryAfterSeconds: 12 });
  });

  it('treats a contact the provider no longer has as permanent, not retryable', async () => {
    mocks.patch.mockRejectedValueOnce(new GraphApiError({ code: 'RESOURCE_NOT_FOUND', message: 'gone', status: 404 }));
    await expect(adapter().perform({ operation: 'update', contactId: 'AAMkAD-1' }, { operationId: 'op', signal: new AbortController().signal }))
      .resolves.toEqual({ status: 'permanent', code: 'RESOURCE_NOT_FOUND' });
  });

  it('never reports an ambiguous network failure as a refusal', async () => {
    mocks.remove.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(adapter().perform({ operation: 'delete', contactId: 'AAMkAD-1' }, { operationId: 'op', signal: new AbortController().signal }))
      .resolves.toEqual({ status: 'outcome_unknown', code: 'MUTATION_OUTCOME_UNKNOWN' });
  });

  it('is declared non-idempotent, because a re-run create would duplicate the contact', () => {
    expect(adapter().idempotent).toBe(false);
    expect(adapter().resourceType).toBe('contact');
  });
});
