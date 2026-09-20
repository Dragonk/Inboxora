import { query } from './db.js';
import {
  GOOGLE_GRANT_AUDIENCE,
  MICROSOFT_GRANT_AUDIENCE,
  graphGrantCoversScope,
} from './providerAuthService.js';

export type ProviderFeature = 'mail' | 'calendar' | 'contacts';
export type FeatureProvider = 'google' | 'microsoft';

export interface ProviderFeatureAuthorization {
  authorized: boolean;
  requiredScopes: string[];
  grantedScopes: string[];
  missingScopes: string[];
}

const GOOGLE_SCOPE_PREFIX = 'https://www.googleapis.com/auth/';
function googleScopeName(scope: string): string {
  const value = scope.trim().toLowerCase();
  return value.startsWith(GOOGLE_SCOPE_PREFIX) ? value.slice(GOOGLE_SCOPE_PREFIX.length) : value;
}

function googleRequirement(feature: ProviderFeature): string[] {
  if (feature === 'mail') return ['gmail.modify'];
  if (feature === 'calendar') return ['calendar.calendarlist.readonly', 'calendar.events'];
  return ['contacts'];
}

function microsoftRequirement(feature: ProviderFeature): string[] {
  if (feature === 'mail') return ['Mail.ReadWrite', 'Mail.Send'];
  if (feature === 'calendar') return ['Calendars.ReadWrite'];
  return ['Contacts.ReadWrite'];
}

export function evaluateProviderFeatureAuthorization(
  provider: FeatureProvider,
  feature: ProviderFeature,
  scopes: readonly string[],
): ProviderFeatureAuthorization {
  const grantedScopes = [...new Set(scopes.map(scope => scope.trim()).filter(Boolean))].sort();
  const requiredScopes = provider === 'google' ? googleRequirement(feature) : microsoftRequirement(feature);
  const googleGranted = grantedScopes.map(googleScopeName);
  const missingScopes = provider === 'google'
    ? requiredScopes.filter(required => !googleGranted.includes(required.toLowerCase()))
    : requiredScopes.filter(required => !graphGrantCoversScope(grantedScopes, required));
  return { authorized: missingScopes.length === 0, requiredScopes, grantedScopes, missingScopes };
}

export async function readProviderFeatureAuthorization(input: {
  connectionId: string | null;
  provider: FeatureProvider;
  feature: ProviderFeature;
}): Promise<ProviderFeatureAuthorization> {
  const empty = evaluateProviderFeatureAuthorization(input.provider, input.feature, []);
  if (!input.connectionId) return empty;
  const audience = input.provider === 'google' ? GOOGLE_GRANT_AUDIENCE : MICROSOFT_GRANT_AUDIENCE;
  const result = await query<{ scopes: string[] | null }>(
    `SELECT scopes FROM oauth_grants
      WHERE connection_id = $1 AND audience = $2 AND status = 'active'
      LIMIT 1`,
    [input.connectionId, audience],
  );
  return evaluateProviderFeatureAuthorization(input.provider, input.feature, result.rows[0]?.scopes ?? []);
}
