import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The renewal sweep's decisions.
 *
 * The provider calls are stubbed and the database is stubbed, because what is under test is the policy: renew
 * before expiry, recreate what the provider forgot, never renew for a switched-off installation, and back off
 * instead of hammering when something is wrong. A missed renewal is a latency regression — the schedule still
 * synchronises — so nothing here may throw out of the sweep.
 */

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  listDue: vi.fn(),
  markRemoved: vi.fn(),
  renewGraph: vi.fn(),
  createGraph: vi.fn(),
  ensureGraph: vi.fn(),
  recordGraphFailure: vi.fn(),
  renewGmail: vi.fn(),
  renewChannel: vi.fn(),
  ensureGoogle: vi.fn(),
  gmailAvailable: vi.fn(),
  recordGoogleFailure: vi.fn(),
  readSwitches: vi.fn(),
  integrationsEnabled: vi.fn(),
}));

vi.mock('./db.js', () => ({ query: mocks.query }));
vi.mock('./providerSwitches.js', () => ({
  providerIntegrationsEnabled: mocks.integrationsEnabled,
  readProviderSwitches: mocks.readSwitches,
}));
vi.mock('./providerPushSubscriptions.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./providerPushSubscriptions.js')>()),
  listSubscriptionsDueForRenewal: mocks.listDue,
  markSubscriptionsRemoved: mocks.markRemoved,
}));
vi.mock('./providerPushMicrosoft.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./providerPushMicrosoft.js')>()),
  renewGraphSubscription: mocks.renewGraph,
  createGraphSubscription: mocks.createGraph,
  ensureGraphSubscriptions: mocks.ensureGraph,
  recordGraphRenewalFailure: mocks.recordGraphFailure,
}));
vi.mock('./providerPushGoogle.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./providerPushGoogle.js')>()),
  renewGmailWatch: mocks.renewGmail,
  renewCalendarChannel: mocks.renewChannel,
  ensureGoogleSubscriptions: mocks.ensureGoogle,
  gmailPushAvailable: mocks.gmailAvailable,
  recordGoogleRenewalFailure: mocks.recordGoogleFailure,
}));

import { renewalJitterMs, runProviderPushRenewals, shouldRecreate } from './providerPushScheduler.js';

const baseSubscription = (overrides: Record<string, unknown> = {}) => ({
  id: 'subscription-1',
  user_id: 'user-1',
  provider_connection_id: 'connection-1',
  provider: 'microsoft',
  resource_type: 'mail',
  collection_id: null,
  provider_subscription_id: 'provider-1',
  provider_resource: '/me/messages',
  remote_resource_id: null,
  secret_kind: 'client_state',
  expires_at: new Date(Date.now() + 60_000).toISOString(),
  status: 'active',
  last_notification_at: null,
  last_renewed_at: null,
  last_error_code: null,
  failure_count: 0,
  next_attempt_at: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PROVIDER_PUSH_ENABLED = 'true';
  mocks.integrationsEnabled.mockReturnValue(true);
  mocks.readSwitches.mockResolvedValue({ enabled: true, apiEnabled: true });
  mocks.listDue.mockResolvedValue([]);
  mocks.markRemoved.mockResolvedValue(1);
  mocks.ensureGraph.mockResolvedValue({ created: [], failed: [] });
  mocks.ensureGoogle.mockResolvedValue({ created: [], failed: [] });
  mocks.gmailAvailable.mockReturnValue({ available: true, reason: null });
  mocks.query.mockImplementation(async (sql: unknown) => {
    const text = String(sql);
    if (text.includes('SELECT remote_id FROM integration_collections')) {
      return { rows: [{ remote_id: 'calendar-1' }] };
    }
    return { rows: [] };
  });
});

