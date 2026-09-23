import { query } from './db.js';
import {
  GOOGLE_GRANT_AUDIENCE,
  MICROSOFT_GRANT_AUDIENCE,
  graphGrantCoversScope,
} from './providerAuthService.js';

export type ProviderFeature = 'mail' | 'calendar' | 'contacts';
export type FeatureProvider = 'google' | 'microsoft';
export type ProviderFeatureCapability = 'discover' | 'read' | 'write';

export interface ProviderFeatureAuthorization {
  /** Backwards-compatible alias for write access. */
  authorized: boolean;
  requiredScopes: string[];
  grantedScopes: string[];
  missingScopes: string[];
  canDiscover: boolean;
  canRead: boolean;
  canWrite: boolean;
  capabilities: Record<ProviderFeatureCapability, { authorized: boolean; requiredScopes: string[]; missingScopes: string[] }>;
}

const GOOGLE_SCOPE_PREFIX = 'https://www.googleapis.com/auth/';
function googleScopeName(scope: string): string {
  const value = scope.trim().toLowerCase();
  return value.startsWith(GOOGLE_SCOPE_PREFIX) ? value.slice(GOOGLE_SCOPE_PREFIX.length) : value;
}

type ScopeAlternatives = readonly (readonly string[])[];

/** Each inner array is AND; the outer alternatives are documented equivalent grants. */
function legacyRequirements(provider: FeatureProvider, feature: ProviderFeature): string[] {
  if (provider === 'google') {
    if (feature === 'mail') return ['gmail.modify'];
    if (feature === 'calendar') return ['calendar.calendarlist.readonly', 'calendar.events'];
    return ['contacts'];
  }
  if (feature === 'mail') return ['Mail.ReadWrite', 'Mail.Send'];
  if (feature === 'calendar') return ['Calendars.ReadWrite'];
  return ['Contacts.ReadWrite'];
}

function requirements(provider: FeatureProvider, feature: ProviderFeature): Record<ProviderFeatureCapability, ScopeAlternatives> {
  if (provider === 'google') {
    if (feature === 'mail') return { discover: [['gmail.modify']], read: [['gmail.modify']], write: [['gmail.modify']] };
    if (feature === 'calendar') return {
      discover: [['calendar.calendarlist.readonly']], read: [['calendar.events.readonly'], ['calendar.events']], write: [['calendar.events']],
    };
    return { discover: [['contacts.readonly'], ['contacts']], read: [['contacts.readonly'], ['contacts']], write: [['contacts']] };
  }
  if (feature === 'mail') return {
    discover: [['Mail.ReadBasic'], ['Mail.Read'], ['Mail.ReadWrite']], read: [['Mail.Read'], ['Mail.ReadWrite']], write: [['Mail.ReadWrite', 'Mail.Send']],
  };
  if (feature === 'calendar') return {
    discover: [['Calendars.Read'], ['Calendars.ReadWrite']], read: [['Calendars.Read'], ['Calendars.ReadWrite']], write: [['Calendars.ReadWrite']],
  };
  return {
    discover: [['Contacts.Read'], ['Contacts.ReadWrite']], read: [['Contacts.Read'], ['Contacts.ReadWrite']], write: [['Contacts.ReadWrite']],
  };
}

function covers(provider: FeatureProvider, granted: readonly string[], scope: string): boolean {
  if (provider === 'google') return granted.map(googleScopeName).includes(scope.toLowerCase());
  if (graphGrantCoversScope(granted, scope)) return true;
  // Graph ReadWrite semantically includes reading but is not a string prefix of Read.
  return scope.endsWith('.Read') && graphGrantCoversScope(granted, `${scope}Write`);
}

function evaluateCapability(provider: FeatureProvider, granted: readonly string[], alternatives: ScopeAlternatives) {
  for (const required of alternatives) {
    const missing = required.filter(scope => !covers(provider, granted, scope));
    if (missing.length === 0) return { authorized: true, requiredScopes: [...required], missingScopes: [] };
  }
  const candidate = alternatives[0] ?? [];
  return { authorized: false, requiredScopes: [...candidate], missingScopes: candidate.filter(scope => !covers(provider, granted, scope)) };
}

export function evaluateProviderFeatureAuthorization(
  provider: FeatureProvider,
  feature: ProviderFeature,
  scopes: readonly string[],
): ProviderFeatureAuthorization {
  const grantedScopes = [...new Set(scopes.map(scope => scope.trim()).filter(Boolean))].sort();
  const matrix = requirements(provider, feature);
  const capabilities = {
    discover: evaluateCapability(provider, grantedScopes, matrix.discover),
    read: evaluateCapability(provider, grantedScopes, matrix.read),
    write: evaluateCapability(provider, grantedScopes, matrix.write),
  };
  // Preserve the existing public full-feature contract and scope presentation.
  // The new matrix exposes why a read-only grant is nevertheless usable for sync.
  const requiredScopes = legacyRequirements(provider, feature);
  const missingScopes = requiredScopes.filter(scope => !covers(provider, grantedScopes, scope));
  return {
    authorized: missingScopes.length === 0,
    requiredScopes,
    grantedScopes,
    missingScopes,
    canDiscover: capabilities.discover.authorized,
    canRead: capabilities.read.authorized,
    canWrite: capabilities.write.authorized,
    capabilities,
  };
}

export async function readProviderFeatureAuthorization(input: {
  connectionId: string | null;
  provider: FeatureProvider;
  feature: ProviderFeature;
}): Promise<ProviderFeatureAuthorization> {
  if (!input.connectionId) return evaluateProviderFeatureAuthorization(input.provider, input.feature, []);
  const audience = input.provider === 'google' ? GOOGLE_GRANT_AUDIENCE : MICROSOFT_GRANT_AUDIENCE;
  const result = await query<{ scopes: string[] | null }>(
    `SELECT scopes FROM oauth_grants
      WHERE connection_id = $1 AND audience = $2 AND status = 'active'
      LIMIT 1`,
    [input.connectionId, audience],
  );
  return evaluateProviderFeatureAuthorization(input.provider, input.feature, result.rows[0]?.scopes ?? []);
}
