import { describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import {
  GOOGLE_GRANT_AUDIENCE,
  GOOGLE_ISSUER,
  GOOGLE_TOKEN_ENDPOINT,
  GOOGLE_USERINFO_ENDPOINT,
  ProviderAuthError,
  createPkcePair,
  exchangeGoogleAuthorizationCode,
  fetchGoogleIdentity,
  googleAuthorizeUrl,
  googleScopesForPurpose,
  isGoogleConfigured,
  providerConfigRevision,
} from './providerAuthService.js';

const CONFIG = {
  clientId: 'client-123.apps.googleusercontent.com',
  clientSecret: 'secret-value',
  redirectUri: 'https://inboxora.example/oauth/google/callback',
};

const jsonResponse = (ok: boolean, body: unknown, status = ok ? 200 : 400): Response =>
  ({ ok, status, json: async () => body }) as Response;

describe('googleScopesForPurpose', () => {
  it('asks for mail and identity only for a new account', () => {
    const scopes = googleScopesForPurpose('new_account');
    expect(scopes).toContain('openid');
    expect(scopes).toContain('email');
    expect(scopes).toContain('profile');
    expect(scopes).toContain('https://www.googleapis.com/auth/gmail.modify');
    // Adding a mailbox must not silently enable calendars/contacts (AU01).
    expect(scopes.some(scope => scope.includes('calendar'))).toBe(false);
    expect(scopes.some(scope => scope.includes('contacts'))).toBe(false);
  });

  it('uses the read-only variant only when read-only access was requested', () => {
    expect(googleScopesForPurpose('calendar_enable', 'source')).toContain('https://www.googleapis.com/auth/calendar.events');
    expect(googleScopesForPurpose('calendar_enable', 'read_only')).toContain('https://www.googleapis.com/auth/calendar.events.readonly');
    expect(googleScopesForPurpose('calendar_enable', 'read_only')).not.toContain('https://www.googleapis.com/auth/calendar.events');
    expect(googleScopesForPurpose('contacts_enable', 'source')).toContain('https://www.googleapis.com/auth/contacts');
    expect(googleScopesForPurpose('contacts_enable', 'read_only')).toContain('https://www.googleapis.com/auth/contacts.readonly');
  });

  it('never requests another feature for a calendar-only purpose', () => {
    const scopes = googleScopesForPurpose('calendar_enable');
    expect(scopes.some(scope => scope.includes('gmail'))).toBe(false);
    expect(scopes.some(scope => scope.includes('contacts'))).toBe(false);
  });
});

describe('PKCE and configuration revision', () => {
  it('derives an S256 challenge from the verifier', () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toBe(crypto.createHash('sha256').update(verifier).digest('base64url'));
    expect(challenge).not.toBe(verifier);
    expect(challenge).not.toMatch(/[+/=]/);
  });

  it('changes the revision when the client or redirect changes, but not on secret rotation', () => {
    const base = providerConfigRevision(CONFIG);
    expect(providerConfigRevision({ ...CONFIG })).toBe(base);
    expect(providerConfigRevision({ ...CONFIG, clientId: 'other-client' })).not.toBe(base);
    expect(providerConfigRevision({ ...CONFIG, redirectUri: 'https://other/cb' })).not.toBe(base);
    // Rotating the secret at the same client must not invalidate a pending flow.
    expect(providerConfigRevision({ ...CONFIG, clientSecret: 'rotated' })).toBe(base);
  });

  it('treats a partial configuration as not configured', () => {
    expect(isGoogleConfigured(CONFIG)).toBe(true);
    expect(isGoogleConfigured({ ...CONFIG, clientSecret: '' })).toBe(false);
    expect(isGoogleConfigured({ ...CONFIG, redirectUri: '' })).toBe(false);
    expect(isGoogleConfigured({ clientId: 'x' })).toBe(false);
  });
});

