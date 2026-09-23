import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Whether an account may use one provider feature.
 *
 * A provider connection existing proves nothing about a feature: Gmail, Calendar and People share the Google
 * audience, and Graph's mail, calendar and contacts share Microsoft's, so one connection can hold any subset
 * of the scopes. These cases pin the per-feature answer — the one the account card and the sync preflight
 * both read — including the scope spellings each provider actually returns.
 */

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('./db.js', () => ({ query: mocks.query }));

import {
  evaluateProviderFeatureAuthorization,
  readProviderFeatureAuthorization,
} from './providerFeatureAuthorization.js';

const GOOGLE = 'https://www.googleapis.com/auth/';

describe('per-feature authorization (unit)', () => {
  it('requires the Gmail scope for mail, and only the Gmail scope', () => {
    const mail = evaluateProviderFeatureAuthorization('google', 'mail', [`${GOOGLE}gmail.modify`, `${GOOGLE}calendar.events`]);
    expect(mail).toMatchObject({ authorized: true, missingScopes: [] });
    expect(mail.grantedScopes).toContain(`${GOOGLE}gmail.modify`);

    // A calendar-only grant is not a mail grant.
    expect(evaluateProviderFeatureAuthorization('google', 'mail', [`${GOOGLE}calendar.events`]))
      .toMatchObject({ authorized: false, missingScopes: ['gmail.modify'] });
  });

  it('requires both calendar scopes, tolerating the full URL form', () => {
    expect(evaluateProviderFeatureAuthorization('google', 'calendar', [
      `${GOOGLE}calendar.calendarlist.readonly`, `${GOOGLE}calendar.events`,
    ])).toMatchObject({ authorized: true, missingScopes: [] });

    const partial = evaluateProviderFeatureAuthorization('google', 'calendar', [`${GOOGLE}calendar.calendarlist.readonly`]);
    expect(partial).toMatchObject({ authorized: false });
    expect(partial.missingScopes).toEqual(['calendar.events']);
  });

  it('requires the contacts scope for contacts', () => {
    expect(evaluateProviderFeatureAuthorization('google', 'contacts', [`${GOOGLE}contacts`]))
      .toMatchObject({ authorized: true });
    // A read-only contacts grant does not satisfy the write feature.
    expect(evaluateProviderFeatureAuthorization('google', 'contacts', [`${GOOGLE}contacts.readonly`]))
      .toMatchObject({ authorized: false, missingScopes: ['contacts'] });
  });

  it('models read-only Google Calendar and People access separately from write', () => {
    const calendar = evaluateProviderFeatureAuthorization('google', 'calendar', [
      `${GOOGLE}calendar.calendarlist.readonly`, `${GOOGLE}calendar.events.readonly`,
    ]);
    expect(calendar).toMatchObject({ canDiscover: true, canRead: true, canWrite: false, authorized: false });
    expect(calendar.capabilities.write.missingScopes).toEqual(['calendar.events']);

    const contacts = evaluateProviderFeatureAuthorization('google', 'contacts', [`${GOOGLE}contacts.readonly`]);
    expect(contacts).toMatchObject({ canDiscover: true, canRead: true, canWrite: false, authorized: false });
    expect(contacts.capabilities.write.missingScopes).toEqual(['contacts']);
  });

  it('keeps the Google features independent of one another', () => {
    // The exact sequence a user performs: mail, then calendar, then contacts. Each step must leave the
    // earlier features authorized.
    let scopes: string[] = [`${GOOGLE}gmail.modify`];
    expect(evaluateProviderFeatureAuthorization('google', 'mail', scopes).authorized).toBe(true);

    scopes = [...scopes, `${GOOGLE}calendar.calendarlist.readonly`, `${GOOGLE}calendar.events`];
    expect(evaluateProviderFeatureAuthorization('google', 'mail', scopes).authorized).toBe(true);
    expect(evaluateProviderFeatureAuthorization('google', 'calendar', scopes).authorized).toBe(true);
    expect(evaluateProviderFeatureAuthorization('google', 'contacts', scopes).authorized).toBe(false);

    scopes = [...scopes, `${GOOGLE}contacts`];
    for (const feature of ['mail', 'calendar', 'contacts'] as const) {
      expect(evaluateProviderFeatureAuthorization('google', feature, scopes).authorized, feature).toBe(true);
    }
  });

  it('evaluates Graph features with the prefix-aware scope matcher', () => {
    const mail = evaluateProviderFeatureAuthorization('microsoft', 'mail', [
      'https://graph.microsoft.com/Mail.ReadWrite', 'https://graph.microsoft.com/Mail.Send',
    ]);
    expect(mail).toMatchObject({ authorized: true, missingScopes: [] });

    // The short form Microsoft also returns is accepted.
    expect(evaluateProviderFeatureAuthorization('microsoft', 'mail', ['Mail.ReadWrite', 'Mail.Send']))
      .toMatchObject({ authorized: true });

    // Mail without send is not a mail grant for a transport that sends over Graph.
    expect(evaluateProviderFeatureAuthorization('microsoft', 'mail', ['Mail.ReadWrite']))
      .toMatchObject({ authorized: false, missingScopes: ['Mail.Send'] });

    expect(evaluateProviderFeatureAuthorization('microsoft', 'calendar', ['Calendars.ReadWrite']))
      .toMatchObject({ authorized: true });
    expect(evaluateProviderFeatureAuthorization('microsoft', 'calendar', ['Mail.ReadWrite', 'Mail.Send']))
      .toMatchObject({ authorized: false, missingScopes: ['Calendars.ReadWrite'] });
    expect(evaluateProviderFeatureAuthorization('microsoft', 'contacts', ['Contacts.ReadWrite']))
      .toMatchObject({ authorized: true });
    // A read-only contacts grant is not the write feature.
    expect(evaluateProviderFeatureAuthorization('microsoft', 'contacts', ['Contacts.Read']))
      .toMatchObject({ authorized: false, missingScopes: ['Contacts.ReadWrite'] });
  });

  it('authorizes nothing without a connection or without an active grant', async () => {
    mocks.query.mockReset();
    // No connection: every feature is unauthorized, with the requirement named.
    const withoutConnection = await readProviderFeatureAuthorization({ connectionId: null, provider: 'google', feature: 'calendar' });
    expect(withoutConnection).toMatchObject({ authorized: false, missingScopes: ['calendar.calendarlist.readonly', 'calendar.events'] });
    // No query is issued when there is nothing to read.
    expect(mocks.query).not.toHaveBeenCalled();

    // A connection whose grant was revoked reads as no grant at all.
    mocks.query.mockResolvedValue({ rows: [] });
    const revoked = await readProviderFeatureAuthorization({ connectionId: 'connection-1', provider: 'google', feature: 'mail' });
    expect(revoked).toMatchObject({ authorized: false, missingScopes: ['gmail.modify'] });

    // And an active grant with the right scope authorizes exactly that feature.
    mocks.query.mockResolvedValue({ rows: [{ scopes: [`${GOOGLE}gmail.modify`] }] });
    const authorized = await readProviderFeatureAuthorization({ connectionId: 'connection-1', provider: 'google', feature: 'mail' });
    expect(authorized).toMatchObject({ authorized: true, missingScopes: [] });
    const calendar = await readProviderFeatureAuthorization({ connectionId: 'connection-1', provider: 'google', feature: 'calendar' });
    expect(calendar.authorized).toBe(false);
    expect(calendar.missingScopes).toContain('calendar.events');
  });
});

describe('the account feature view', () => {
  beforeEach(() => { mocks.query.mockReset(); });

  it('reports authorization per feature rather than a connection existing', async () => {
    mocks.query.mockResolvedValue({ rows: [{ scopes: [`${GOOGLE}gmail.modify`] }] });
    const mail = await readProviderFeatureAuthorization({ connectionId: 'connection-1', provider: 'google', feature: 'mail' });
    const contacts = await readProviderFeatureAuthorization({ connectionId: 'connection-1', provider: 'google', feature: 'contacts' });
    expect(mail.authorized).toBe(true);
    expect(contacts.authorized).toBe(false);
    // The requirement is part of the answer, so the interface can say what is missing without duplicating the
    // scope tables.
    expect(contacts.requiredScopes).toEqual(['contacts']);
    expect(contacts.missingScopes).toEqual(['contacts']);
  });
});
