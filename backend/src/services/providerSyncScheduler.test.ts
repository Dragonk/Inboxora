import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  syncGoogleContacts: vi.fn(),
  syncGoogleCalendar: vi.fn(),
  syncGraphContacts: vi.fn(),
  syncGraphMailFolders: vi.fn(),
  googleConfigured: { value: true },
  microsoftConfigured: { value: true },
}));

vi.mock('./db.js', () => ({ query: mocks.query }));
// Keep every real export and override only what this suite needs.
vi.mock('./providerAuthService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./providerAuthService.js')>()),
  googleConfigFromEnv: () => ({ clientId: 'client-1', clientSecret: 'secret-1', redirectUri: 'https://inboxora.example/oauth/google/callback' }),
  isGoogleConfigured: () => mocks.googleConfigured.value,
  microsoftConfigFromEnv: () => ({ clientId: 'ms-client', clientSecret: 'ms-secret', redirectUri: 'https://inboxora.example/oauth/provider/microsoft/callback', tenantId: 'common' }),
  isMicrosoftConfigured: () => mocks.microsoftConfigured.value,
}));
vi.mock('./providers/google/googleContactsSync.js', () => ({ syncGoogleContacts: mocks.syncGoogleContacts }));
vi.mock('./providers/google/googleCalendarSync.js', () => ({ syncGoogleCalendar: mocks.syncGoogleCalendar }));
vi.mock('./providers/microsoft/graphContactsSync.js', () => ({ syncGraphContacts: mocks.syncGraphContacts }));
vi.mock('./providers/microsoft/graphMailSync.js', () => ({ syncGraphMailFolders: mocks.syncGraphMailFolders }));

import { nextSyncBackoffMs,
  FIRST_PASS_DELAY_MS,
  listProviderSyncTargets,
  providerSyncIntervalMinutes,
  runProviderSyncs,
  startProviderSyncScheduler,
  stopProviderSyncScheduler,
} from './providerSyncScheduler.js';

const target = (overrides: Record<string, unknown> = {}) => ({
  user_id: 'user-1', connection_id: 'connection-1', provider: 'google', features: ['calendar'], ...overrides,
});

afterEach(() => {
  stopProviderSyncScheduler();
  vi.useRealTimers();
  vi.restoreAllMocks();
  mocks.query.mockReset();
  mocks.syncGoogleContacts.mockReset();
  mocks.syncGoogleCalendar.mockReset();
  mocks.syncGraphContacts.mockReset();
  mocks.syncGraphMailFolders.mockReset();
  mocks.googleConfigured.value = true;
  mocks.microsoftConfigured.value = true;
});

describe('providerSyncIntervalMinutes', () => {
  it('defaults when unset and keeps a usable custom value', () => {
    expect(providerSyncIntervalMinutes({})).toBe(15);
    expect(providerSyncIntervalMinutes({ PROVIDER_SYNC_INTERVAL_MINUTES: '30' })).toBe(30);
  });

  it('treats 0 as disabled but garbage as the default, so a typo never stops the refresh', () => {
    expect(providerSyncIntervalMinutes({ PROVIDER_SYNC_INTERVAL_MINUTES: '0' })).toBe(0);
    expect(providerSyncIntervalMinutes({ PROVIDER_SYNC_INTERVAL_MINUTES: 'soon' })).toBe(15);
    expect(providerSyncIntervalMinutes({ PROVIDER_SYNC_INTERVAL_MINUTES: '-5' })).toBe(15);
  });

  it('caps an absurd interval instead of scheduling a multi-year timer', () => {
    expect(providerSyncIntervalMinutes({ PROVIDER_SYNC_INTERVAL_MINUTES: '100000' })).toBe(1440);
  });
});

describe('listProviderSyncTargets', () => {
  it('reads only active provider connections that already have a linked collection', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [target({ features: ['address_book', 'calendar'] })] });
    await expect(listProviderSyncTargets()).resolves.toEqual([
      { userId: 'user-1', connectionId: 'connection-1', provider: 'google', features: ['address_book', 'calendar'] },
    ]);
    const [sql] = mocks.query.mock.calls[0] as [string];
    // An account that was connected but never pulled anything must not be selected.
    expect(sql).toContain("pc.status = 'active'");
    expect(sql).toContain('ic.enabled = true');
    expect(sql).toContain('ic.local_calendar_id IS NOT NULL OR ic.local_address_book_id IS NOT NULL OR ic.local_folder_id IS NOT NULL');
  });

  it('tolerates a driver that returns no feature array', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [target({ features: null })] });
    await expect(listProviderSyncTargets()).resolves.toEqual([
      { userId: 'user-1', connectionId: 'connection-1', provider: 'google', features: [] },
    ]);
  });
});

