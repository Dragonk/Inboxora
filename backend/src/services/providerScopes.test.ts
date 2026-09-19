import { describe, expect, it } from 'vitest';
import { googleScopesForPurpose, microsoftScopesForPurpose } from './providerAuthService.js';

/**
 * The scope matrix is a security boundary: connecting for one feature must never ask
 * for, or receive, another feature's access. A refactor that lets a purpose inherit a
 * scope would silently widen every consent screen, and nothing else would fail — so it
 * is pinned here explicitly rather than implicitly through the flow tests.
 */

const GRAPH = 'https://graph.microsoft.com/';
const GOOGLE = 'https://www.googleapis.com/auth/';

const includes = (scopes: readonly string[], value: string) => scopes.includes(value);

describe('googleScopesForPurpose', () => {
  it('asks for a mailbox only when the purpose is mail', () => {
    const mail = googleScopesForPurpose('mail_migration');
    expect(includes(mail, `${GOOGLE}gmail.modify`)).toBe(true);
    for (const purpose of ['calendar_enable', 'contacts_enable'] as const) {
      const scopes = googleScopesForPurpose(purpose);
      expect(scopes.some(scope => scope.includes('gmail')), `${purpose} must not request mail`).toBe(false);
    }
  });

  it('never crosses contacts and calendars', () => {
    const contacts = googleScopesForPurpose('contacts_enable');
    const calendar = googleScopesForPurpose('calendar_enable');
    expect(includes(contacts, `${GOOGLE}contacts`)).toBe(true);
    expect(contacts.some(scope => scope.includes('calendar'))).toBe(false);
    expect(includes(calendar, `${GOOGLE}calendar.events`)).toBe(true);
    expect(calendar.some(scope => scope.includes('contacts'))).toBe(false);
  });

  it('requests write access only when write access was asked for', () => {
    expect(includes(googleScopesForPurpose('contacts_enable', 'read_only'), `${GOOGLE}contacts.readonly`)).toBe(true);
    expect(includes(googleScopesForPurpose('contacts_enable', 'source'), `${GOOGLE}contacts`)).toBe(true);
    const readOnlyCalendar = googleScopesForPurpose('calendar_enable', 'read_only');
    // The narrower scope must be requested instead of the wider one, not beside it.
    expect(readOnlyCalendar).not.toContain(`${GOOGLE}calendar.events`);
    expect(includes(googleScopesForPurpose('calendar_enable', 'source'), `${GOOGLE}calendar.events`)).toBe(true);
  });

  it('always carries the identity scopes, whatever the purpose', () => {
    for (const purpose of ['new_account', 'mail_migration', 'calendar_enable', 'contacts_enable'] as const) {
      expect(googleScopesForPurpose(purpose)).toEqual(expect.arrayContaining(['openid', 'email', 'profile']));
    }
  });
});

describe('microsoftScopesForPurpose', () => {
  it('asks for a mailbox only when the purpose is mail', () => {
    const mail = microsoftScopesForPurpose('mail_migration');
    expect(mail).toEqual(expect.arrayContaining([`${GRAPH}Mail.ReadWrite`, `${GRAPH}Mail.Send`]));
    for (const purpose of ['calendar_enable', 'contacts_enable'] as const) {
      expect(microsoftScopesForPurpose(purpose).some(scope => scope.includes('/Mail.'))).toBe(false);
    }
  });

  it('never crosses contacts and calendars', () => {
    expect(microsoftScopesForPurpose('contacts_enable')).toContain(`${GRAPH}Contacts.ReadWrite`);
    expect(microsoftScopesForPurpose('contacts_enable').some(scope => scope.includes('/Calendars.'))).toBe(false);
    expect(microsoftScopesForPurpose('calendar_enable')).toContain(`${GRAPH}Calendars.ReadWrite`);
    expect(microsoftScopesForPurpose('calendar_enable').some(scope => scope.includes('/Contacts.'))).toBe(false);
  });

  it('narrows to the read permission when only reading was asked for', () => {
    const readOnly = microsoftScopesForPurpose('calendar_enable', 'read_only');
    expect(readOnly).toContain(`${GRAPH}Calendars.Read`);
    expect(readOnly).not.toContain(`${GRAPH}Calendars.ReadWrite`);
    const contactsReadOnly = microsoftScopesForPurpose('contacts_enable', 'read_only');
    expect(contactsReadOnly).toContain(`${GRAPH}Contacts.Read`);
    expect(contactsReadOnly).not.toContain(`${GRAPH}Contacts.ReadWrite`);
  });

  it('always carries the identity scopes and the scope that identifies the account', () => {
    for (const purpose of ['new_account', 'mail_migration', 'calendar_enable', 'contacts_enable'] as const) {
      const scopes = microsoftScopesForPurpose(purpose);
      expect(scopes).toEqual(expect.arrayContaining(['openid', 'email', 'profile', 'offline_access']));
      // Graph is needed to read /me, and offline_access is what yields a refresh token.
      expect(scopes).toContain(`${GRAPH}User.Read`);
    }
  });

  it('returns a stable, sorted list so the request is reproducible', () => {
    for (const purpose of ['new_account', 'mail_migration', 'calendar_enable', 'contacts_enable'] as const) {
      const scopes = microsoftScopesForPurpose(purpose);
      expect(scopes).toEqual([...scopes].sort());
    }
  });
});

describe('Microsoft readiness predicates', () => {
  it('separates "refresh can work" from "the browser flow can run"', async () => {
    const { isMicrosoftBrowserFlowReady, isMicrosoftConfigured } = await import('./providerAuthService.js');
    const full = {
      clientId: 'c', clientSecret: 's',
      redirectUri: 'https://x/oauth/microsoft/callback',
      providerRedirectUri: 'https://x/oauth/provider/microsoft/callback',
      tenantId: 'common',
    };
    // A public client (device flow) can refresh with a client id alone.
    expect(isMicrosoftConfigured({ clientId: 'c' })).toBe(true);
    expect(isMicrosoftBrowserFlowReady({ clientId: 'c' })).toBe(false);
    // The browser flow is confidential and needs its *own* callback, not the mailbox one.
    expect(isMicrosoftBrowserFlowReady({ clientId: 'c', clientSecret: 's' })).toBe(false);
    expect(isMicrosoftBrowserFlowReady({
      clientId: 'c', clientSecret: 's', redirectUri: 'https://x/oauth/microsoft/callback',
    })).toBe(false);
    expect(isMicrosoftBrowserFlowReady(full)).toBe(true);
    expect(isMicrosoftBrowserFlowReady({})).toBe(false);
  });
});

describe('the scopes the connect buttons actually request', () => {
  // The UI sends `access=read_only` for every purpose it offers, because the connectors
  // only read. If a purpose stopped narrowing, the consent screen would silently widen.
  it('never asks for write access for a purpose the interface offers', () => {
    const google = [
      ...googleScopesForPurpose('contacts_enable', 'read_only'),
      ...googleScopesForPurpose('calendar_enable', 'read_only'),
    ];
    expect(google).not.toContain(`${GOOGLE}contacts`);
    expect(google).not.toContain(`${GOOGLE}calendar.events`);
    expect(google).toContain(`${GOOGLE}contacts.readonly`);
    expect(google).toContain(`${GOOGLE}calendar.events.readonly`);

    const microsoft = microsoftScopesForPurpose('contacts_enable', 'read_only');
    expect(microsoft).toContain(`${GRAPH}Contacts.Read`);
    expect(microsoft).not.toContain(`${GRAPH}Contacts.ReadWrite`);
  });
});
