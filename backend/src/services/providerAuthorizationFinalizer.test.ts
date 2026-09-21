import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The post-authorization finalizer.
 *
 * Authorization and synchronization are separate outcomes. These cases pin the four answers it can give: the
 * run it implies is started immediately (not left to the scheduler), a failure keeps the grant and reports the
 * provider's own code, and the result the opener receives carries no credential.
 */

const calls = vi.hoisted(() => ({
  syncGmailLabels: vi.fn(async () => ({ labels: 1 })),
  syncGmailMessages: vi.fn(async () => ({ messages: 1 })),
  syncGoogleCalendar: vi.fn(async () => ({ events: 1 })),
  syncGoogleContacts: vi.fn(async () => ({ contacts: 3 })),
  syncGraphFolders: vi.fn(async () => []),
  syncGraphMessages: vi.fn(async () => ({ messages: 1 })),
  syncGraphCalendar: vi.fn(async () => ({ events: 1 })),
  syncGraphContacts: vi.fn(async () => ({ contacts: 3 })),
}));

vi.mock('./providers/google/gmailMailSync.js', () => ({
  syncGmailMailLabelsForAccount: calls.syncGmailLabels,
  syncGmailMailMessagesForAccount: calls.syncGmailMessages,
}));
vi.mock('./providers/google/googleCalendarSync.js', () => ({ syncGoogleCalendar: calls.syncGoogleCalendar }));
vi.mock('./providers/google/googleContactsSync.js', () => ({ syncGoogleContacts: calls.syncGoogleContacts }));
vi.mock('./providers/microsoft/graphMailSync.js', () => ({
  syncGraphMailFolders: calls.syncGraphFolders,
  syncGraphMailMessagesForAccount: calls.syncGraphMessages,
}));
vi.mock('./providers/microsoft/graphCalendarSync.js', () => ({ syncGraphCalendar: calls.syncGraphCalendar }));
vi.mock('./providers/microsoft/graphContactsSync.js', () => ({ syncGraphContacts: calls.syncGraphContacts }));

vi.mock('./db.js', () => ({
  withTransaction: async (fn: (client: unknown) => unknown) => fn({ query: async () => ({ rows: [] }) }),
  query: async () => ({ rows: [] }),
}));
vi.mock('./syncCoordinator.js', () => ({
  ensureSyncState: vi.fn(async () => 'state-1'),
  acquireSyncLease: vi.fn(async () => ({ generation: 1 })),
  failSyncRun: vi.fn(async () => true),
}));

import { authorizationResultQuery, finalizeProviderAuthorization } from './providerAuthorizationFinalizer.js';

const GOOGLE_CONFIG = { clientId: 'c', clientSecret: 's', redirectUri: 'https://inboxora.example/oauth/google/callback' };
const MICROSOFT_CONFIG = { clientId: 'c', clientSecret: 's', redirectUri: 'https://inboxora.example/oauth/microsoft/callback', providerRedirectUri: 'https://inboxora.example/oauth/microsoft/callback', tenantId: 'common' };

const input = (overrides: Record<string, unknown> = {}) => ({
  userId: 'user-1',
  provider: 'google' as const,
  purpose: 'calendar_enable' as const,
  targetAccountId: 'account-1',
  connectionId: 'connection-1',
  googleConfig: GOOGLE_CONFIG,
  microsoftConfig: MICROSOFT_CONFIG,
  ...overrides,
});

beforeEach(() => {
  for (const fn of Object.values(calls)) fn.mockClear();
});