describe('googleAuthorizeUrl', () => {
  it('carries the PKCE challenge, offline access and no client secret', () => {
    const url = new URL(googleAuthorizeUrl({
      config: CONFIG, scopes: ['openid', 'email'], state: 'state-1', codeChallenge: 'challenge-1', nonce: 'nonce-1',
    }));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe(CONFIG.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe(CONFIG.redirectUri);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('openid email');
    expect(url.searchParams.get('state')).toBe('state-1');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-1');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('include_granted_scopes')).toBe('true');
    expect(url.searchParams.get('nonce')).toBe('nonce-1');
    expect(url.search).not.toContain('secret-value');
  });
});

describe('exchangeGoogleAuthorizationCode', () => {
  it('maps a successful response and keeps a missing refresh token absent', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(true, {
      access_token: 'at', expires_in: 3600, scope: 'openid email', id_token: 'idt',
    }));
    const tokens = await exchangeGoogleAuthorizationCode({ code: 'c', codeVerifier: 'v', config: CONFIG, fetchImpl: fetchMock });
    expect(tokens.accessToken).toBe('at');
    expect(tokens.refreshToken).toBeNull();
    expect(tokens.scopes).toEqual(['openid', 'email']);
    expect(tokens.expiresAt.getTime()).toBeGreaterThan(Date.now() + 3_000_000);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(GOOGLE_TOKEN_ENDPOINT);
    const body = new URLSearchParams(String(init.body));
    expect(body.get('code_verifier')).toBe('v');
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('redirect_uri')).toBe(CONFIG.redirectUri);
    expect(body.get('client_secret')).toBe(CONFIG.clientSecret);
  });

  it('preserves an issued refresh token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(true, { access_token: 'at', refresh_token: 'rt', expires_in: 60 }));
    const tokens = await exchangeGoogleAuthorizationCode({ code: 'c', codeVerifier: 'v', config: CONFIG, fetchImpl: fetchMock });
    expect(tokens.refreshToken).toBe('rt');
  });

  it('maps a provider error to a typed, non-retryable signal', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(false, { error: 'invalid_grant', error_description: 'expired' }));
    await expect(exchangeGoogleAuthorizationCode({ code: 'c', codeVerifier: 'v', config: CONFIG, fetchImpl: fetchMock }))
      .rejects.toMatchObject({ name: 'ProviderAuthError', code: 'invalid_grant' });
  });

  it('rejects a response without an access token and an unreachable endpoint', async () => {
    const noToken = vi.fn().mockResolvedValue(jsonResponse(true, { expires_in: 60 }));
    await expect(exchangeGoogleAuthorizationCode({ code: 'c', codeVerifier: 'v', config: CONFIG, fetchImpl: noToken }))
      .rejects.toBeInstanceOf(ProviderAuthError);

    const unreachable = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(exchangeGoogleAuthorizationCode({ code: 'c', codeVerifier: 'v', config: CONFIG, fetchImpl: unreachable }))
      .rejects.toMatchObject({ code: 'TOKEN_ENDPOINT_UNAVAILABLE' });
  });
});

describe('fetchGoogleIdentity', () => {
  it('reads the subject from userinfo, never from the e-mail address', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(true, { sub: 'google-sub-1', email: 'user@example.test', email_verified: true }));
    const identity = await fetchGoogleIdentity({ accessToken: 'at', fetchImpl: fetchMock });
    expect(identity).toEqual({ subject: 'google-sub-1', email: 'user@example.test', emailVerified: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(GOOGLE_USERINFO_ENDPOINT);
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer at');
  });

  it('fails closed when the subject is missing or the call fails', async () => {
    const noSub = vi.fn().mockResolvedValue(jsonResponse(true, { email: 'user@example.test' }));
    await expect(fetchGoogleIdentity({ accessToken: 'at', fetchImpl: noSub })).rejects.toMatchObject({ code: 'IDENTITY_MISSING_SUBJECT' });

    const failed = vi.fn().mockResolvedValue(jsonResponse(false, {}, 401));
    await expect(fetchGoogleIdentity({ accessToken: 'at', fetchImpl: failed })).rejects.toMatchObject({ code: 'USERINFO_FAILED' });
  });
});

describe('providerAuth constants', () => {
  it('uses the Google issuer and API audience for a new connection/grant', () => {
    expect(GOOGLE_ISSUER).toBe('https://accounts.google.com');
    expect(GOOGLE_GRANT_AUDIENCE).toBe('https://www.googleapis.com/');
  });
});
