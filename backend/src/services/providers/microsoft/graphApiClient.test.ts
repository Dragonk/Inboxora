import { afterEach, describe, expect, it, vi } from 'vitest';

const tokenMock = vi.hoisted(() => vi.fn(async () => ({
  accessToken: 'graph-token-1', expiresAt: new Date(Date.now() + 3600_000), generation: 1, refreshed: false, scopes: [],
})));
vi.mock('../../providerTokenService.js', () => ({ getMicrosoftAccessToken: tokenMock }));
vi.mock('../../providerAuthService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../providerAuthService.js')>()),
  microsoftConfigFromEnv: () => ({ clientId: 'client-1', clientSecret: 'secret-1', redirectUri: 'https://x/cb', tenantId: 'common' }),
}));

import { graphGetWithHeaders, mergeGraphPrefer } from './graphApiClient.js';

afterEach(() => tokenMock.mockClear());

describe('mergeGraphPrefer', () => {
  it('keeps immutable ids alongside paging and timezone preferences', () => {
    expect(mergeGraphPrefer('odata.maxpagesize=100, outlook.timezone="UTC"', 'IdType="ImmutableId"'))
      .toBe('odata.maxpagesize=100, outlook.timezone="UTC", IdType="ImmutableId"');
  });

  it('deduplicates preferences case-insensitively without splitting quoted commas', () => {
    expect(mergeGraphPrefer('outlook.timezone="America/New_York, Eastern Time"', 'OUTLOOK.TIMEZONE="America/New_York, Eastern Time"'))
      .toBe('outlook.timezone="America/New_York, Eastern Time"');
  });

  it('rejects conflicting values for the same directive', () => {
    expect(() => mergeGraphPrefer('outlook.timezone="UTC"', 'OUTLOOK.TIMEZONE="Europe/Warsaw"'))
      .toThrow('Conflicting Graph Prefer directive: outlook.timezone');
  });
});

describe('Graph Prefer HTTP transport', () => {
  it('normalizes Prefer casing and preserves merged preferences across the one 401 retry', async () => {
    const calls: Array<{ url: string; prefer: string | null }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), prefer: new Headers(init?.headers).get('prefer') });
      const status = calls.length === 1 ? 401 : 200;
      return { ok: status === 200, status, headers: new Headers(), json: async () => ({ id: 'message-1' }) } as Response;
    }) as unknown as typeof fetch;

    await expect(graphGetWithHeaders(
      { userId: 'user-1', connectionId: 'connection-1', immutableIds: true, fetchImpl },
      'https://graph.microsoft.com/v1.0/me/messages/message-1',
      { pReFeR: 'odata.maxpagesize=100, outlook.timezone="UTC"' },
    )).resolves.toEqual({ id: 'message-1' });

    expect(calls).toHaveLength(2);
    expect(calls.map(call => call.prefer)).toEqual([
      'odata.maxpagesize=100, outlook.timezone="UTC", IdType="ImmutableId"',
      'odata.maxpagesize=100, outlook.timezone="UTC", IdType="ImmutableId"',
    ]);
    expect(tokenMock).toHaveBeenCalledTimes(2);
  });
});
