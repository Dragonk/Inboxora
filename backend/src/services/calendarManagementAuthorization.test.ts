import { describe, expect, it } from 'vitest';
import { evaluateCalendarManagementAuthorization } from './calendarManagementAuthorization.js';
import { evaluateProviderFeatureAuthorization } from './providerFeatureAuthorization.js';

const google = 'https://www.googleapis.com/auth/';
describe('calendar collection management authorization', () => {
  it('does not promote existing Google event writes into collection management', () => {
    const scopes = [`${google}calendar.calendarlist.readonly`, `${google}calendar.events`];
    const before = evaluateProviderFeatureAuthorization('google', 'calendar', scopes);
    expect(before).toMatchObject({ authorized: true, canDiscover: true, canRead: true, canWrite: true });
    expect(evaluateCalendarManagementAuthorization('google', scopes)).toEqual({
      authorized: false, requiredScopes: ['calendar.calendars'], missingScopes: ['calendar.calendars'],
    });
    expect(evaluateProviderFeatureAuthorization('google', 'calendar', scopes)).toEqual(before);
  });

  it.each(['calendar.calendars', 'calendar', `${google}calendar.calendars`, `${google}calendar`])('accepts Google lifecycle grant %s', scope => {
    expect(evaluateCalendarManagementAuthorization('google', [scope])).toEqual({
      authorized: true, requiredScopes: [scope.replace(google, '')], missingScopes: [],
    });
  });

  it.each([
    [], ['calendar.readonly'], ['calendar.calendars.readonly'],
    ['calendar.calendarlist'], ['calendar.events'], ['calendar.events.owned'],
    ['gmail.modify', 'contacts'], ['Calendars.ReadWrite'],
  ].map(scopes => ({ scopes })))('refuses non-lifecycle Google scopes $scopes', ({ scopes }) => {
    expect(evaluateCalendarManagementAuthorization('google', scopes)).toMatchObject({ authorized: false, missingScopes: ['calendar.calendars'] });
  });

  it.each(['Calendars.ReadWrite', 'https://graph.microsoft.com/Calendars.ReadWrite', ' https://graph.microsoft.com/calendars.readwrite '])('accepts Graph scope aliases: %s', scope => {
    expect(evaluateCalendarManagementAuthorization('microsoft', [scope])).toEqual({ authorized: true, requiredScopes: ['Calendars.ReadWrite'], missingScopes: [] });
  });

  it.each([[], ['Calendars.Read'], ['https://graph.microsoft.com/Calendars.Read'], ['Mail.ReadWrite', 'Contacts.ReadWrite'], ['calendar.calendars']].map(scopes => ({ scopes })))('refuses non-lifecycle Graph scopes $scopes', ({ scopes }) => {
    expect(evaluateCalendarManagementAuthorization('microsoft', scopes)).toEqual({ authorized: false, requiredScopes: ['Calendars.ReadWrite'], missingScopes: ['Calendars.ReadWrite'] });
  });

  it('does not mutate caller scopes or change mail/contact authorization', () => {
    const scopes = Object.freeze([`${google}calendar`, `${google}calendar.calendars`]);
    expect(evaluateCalendarManagementAuthorization('google', scopes).requiredScopes).toEqual(['calendar.calendars']);
    expect(evaluateProviderFeatureAuthorization('google', 'mail', scopes).authorized).toBe(false);
    expect(evaluateProviderFeatureAuthorization('google', 'contacts', scopes).authorized).toBe(false);
    expect(evaluateProviderFeatureAuthorization('microsoft', 'mail', ['Calendars.ReadWrite']).authorized).toBe(false);
    expect(evaluateProviderFeatureAuthorization('microsoft', 'contacts', ['Calendars.ReadWrite']).authorized).toBe(false);
  });
});