describe('runProviderSyncs', () => {
  it('refreshes each already-pulled feature of a Google connection', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [target({ features: ['address_book', 'calendar'] })] });
    mocks.syncGoogleContacts.mockResolvedValueOnce({});
    mocks.syncGoogleCalendar.mockResolvedValueOnce({});

    await expect(runProviderSyncs()).resolves.toEqual({ connections: 1, ran: 2, failed: 0 });
    expect(mocks.syncGoogleContacts).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', connectionId: 'connection-1' }));
    expect(mocks.syncGoogleCalendar).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', connectionId: 'connection-1' }));
  });

  it('keeps going when one feature fails, and counts the failure', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [target({ features: ['address_book', 'calendar'] })] });
    mocks.syncGoogleContacts.mockRejectedValueOnce(new Error('grant revoked'));
    mocks.syncGoogleCalendar.mockResolvedValueOnce({});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(runProviderSyncs()).resolves.toEqual({ connections: 1, ran: 1, failed: 1 });
    expect(mocks.syncGoogleCalendar).toHaveBeenCalledOnce();
    // The operator gets a diagnosable line, without any credential in it.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('address_book'), 'grant revoked');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('access-valid');
  });

  it('does not touch a provider/collection pair that has no adapter yet', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [target({ provider: 'microsoft', features: ['calendar'] })] });
    await expect(runProviderSyncs()).resolves.toEqual({ connections: 1, ran: 0, failed: 0 });
    expect(mocks.syncGoogleCalendar).not.toHaveBeenCalled();
    expect(mocks.syncGraphContacts).not.toHaveBeenCalled();
  });

  it('refreshes the Microsoft contacts of a connection that already pulled them', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [target({ provider: 'microsoft', features: ['address_book'] })] });
    mocks.syncGraphContacts.mockResolvedValueOnce({});

    await expect(runProviderSyncs()).resolves.toEqual({ connections: 1, ran: 1, failed: 0 });
    expect(mocks.syncGraphContacts).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1', connectionId: 'connection-1', config: expect.objectContaining({ clientId: 'ms-client' }),
    }));
    expect(mocks.syncGoogleContacts).not.toHaveBeenCalled();
  });

  it('refreshes the Microsoft mail folder tree of a connection that already discovered it', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [target({ provider: 'microsoft', features: ['mail_folder'] })] });
    mocks.syncGraphMailFolders.mockResolvedValueOnce([]);

    await expect(runProviderSyncs()).resolves.toEqual({ connections: 1, ran: 1, failed: 0 });
    expect(mocks.syncGraphMailFolders).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1', connectionId: 'connection-1', config: expect.objectContaining({ clientId: 'ms-client' }),
    }));
    expect(mocks.syncGraphContacts).not.toHaveBeenCalled();
  });

  it('keeps the providers independent: an unconfigured Google does not stop Microsoft', async () => {
    mocks.googleConfigured.value = false;
    mocks.query.mockResolvedValueOnce({ rows: [
      target({ provider: 'google', features: ['address_book'] }),
      target({ provider: 'microsoft', features: ['address_book'] }),
    ] });
    mocks.syncGraphContacts.mockResolvedValueOnce({});

    await expect(runProviderSyncs()).resolves.toEqual({ connections: 2, ran: 1, failed: 0 });
    expect(mocks.syncGoogleContacts).not.toHaveBeenCalled();
    expect(mocks.syncGraphContacts).toHaveBeenCalledOnce();
  });

  it('does not call Microsoft when the administrator has not configured it', async () => {
    mocks.microsoftConfigured.value = false;
    mocks.query.mockResolvedValueOnce({ rows: [target({ provider: 'microsoft', features: ['address_book'] })] });
    await expect(runProviderSyncs()).resolves.toEqual({ connections: 1, ran: 0, failed: 0 });
    expect(mocks.syncGraphContacts).not.toHaveBeenCalled();
  });

  it('counts a failing Microsoft refresh without stopping the rest', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [
      target({ provider: 'microsoft', features: ['address_book'] }),
      target({ connection_id: 'connection-2', provider: 'google', features: ['address_book'] }),
    ] });
    mocks.syncGraphContacts.mockRejectedValueOnce(new Error('token expired'));
    mocks.syncGoogleContacts.mockResolvedValueOnce({});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(runProviderSyncs()).resolves.toEqual({ connections: 2, ran: 1, failed: 1 });
    expect(mocks.syncGoogleContacts).toHaveBeenCalledOnce();
  });

  it('does nothing when the administrator has not configured the Google API', async () => {
    mocks.googleConfigured.value = false;
    mocks.query.mockResolvedValueOnce({ rows: [target({ features: ['calendar'] })] });
    await expect(runProviderSyncs()).resolves.toEqual({ connections: 1, ran: 0, failed: 0 });
    expect(mocks.syncGoogleCalendar).not.toHaveBeenCalled();
  });
});

