import { describe, it, expect, vi, beforeEach } from 'vitest';

// The API client resolves its own token; the store is mocked as the other Graph adapter suites do.
const tokenMock = vi.hoisted(() => vi.fn(async () => ({
  accessToken: 'graph-token-1', expiresAt: new Date(Date.now() + 3600_000), generation: 1, refreshed: false, scopes: [],
})));
vi.mock('../../providerTokenService.js', () => ({ getMicrosoftAccessToken: tokenMock }));

import { GraphApiError } from './graphApiClient.js';
import { sendGraphMime } from './graphMailSend.js';

// The adapter is thin on purpose — the auth, the 401 refresh and the timeout are the API client's —
// so these cases are about the two things it decides: the payload shape Graph expects, and that a
// refusal is thrown rather than swallowed. A send that the provider rejected must never look sent.
const api = { userId: 'u1', connectionId: 'c1', config: { clientId: 'x' }, fetchImpl: vi.fn() } as never;

beforeEach(() => vi.mocked((api as { fetchImpl: ReturnType<typeof vi.fn> }).fetchImpl).mockReset());

describe('sendGraphMime', () => {
  it('posts the base64 MIME with the MIME content type', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }));
    await sendGraphMime({ ...(api as object), fetchImpl } as never, Buffer.from('Subject: Hi\r\n\r\nBody\r\n'));

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/me/sendMail');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe('text/plain');
    expect(init.body).toBe(Buffer.from('Subject: Hi\r\n\r\nBody\r\n').toString('base64'));
  });

  it('throws the classified provider error instead of reporting success', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'ErrorAccessDenied', message: 'no' } }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    ));
    await expect(sendGraphMime({ ...(api as object), fetchImpl } as never, Buffer.from('x'))).rejects.toBeInstanceOf(GraphApiError);
  });
});
