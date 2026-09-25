import { graphGrantCoversScope } from './providerAuthService.js';
import type { FeatureProvider } from './providerFeatureAuthorization.js';

export interface CalendarManagementAuthorization {
  authorized: boolean;
  requiredScopes: string[];
  missingScopes: string[];
}

/**
 * Calendar collection lifecycle is separate from event writing and discovery.
 * This evaluates the grant only: account enablement and per-calendar ownership /
 * default-calendar protection still need their own checks before any mutation.
 */
export function evaluateCalendarManagementAuthorization(
  provider: FeatureProvider,
  grantedScopes: readonly string[],
): CalendarManagementAuthorization {
  if (provider === 'microsoft') {
    const requiredScopes = ['Calendars.ReadWrite'];
    const authorized = graphGrantCoversScope(grantedScopes, requiredScopes[0]!);
    return { authorized, requiredScopes, missingScopes: authorized ? [] : [...requiredScopes] };
  }

  const prefix = 'https://www.googleapis.com/auth/';
  const granted = new Set(grantedScopes.map(scope => {
    const value = scope.trim().toLowerCase();
    return value.startsWith(prefix) ? value.slice(prefix.length) : value;
  }));
  // Full Calendar is an alternative grant, not an additional requirement. Keep
  // the requested missing scope minimal for existing event-only authorizations.
  const scope = granted.has('calendar.calendars') ? 'calendar.calendars'
    : granted.has('calendar') ? 'calendar' : 'calendar.calendars';
  const authorized = granted.has(scope);
  return { authorized, requiredScopes: [scope], missingScopes: authorized ? [] : [scope] };
}