describe('runProviderPushRenewals', () => {
  it('bootstraps Microsoft mail push for an existing native mailbox', async () => {
    mocks.query.mockImplementation(async (sql: unknown) => {
      const text = String(sql);
      if (text.includes("a.mail_transport = 'microsoft_graph'")) {
        return { rows: [{ user_id: 'user-1', connection_id: 'connection-1' }] };
      }
      if (text.includes('SELECT remote_id FROM integration_collections')) {
        return { rows: [{ remote_id: 'calendar-1' }] };
      }
      return { rows: [] };
    });
    mocks.ensureGraph.mockResolvedValueOnce({ created: ['mail'], failed: [] });

    const summary = await runProviderPushRenewals();

    expect(summary.created).toBe(1);
    expect(mocks.ensureGraph).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      connectionId: 'connection-1',
      resourceTypes: ['mail'],
    }));
  });

  it('continues to due renewals when one Microsoft bootstrap lookup fails', async () => {
    mocks.query.mockImplementation(async (sql: unknown) => {
      const text = String(sql);
      if (text.includes("a.mail_transport = 'microsoft_graph'")) {
        return {
          rows: [
            { user_id: 'user-1', connection_id: 'connection-broken' },
            { user_id: 'user-2', connection_id: 'connection-good' },
          ],
        };
      }
      return { rows: [] };
    });

    mocks.ensureGraph
      .mockRejectedValueOnce(new Error('lookup failed'))
      .mockResolvedValueOnce({ created: ['mail'], failed: [] });

    mocks.listDue.mockResolvedValue([baseSubscription()]);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const summary = await runProviderPushRenewals();

      expect(summary.created).toBe(1);
      expect(summary.failed).toBe(1);
      expect(mocks.ensureGraph).toHaveBeenCalledTimes(2);
      expect(mocks.renewGraph).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it('selects only Microsoft mailboxes that still need a healthy mail subscription', async () => {
    await runProviderPushRenewals();

    const sql = mocks.query.mock.calls
      .map(call => String(call[0]))
      .find(text => text.includes("a.mail_transport = 'microsoft_graph'"));

    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('pps.provider_connection_id = pc.id');
    expect(sql).toContain("pps.resource_type = 'mail'");
    expect(sql).toContain("pps.status = 'active'");
    expect(sql).toContain("pps.expires_at > NOW() + INTERVAL '1 minute'");
  });

  it('bootstraps Gmail push for an existing native Gmail mailbox', async () => {
    mocks.query.mockImplementation(async (sql: unknown) => {
      const text = String(sql);
      if (text.includes("a.mail_transport = 'gmail_api'")) {
        return { rows: [{ user_id: 'user-google', connection_id: 'connection-google' }] };
      }
      return { rows: [] };
    });
    mocks.ensureGoogle.mockResolvedValueOnce({ created: ['mail'], failed: [] });

    const summary = await runProviderPushRenewals();

    expect(summary.created).toBe(1);
    expect(mocks.ensureGoogle).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-google',
      connectionId: 'connection-google',
      calendars: [],
      includeMail: true,
    }));
  });

  it('does not query Gmail bootstrap targets when Pub/Sub push is not configured', async () => {
    mocks.gmailAvailable.mockReturnValueOnce({
      available: false,
      reason: 'PUBSUB_TOPIC_NOT_CONFIGURED',
    });

    await runProviderPushRenewals();

    const googleBootstrapQueries = mocks.query.mock.calls
      .map(call => String(call[0]))
      .filter(text => text.includes("a.mail_transport = 'gmail_api'"));

    expect(googleBootstrapQueries).toHaveLength(0);
    expect(mocks.ensureGoogle).not.toHaveBeenCalled();
  });

  it('renews a Microsoft subscription that is close to expiry', async () => {
    mocks.listDue.mockResolvedValue([baseSubscription()]);
    const summary = await runProviderPushRenewals();
    expect(summary).toMatchObject({ considered: 1, renewed: 1, failed: 0 });
    expect(mocks.renewGraph).toHaveBeenCalledOnce();
  });

  it('renews the Gmail watch and a calendar channel before they lapse', async () => {
    mocks.listDue.mockResolvedValue([
      baseSubscription({ provider: 'google', resource_type: 'mail', provider_subscription_id: 'gmail-watch' }),
      baseSubscription({ id: 'subscription-2', provider: 'google', resource_type: 'calendar', collection_id: 'collection-1' }),
    ]);
    const summary = await runProviderPushRenewals();
    expect(summary).toMatchObject({ considered: 2, renewed: 2 });
    expect(mocks.renewGmail).toHaveBeenCalledOnce();
    // A calendar channel is renewed against the calendar the collection points at.
    expect(mocks.renewChannel).toHaveBeenCalledWith(expect.objectContaining({ remoteCalendarId: 'calendar-1' }));
  });

  it('recreates a subscription the provider no longer has', async () => {
    mocks.listDue.mockResolvedValue([baseSubscription()]);
    mocks.renewGraph.mockRejectedValue(Object.assign(new Error('gone'), { code: 'RESOURCE_NOT_FOUND' }));

    const summary = await runProviderPushRenewals();

    expect(summary).toMatchObject({ recreated: 1, failed: 0 });
    expect(mocks.createGraph).toHaveBeenCalledWith(expect.objectContaining({ resourceType: 'mail' }));
    // The row that named the lost subscription is a tombstone; the recreate wrote the live one.
    expect(mocks.markRemoved).toHaveBeenCalledWith({ subscriptionIds: ['subscription-1'] });
  });

  it('records a failure and backs off when the provider is unreachable', async () => {
    mocks.listDue.mockResolvedValue([baseSubscription()]);
    mocks.renewGraph.mockRejectedValue(Object.assign(new Error('throttled'), { code: 'RATE_LIMITED', retryAfterSeconds: 300 }));

    const summary = await runProviderPushRenewals();

    expect(summary).toMatchObject({ renewed: 0, failed: 1 });
    expect(mocks.recordGraphFailure).toHaveBeenCalledWith(expect.objectContaining({ error: expect.anything() }));
  });

  it('does nothing at all when push or the provider layer is switched off', async () => {
    process.env.PROVIDER_PUSH_ENABLED = 'false';
    expect(await runProviderPushRenewals()).toMatchObject({ considered: 0 });
    expect(mocks.listDue).not.toHaveBeenCalled();

    process.env.PROVIDER_PUSH_ENABLED = 'true';
    mocks.integrationsEnabled.mockReturnValue(false);
    expect(await runProviderPushRenewals()).toMatchObject({ considered: 0 });
    expect(mocks.listDue).not.toHaveBeenCalled();
  });

  it('disables the subscriptions of a provider that was switched off, without calling it', async () => {
    mocks.listDue.mockResolvedValue([baseSubscription()]);
    mocks.readSwitches.mockResolvedValue({ enabled: false, apiEnabled: true });

    const summary = await runProviderPushRenewals();

    expect(summary).toMatchObject({ renewed: 0, skipped: 1 });
    expect(mocks.renewGraph).not.toHaveBeenCalled();
    expect(mocks.markRemoved).toHaveBeenCalledWith({ subscriptionIds: ['subscription-1'], status: 'disabled' });
  });

  it('drops a calendar channel whose collection is gone', async () => {
    mocks.listDue.mockResolvedValue([baseSubscription({ provider: 'google', resource_type: 'calendar', collection_id: 'collection-1' })]);
    mocks.query.mockResolvedValue({ rows: [] });

    const summary = await runProviderPushRenewals();

    expect(summary).toMatchObject({ skipped: 1 });
    expect(mocks.renewChannel).not.toHaveBeenCalled();
    expect(mocks.markRemoved).toHaveBeenCalledWith({ subscriptionIds: ['subscription-1'] });
  });

  it('treats only a missing resource as something to recreate', () => {
    expect(shouldRecreate(Object.assign(new Error('gone'), { code: 'RESOURCE_NOT_FOUND' }))).toBe(true);
    expect(shouldRecreate(Object.assign(new Error('gone'), { status: 404 }))).toBe(true);
    expect(shouldRecreate(Object.assign(new Error('throttled'), { code: 'RATE_LIMITED' }))).toBe(false);
    expect(shouldRecreate(new Error('network'))).toBe(false);
  });

  it('spreads a pass over an hour so installations do not renew in lockstep', () => {
    expect(renewalJitterMs(() => 0)).toBe(0);
    expect(renewalJitterMs(() => 0.5)).toBe(30_000);
    expect(renewalJitterMs(() => 0.999)).toBeLessThan(60_000);
  });
});
