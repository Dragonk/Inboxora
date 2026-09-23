import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleApiError } from './providers/google/googleApiClient.js';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('./db.js', () => ({ query: mocks.query }));

import { describeProviderSyncFailure, providerSyncPreflight } from './providerSyncDiagnostics.js';

beforeEach(() => mocks.query.mockReset());

const input = {
  userId: 'user-1', connectionId: 'connection-1', provider: 'google' as const, feature: 'calendar' as const,
};

describe('provider sync diagnostics', () => {
  it('keeps a Google API-disabled diagnosis distinct from scopes and renders only safe facts', async () => {
    // API-disabled does not inspect the grant: that would misleadingly turn a
    // project configuration error into a consent prompt.
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'account-1' }] });
    const result = await describeProviderSyncFailure({
      ...input,
      operation: 'calendar-discovery',
      caught: new GoogleApiError({
        code: 'PROVIDER_API_DISABLED', status: 403, providerReason: 'SERVICE_DISABLED',
        message: 'Google Calendar API has not been used in project 123',
      }),
    });
    expect(result).toMatchObject({
      code: 'PROVIDER_API_DISABLED', providerStatus: 403, providerReason: 'SERVICE_DISABLED', operation: 'calendar-discovery',
    });
    expect(result).not.toHaveProperty('missingScopes');
    expect(JSON.stringify(result)).not.toContain('Bearer');
  });

  it('supplements an explicit scope error with the matching connection grant', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ current_scopes: ['https://www.googleapis.com/auth/gmail.modify'] }] })
      .mockResolvedValueOnce({ rows: [{ id: 'account-1' }] });
    const result = await describeProviderSyncFailure({
      ...input,
      caught: new GoogleApiError({ code: 'INSUFFICIENT_SCOPES', status: 403, providerReason: 'insufficientPermissions', message: 'denied' }),
    });
    expect(result).toMatchObject({ code: 'INSUFFICIENT_SCOPES', missingScopes: ['calendar.calendarlist.readonly', 'calendar.events'] });
  });

  it('permits a read-only People grant through read preflight but not write preflight', async () => {
    mocks.query.mockResolvedValue({ rows: [{ current_scopes: ['https://www.googleapis.com/auth/contacts.readonly'] }] });
    await expect(providerSyncPreflight({ ...input, feature: 'contacts' })).resolves.toBeNull();
    await expect(providerSyncPreflight({ ...input, feature: 'contacts', capability: 'write' }))
      .resolves.toMatchObject({ code: 'PROVIDER_AUTH_REQUIRED', missingScopes: ['contacts'] });
  });
});
