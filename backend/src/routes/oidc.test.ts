import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn(), pool: {} }));
vi.mock('../services/encryption.js', () => ({ decrypt: (value: string) => value, isEncrypted: () => false }));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock('../services/authEvents.js', () => ({ logAuthEvent: vi.fn() }));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn(async () => null) }));

import { getDiscovery } from './oidc.js';

let fetchMock: ReturnType<typeof vi.fn>;

describe('getDiscovery', () => {
  beforeAll(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('throws an error when OIDC discovery returns an invalid URL format', async () => {
    const issuer = 'https://example.com';
    const discoveryDoc = {
      issuer,
      authorization_endpoint: 'not-a-valid-url-format', // invalid URL
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
    };

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => discoveryDoc,
    });

    await expect(getDiscovery(issuer, false)).rejects.toThrow(
      'OIDC discovery returned invalid URL for authorization_endpoint: not-a-valid-url-format'
    );
  });
});
