import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchLike } from './providerAuthService.js';

const tokens = vi.hoisted(() => ({ google: vi.fn(), microsoft: vi.fn() }));
vi.mock('./providerTokenService.js', () => ({ getGoogleAccessToken: tokens.google, getMicrosoftAccessToken: tokens.microsoft }));
import { googleApiRequest } from './providers/google/googleApiClient.js';
import { graphPost } from './providers/microsoft/graphApiClient.js';

const token = { accessToken: 'test-token', scopes: [], expiresAt: new Date(), generation: 1, refreshed: false };
const config = { clientId: 'test', clientSecret: 'test', redirectUri: 'https://example.test/callback', providerRedirectUri: 'https://example.test/provider-callback', tenantId: 'common' };
const context = { userId: 'user', connectionId: 'connection', config };
const clients = [
  { name: 'Google', token: tokens.google, send: (signal: AbortSignal, fetchImpl: FetchLike) => googleApiRequest({ ...context, signal, fetchImpl }, 'https://www.googleapis.com/calendar/v3/calendars', { method: 'POST', body: '{}' }) },
  { name: 'Graph', token: tokens.microsoft, send: (signal: AbortSignal, fetchImpl: FetchLike) => graphPost({ ...context, signal, fetchImpl }, '/me/calendars', { name: 'Test' }) },
];
beforeEach(() => { tokens.google.mockReset().mockResolvedValue(token); tokens.microsoft.mockReset().mockResolvedValue(token); });
afterEach(() => vi.restoreAllMocks());

for (const client of clients) describe(`${client.name} caller-owned cancellation`, () => {
  it('refuses an already cancelled operation before token lookup or dispatch', async () => {
    const abort = new AbortController(); abort.abort();
    const fetchImpl = vi.fn<FetchLike>();
    await expect(client.send(abort.signal, fetchImpl)).rejects.toMatchObject({ name: 'AbortError' });
    expect(client.token).not.toHaveBeenCalled(); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('does not dispatch when token lookup completes after cancellation', async () => {
    const abort = new AbortController();
    client.token.mockImplementationOnce(async () => { abort.abort(); return token; });
    const fetchImpl = vi.fn<FetchLike>();
    await expect(client.send(abort.signal, fetchImpl)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('passes cancellation through to an in-flight HTTP request', async () => {
    const abort = new AbortController();
    const fetchImpl = vi.fn<FetchLike>(async (_url, init) => {
      const signal = init?.signal;
      expect(signal).toBeDefined();
      expect(signal).not.toBe(abort.signal);
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        abort.abort();
      });
    });
    await expect(client.send(abort.signal, fetchImpl)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('does not refresh or retry a 401 received after cancellation', async () => {
    const abort = new AbortController();
    const fetchImpl = vi.fn<FetchLike>(async () => { abort.abort(); return new Response('{}', { status: 401 }); });
    await expect(client.send(abort.signal, fetchImpl)).rejects.toMatchObject({ name: 'AbortError' });
    expect(client.token).toHaveBeenCalledTimes(1); expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('keeps one timeout across a 401 refresh and refuses a late retry', async () => {
    const timeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    client.token.mockResolvedValueOnce(token).mockImplementationOnce(async () => { timeout.abort(); return token; });
    const fetchImpl = vi.fn<FetchLike>(async () => new Response('{}', { status: 401 }));
    await expect(client.send(new AbortController().signal, fetchImpl)).rejects.toMatchObject({ name: 'AbortError' });
    expect(timeoutSpy).toHaveBeenCalledTimes(1); expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('still performs exactly one controlled retry when not cancelled', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValueOnce(new Response('{}', { status: 401 })).mockResolvedValueOnce(new Response('{"id":"calendar"}'));
    await client.send(new AbortController().signal, fetchImpl);
    expect(client.token).toHaveBeenCalledTimes(2); expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBe(fetchImpl.mock.calls[1]?.[1]?.signal);
  });
});

it('also preserves a Google RequestInit signal independently of options.signal', async () => {
  const request = new AbortController(); request.abort();
  const fetchImpl = vi.fn<FetchLike>();
  await expect(googleApiRequest({ ...context, fetchImpl, signal: new AbortController().signal }, 'https://www.googleapis.com/calendar/v3/calendars', { signal: request.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(tokens.google).not.toHaveBeenCalled(); expect(fetchImpl).not.toHaveBeenCalled();
});