describe('finalizeProviderAuthorization', () => {
  it('runs the calendar synchronisation immediately for calendar_enable', async () => {
    const result = await finalizeProviderAuthorization(input());
    expect(calls.syncGoogleCalendar).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', connectionId: 'connection-1' }));
    expect(result).toMatchObject({
      provider: 'google', purpose: 'calendar_enable', accountId: 'account-1', connectionId: 'connection-1',
      authorized: true, synchronized: true, syncPending: false, syncErrorCode: null,
    });
  });

  it('reports a partially failed calendar run as a failure, not as success', async () => {
    // OBS-02: a calendar run reports one bad shared calendar in `errors` and still resolves. Reading only the
    // exception let the consent be announced as synchronized while a calendar had not been pulled at all.
    calls.syncGoogleCalendar.mockResolvedValueOnce({
      collections: 2, created: 1, updated: 0, deleted: 0, skipped: 0, fullSync: false,
      errors: [{ calendarId: 'shared-cal', code: 'INSUFFICIENT_SCOPES' }],
    } as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await finalizeProviderAuthorization(input());
      expect(result).toMatchObject({ authorized: true, synchronized: false, syncPending: false, syncErrorCode: 'INSUFFICIENT_SCOPES' });
    } finally {
      warn.mockRestore();
    }
  });

  it('runs the contacts synchronisation immediately for contacts_enable', async () => {
    const result = await finalizeProviderAuthorization(input({ purpose: 'contacts_enable' }));
    expect(calls.syncGoogleContacts).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'connection-1' }));
    expect(result.synchronized).toBe(true);
  });

  it('runs discovery and then the messages for mail_migration', async () => {
    const result = await finalizeProviderAuthorization(input({ purpose: 'mail_migration' }));
    expect(calls.syncGmailLabels).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'account-1' }));
    expect(calls.syncGmailMessages).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'account-1' }));
    expect(result.synchronized).toBe(true);
  });

  it('uses the Microsoft syncs for a Microsoft consent', async () => {
    const calendar = await finalizeProviderAuthorization(input({ provider: 'microsoft' }));
    expect(calls.syncGraphCalendar).toHaveBeenCalled();
    expect(calendar.provider).toBe('microsoft');

    const contacts = await finalizeProviderAuthorization(input({ provider: 'microsoft', purpose: 'contacts_enable' }));
    expect(calls.syncGraphContacts).toHaveBeenCalled();
    expect(contacts.synchronized).toBe(true);
  });

  it('keeps the grant when the first run fails, and reports the provider code', async () => {
    // The distinction the interface needs: this is connected with a synchronization failure, never
    // "not connected" — reconnecting would change nothing.
    calls.syncGoogleCalendar.mockRejectedValueOnce(Object.assign(new Error('forbidden'), { code: 'INSUFFICIENT_SCOPES', status: 403 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await finalizeProviderAuthorization(input());
      expect(result).toMatchObject({
        authorized: true, synchronized: false, syncPending: false, syncErrorCode: 'INSUFFICIENT_SCOPES',
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('maps an unnamed failure to a concrete code rather than a generic one', async () => {
    calls.syncGoogleContacts.mockRejectedValueOnce(Object.assign(new Error('throttled'), { status: 429 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await finalizeProviderAuthorization(input({ purpose: 'contacts_enable' }));
      expect(result.syncErrorCode).toBe('RATE_LIMITED');
    } finally {
      warn.mockRestore();
    }
  });

  it('primes every feature from one consent, and keeps going when one of them fails', async () => {
    // One authorization for the whole mailbox: calendar and contacts are both run, and the mail baseline too
    // when the flow named a mailbox. A failure in one feature does not stop the others — each records its own
    // state — and the first failure is what the caller reports.
    const result = await finalizeProviderAuthorization(input({ purpose: 'account_enable' }));
    expect(calls.syncGoogleCalendar).toHaveBeenCalled();
    expect(calls.syncGoogleContacts).toHaveBeenCalled();
    expect(calls.syncGmailMessages).toHaveBeenCalled();
    expect(result).toMatchObject({ purpose: 'account_enable', authorized: true, synchronized: true, syncErrorCode: null });

    calls.syncGoogleCalendar.mockRejectedValueOnce(Object.assign(new Error('forbidden'), { code: 'INSUFFICIENT_SCOPES' }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const partial = await finalizeProviderAuthorization(input({ purpose: 'account_enable' }));
      expect(partial).toMatchObject({ authorized: true, synchronized: false, syncErrorCode: 'INSUFFICIENT_SCOPES' });
      // The contacts run still happened, so one refused feature does not leave the others unprimed.
      expect(calls.syncGoogleContacts).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('requests the whole mailbox in one consent', async () => {
    const { googleScopesForPurpose, microsoftScopesForPurpose } = await import('./providerAuthService.js');
    const google = googleScopesForPurpose('account_enable');
    expect(google).toContain('https://www.googleapis.com/auth/gmail.modify');
    expect(google).toContain('https://www.googleapis.com/auth/calendar.events');
    expect(google).toContain('https://www.googleapis.com/auth/contacts');
    const microsoft = microsoftScopesForPurpose('account_enable');
    for (const scope of ['Mail.ReadWrite', 'Mail.Send', 'Calendars.ReadWrite', 'Contacts.ReadWrite']) {
      expect(microsoft.some(entry => entry.endsWith(scope)), scope).toBe(true);
    }
  });

  it('refuses a mail baseline without the mailbox it belongs to', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await finalizeProviderAuthorization(input({ purpose: 'mail_migration', targetAccountId: null }));
      expect(result.syncErrorCode).toBe('TARGET_ACCOUNT_REQUIRED');
      expect(calls.syncGmailMessages).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('reports the result to the opener without a token', () => {
    const query = authorizationResultQuery({
      provider: 'microsoft', purpose: 'calendar_enable', accountId: 'account-1', connectionId: 'connection-1',
      authorized: true, synchronized: false, syncPending: false, syncErrorCode: 'INSUFFICIENT_SCOPES',
    });
    const params = new URLSearchParams(query);
    expect(params.get('provider')).toBe('microsoft');
    expect(params.get('purpose')).toBe('calendar_enable');
    expect(params.get('accountId')).toBe('account-1');
    expect(params.get('synchronized')).toBe('0');
    expect(params.get('syncErrorCode')).toBe('INSUFFICIENT_SCOPES');
    // Nothing about the connection's credentials travels.
    for (const forbidden of ['token', 'secret', 'code', 'connectionId']) {
      expect(query, `${forbidden} leaked into the result`).not.toContain(forbidden);
    }
  });
});