describe('startProviderSyncScheduler', () => {
  it('arms a repeating timer at the configured cadence', () => {
    vi.useFakeTimers();
    mocks.query.mockResolvedValue({ rows: [] });
    startProviderSyncScheduler({ PROVIDER_SYNC_INTERVAL_MINUTES: '30' });
    // The interval plus the delayed first pass.
    expect(vi.getTimerCount()).toBe(2);
    stopProviderSyncScheduler();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('runs one pass shortly after start, then on the normal cadence', async () => {
    vi.useFakeTimers();
    mocks.query.mockResolvedValue({ rows: [] });
    startProviderSyncScheduler({ PROVIDER_SYNC_INTERVAL_MINUTES: '30' });

    // Nothing happens immediately: start-up is not blocked or raced.
    expect(mocks.query).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(FIRST_PASS_DELAY_MS - 1);
    expect(mocks.query).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.query).toHaveBeenCalledTimes(1);

    // The interval is still a full interval from start, not shortened by the first
    // pass: measured from the first pass it is still one whole interval minus the
    // delay away.
    await vi.advanceTimersByTimeAsync(30 * 60_000 - FIRST_PASS_DELAY_MS - 1);
    expect(mocks.query).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.query).toHaveBeenCalledTimes(2);

    // A restart must not leave a pending first pass behind.
    stopProviderSyncScheduler();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });

  it('arms nothing when the schedule is disabled', () => {
    vi.useFakeTimers();
    startProviderSyncScheduler({ PROVIDER_SYNC_INTERVAL_MINUTES: '0' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not overlap a slow pass with the next tick', async () => {
    vi.useFakeTimers();
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    mocks.query.mockResolvedValue({ rows: [target({ features: ['calendar'] })] });
    mocks.syncGoogleCalendar.mockImplementation(() => gate);

    startProviderSyncScheduler({ PROVIDER_SYNC_INTERVAL_MINUTES: '1' });
    await vi.advanceTimersByTimeAsync(60_000);
    // While the first pass is still running the next tick must not start a second one.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.query).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });
});

describe('the installation switch reaches the schedule', () => {
  it('runs nothing when the provider layer is switched off', async () => {
    // Otherwise an installation that switched the layer off would still call out for collections pulled
    // earlier — the schedule reaches the adapters directly, not through the authorization flows.
    process.env.PROVIDER_INTEGRATIONS_ENABLED = '0';
    try {
      const summary = await runProviderSyncs();
      expect(summary).toEqual({ connections: 0, ran: 0, failed: 0 });
    } finally {
      delete process.env.PROVIDER_INTEGRATIONS_ENABLED;
    }
  });
});

describe('the schedule backs off from a throttled run', () => {
  it('doubles towards a ceiling and resets when a pass is healthy', () => {
    // A fixed interval retried a throttled collection on the same cadence as a healthy one, which is what the
    // plan asks not to do; Retry-After was parsed but never used by the schedule.
    const noJitter = () => 0;
    const first = nextSyncBackoffMs(0, true, noJitter);
    expect(first).toBe(60_000);

    const second = nextSyncBackoffMs(first, true, noJitter);
    expect(second).toBe(120_000);

    // The ceiling holds however long the throttling lasts.
    let delay = second;
    for (let i = 0; i < 12; i += 1) delay = nextSyncBackoffMs(delay, true, noJitter);
    expect(delay).toBe(30 * 60_000);

    // A healthy pass returns to the normal cadence, and jitter keeps a fleet from retrying in lockstep.
    expect(nextSyncBackoffMs(delay, false, noJitter)).toBe(0);
    const jittered = nextSyncBackoffMs(0, true, () => 0.999);
    expect(jittered).toBeGreaterThan(60_000);
    expect(jittered).toBeLessThanOrEqual(60_000 + 15_000);
  });
});
