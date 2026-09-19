import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  readProviderSwitches: vi.fn(),
  googleConfig: { clientId: 'g-client', clientSecret: 'g-secret', redirectUri: 'https://inboxora.example/oauth/google/callback' },
}));

vi.mock('./db.js', () => ({ query: mocks.query }));
vi.mock('./providerSwitches.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./providerSwitches.js')>()),
  readProviderSwitches: mocks.readProviderSwitches,
}));
vi.mock('./providerAuthService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./providerAuthService.js')>()),
  googleConfigFromEnv: () => ({ ...mocks.googleConfig }),
}));

import {
  GOOGLE_MAIL_RECOMMENDATION,
  googleMailRecommendationAvailable,
  listActiveGoogleMailRecommendations,
  suppressGoogleMailRecommendation,
} from './accountNotices.js';

const ALL_ON = { enabled: true, webEnabled: true, deviceEnabled: false, apiEnabled: true };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readProviderSwitches.mockResolvedValue(ALL_ON);
  mocks.googleConfig = { clientId: 'g-client', clientSecret: 'g-secret', redirectUri: 'https://inboxora.example/oauth/google/callback' };
});

describe('when the Google mail recommendation may be shown', () => {
  it('is shown when the layer, the method and a client are all present', async () => {
    await expect(googleMailRecommendationAvailable()).resolves.toBe(true);
  });

  it('is not shown when the whole provider layer is switched off', async () => {
    const original = process.env.PROVIDER_INTEGRATIONS_ENABLED;
    process.env.PROVIDER_INTEGRATIONS_ENABLED = '0';
    try {
      await expect(googleMailRecommendationAvailable()).resolves.toBe(false);
      expect(mocks.readProviderSwitches).not.toHaveBeenCalled();
    } finally {
      if (original === undefined) delete process.env.PROVIDER_INTEGRATIONS_ENABLED;
      else process.env.PROVIDER_INTEGRATIONS_ENABLED = original;
    }
  });

  it('is not shown when the Google method is switched off', async () => {
    mocks.readProviderSwitches.mockResolvedValue({ ...ALL_ON, apiEnabled: false });
    await expect(googleMailRecommendationAvailable()).resolves.toBe(false);
  });

  it('is not shown when no Google API client is configured', async () => {
    mocks.googleConfig = { clientId: '', clientSecret: '', redirectUri: '' };
    await expect(googleMailRecommendationAvailable()).resolves.toBe(false);
  });

  it('queries nothing at all when the recommendation is unavailable', async () => {
    mocks.readProviderSwitches.mockResolvedValue({ ...ALL_ON, enabled: false });
    await expect(listActiveGoogleMailRecommendations('user-1')).resolves.toEqual([]);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});

describe('listing the active recommendation', () => {
  it('returns the account id, its address and the notice type, and never the copy', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'account-1', email_address: 'me@gmail.test' }] });
    await expect(listActiveGoogleMailRecommendations('user-1')).resolves.toEqual([
      { accountId: 'account-1', address: 'me@gmail.test', noticeType: GOOGLE_MAIL_RECOMMENDATION },
    ]);
  });

  it('asks only for an enabled Google mailbox still on imap_smtp and not suppressed', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await listActiveGoogleMailRecommendations('user-1');

    const [sql, params] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("COALESCE(a.mail_transport, 'imap_smtp') = 'imap_smtp'");
    expect(sql).toContain('a.enabled = true');
    expect(sql).toContain("a.oauth_provider = 'google'");
    expect(sql).toContain('%.gmail.com');
    expect(sql).toContain('%.googlemail.com');
    expect(sql).toContain("COALESCE(p.suppressed, false) = false");
    expect(params).toEqual(['user-1', 'google_mail_api_recommendation']);
  });

  it('is user-scoped: the query filters on the caller’s own accounts', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await listActiveGoogleMailRecommendations('user-7');
    const [sql, params] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('a.user_id = $1');
    expect(params[0]).toBe('user-7');
  });
});

describe('suppressing the recommendation', () => {
  it('sets suppressed and bumps the revision, under the account’s owner', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'account-1' }] });
    mocks.query.mockResolvedValueOnce({ rows: [] });

    await expect(suppressGoogleMailRecommendation('user-1', 'account-1')).resolves.toEqual({ ok: true });

    const [ownerSql, ownerParams] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(ownerSql).toContain('WHERE id = $1 AND user_id = $2');
    expect(ownerParams).toEqual(['account-1', 'user-1']);

    const [upsertSql, upsertParams] = mocks.query.mock.calls[1] as [string, unknown[]];
    expect(upsertSql).toContain('INSERT INTO account_notice_preferences');
    expect(upsertSql).toContain('revision = account_notice_preferences.revision + 1');
    expect(upsertSql).toContain('suppressed = true');
    expect(upsertParams).toEqual(['user-1', 'account-1', 'google_mail_api_recommendation']);
  });

  it('refuses an account that is not the caller’s, writing no preference', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await expect(suppressGoogleMailRecommendation('user-1', 'account-9')).resolves.toEqual({ ok: false, status: 404, error: 'Account not found' });
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it('can only ever write the one notice type the schema allows', async () => {
    // The Microsoft requirement notice is not a member of the closed set in migration 0101 and has no
    // entry point here: `account_notice_preferences` deliberately cannot represent it.
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'account-1' }] });
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await suppressGoogleMailRecommendation('user-1', 'account-1');
    const [, upsertParams] = mocks.query.mock.calls[1] as [string, unknown[]];
    expect(upsertParams[2]).toBe('google_mail_api_recommendation');
    expect(GOOGLE_MAIL_RECOMMENDATION).toBe('google_mail_api_recommendation');
  });
});
