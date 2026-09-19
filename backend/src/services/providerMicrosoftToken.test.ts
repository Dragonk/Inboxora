import { describe, expect, it, vi } from 'vitest';
import { ProviderAuthError, isMicrosoftConfigured, microsoftConfigFromEnv, microsoftTokenEndpoint } from './providerAuthService.js';
import { exchangeMicrosoftRefreshToken } from './providerTokenService.js';

const CONFIG = {
  clientId: '11111111-2222-3333-4444-555555555555',
  clientSecret: 'ms-secret',
  redirectUri: 'https://inboxora.example/oauth/microsoft/callback',
  tenantId: 'consumers',
};

const json = (body: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

describe('microsoftTokenEndpoint', () => {
  it('uses the configured tenant and falls back to common', () => {
    expect(microsoftTokenEndpoint('consumers')).toBe('https://login.microsoftonline.com/consumers/oauth2/v2.0/token');
    expect(microsoftTokenEndpoint(undefined)).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token');
    expect(microsoftTokenEndpoint('  ')).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token');
  });

  it('refuses a tenant value that could retarget the request', () => {
    // A slash, a host or a query in the value must never reach the URL path.
    expect(microsoftTokenEndpoint('evil.example.com/x')).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token');
    expect(microsoftTokenEndpoint('consumers?x=1')).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token');
  });
});

describe('microsoftConfigFromEnv / isMicrosoftConfigured', () => {
  it('reads the MS_* variables and defaults the tenant', () => {
    expect(microsoftConfigFromEnv({ MS_CLIENT_ID: 'abc' } as NodeJS.ProcessEnv)).toEqual({
      clientId: 'abc', clientSecret: '', redirectUri: '', tenantId: 'common',
    });
    expect(microsoftConfigFromEnv({
      MS_CLIENT_ID: 'abc', MS_CLIENT_SECRET: 's', MS_REDIRECT_URI: 'https://x/cb', MS_TENANT_ID: 'contoso.onmicrosoft.com',
    } as NodeJS.ProcessEnv)).toEqual({
      clientId: 'abc', clientSecret: 's', redirectUri: 'https://x/cb', tenantId: 'contoso.onmicrosoft.com',
    });
  });

  it('treats a client id as sufficient, because the device flow is a public client', () => {
    expect(isMicrosoftConfigured({ clientId: 'abc' })).toBe(true);
    expect(isMicrosoftConfigured({ clientId: '' })).toBe(false);
    expect(isMicrosoftConfigured({})).toBe(false);
  });
});

describe('exchangeMicrosoftRefreshToken', () => {
  it('posts a form-encoded refresh and forwards the consented scopes', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({
      access_token: 'ms-access', refresh_token: 'ms-rotated', expires_in: 1800,
      scope: 'https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Calendars.ReadWrite',
    }));

    const tokens = await exchangeMicrosoftRefreshToken({
      refreshToken: 'ms-rt', scopes: ['https://graph.microsoft.com/Mail.ReadWrite'], config: CONFIG, fetchImpl,
    });
    expect(tokens.accessToken).toBe('ms-access');
    expect(tokens.refreshToken).toBe('ms-rotated');
    expect(tokens.scopes).toEqual([
      'https://graph.microsoft.com/Mail.ReadWrite', 'https://graph.microsoft.com/Calendars.ReadWrite',
    ]);
    expect(tokens.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const [url, init] = fetchImpl.mock.calls[0] as [string, { method: string; body: string; headers: Record<string, string> }];
    expect(url).toContain('/consumers/oauth2/v2.0/token');
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(init.body).toContain('client_id=11111111-2222-3333-4444-555555555555');
    expect(init.body).toContain('grant_type=refresh_token');
    expect(init.body).toContain('refresh_token=ms-rt');
  });

  it('sends no client secret for a public client', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ access_token: 'ms-access', expires_in: 3600 }));
    await exchangeMicrosoftRefreshToken({
      refreshToken: 'ms-rt', config: { ...CONFIG, clientSecret: '' }, fetchImpl,
    });
    const [, init] = fetchImpl.mock.calls[0] as [string, { body: string }];
    expect(init.body).not.toContain('client_secret');
    // No scope requested keeps the original consent; nothing empty is sent.
    expect(init.body).not.toContain('scope=');
  });

  it('keeps the stored refresh token when the provider omits a new one', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ access_token: 'ms-access', expires_in: 3600 }));
    const tokens = await exchangeMicrosoftRefreshToken({ refreshToken: 'ms-rt', config: CONFIG, fetchImpl });
    expect(tokens.refreshToken).toBeNull();
  });

  it('maps a provider error to its own code so the caller can park the grant', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({
      error: 'invalid_grant', error_description: 'AADSTS700082: The refresh token has expired.',
    }, 400));
    await expect(exchangeMicrosoftRefreshToken({ refreshToken: 'dead', config: CONFIG, fetchImpl }))
      .rejects.toMatchObject({ code: 'invalid_grant' });
  });

  it('refuses a success response without an access token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ expires_in: 3600 }));
    await expect(exchangeMicrosoftRefreshToken({ refreshToken: 'ms-rt', config: CONFIG, fetchImpl }))
      .rejects.toBeInstanceOf(ProviderAuthError);
  });

  it('reports an unreachable endpoint rather than leaking the network error as a crash', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('socket hang up'));
    await expect(exchangeMicrosoftRefreshToken({ refreshToken: 'ms-rt', config: CONFIG, fetchImpl }))
      .rejects.toMatchObject({ code: 'TOKEN_ENDPOINT_UNAVAILABLE' });
  });
});
