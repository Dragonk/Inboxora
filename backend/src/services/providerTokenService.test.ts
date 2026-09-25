import { describe, expect, it, vi } from 'vitest';
import { exchangeGoogleRefreshToken } from './providerTokenService.js';
import { GOOGLE_TOKEN_ENDPOINT, ProviderAuthError } from './providerAuthService.js';

const CONFIG = {
  clientId: 'client-123.apps.googleusercontent.com',
  clientSecret: 'secret-value',
  redirectUri: 'https://inboxora.example/oauth/google/callback',
};

const jsonResponse = (ok: boolean, body: unknown, status = ok ? 200 : 400): Response =>
  ({ ok, status, json: async () => body }) as Response;

describe('exchangeGoogleRefreshToken', () => {
  it('posts a refresh_token grant and maps the response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(true, {
      access_token: 'access-2', expires_in: 3600, scope: 'openid email',
    }));
    const tokens = await exchangeGoogleRefreshToken({ refreshToken: 'rt-1', config: CONFIG, fetchImpl: fetchMock });
    expect(tokens.accessToken).toBe('access-2');
    expect(tokens.refreshToken).toBeNull();
    expect(tokens.scopes).toEqual(['openid', 'email']);
    expect(tokens.expiresAt.getTime()).toBeGreaterThan(Date.now() + 3_000_000);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(GOOGLE_TOKEN_ENDPOINT);
    const body = new URLSearchParams(String(init.body));
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('rt-1');
    expect(body.get('client_id')).toBe(CONFIG.clientId);
    expect(body.get('client_secret')).toBe(CONFIG.clientSecret);
  });

  it('carries a rotated refresh token through when the provider returns one', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(true, { access_token: 'a', refresh_token: 'rt-2', expires_in: 60 }));
    const tokens = await exchangeGoogleRefreshToken({ refreshToken: 'rt-1', config: CONFIG, fetchImpl: fetchMock });
    expect(tokens.refreshToken).toBe('rt-2');
  });

  it('maps a revoked grant to invalid_grant so the caller can stop refreshing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(false, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }));
    await expect(exchangeGoogleRefreshToken({ refreshToken: 'rt-1', config: CONFIG, fetchImpl: fetchMock }))
      .rejects.toMatchObject({ name: 'ProviderAuthError', code: 'invalid_grant' });
  });

  it('rejects a response without an access token and an unreachable endpoint', async () => {
    const noToken = vi.fn().mockResolvedValue(jsonResponse(true, { expires_in: 60 }));
    await expect(exchangeGoogleRefreshToken({ refreshToken: 'rt', config: CONFIG, fetchImpl: noToken }))
      .rejects.toBeInstanceOf(ProviderAuthError);

    const unreachable = vi.fn().mockRejectedValue(new Error('timeout'));
    await expect(exchangeGoogleRefreshToken({ refreshToken: 'rt', config: CONFIG, fetchImpl: unreachable }))
      .rejects.toMatchObject({ code: 'TOKEN_ENDPOINT_UNAVAILABLE' });
  });
});
