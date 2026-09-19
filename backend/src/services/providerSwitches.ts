import { query } from './db.js';

/**
 * The stored on/off switches for a provider and its methods.
 *
 * Read here rather than in each flow so that enforcement and the readiness report answer the
 * same question: a provider an administrator switched off must stop being usable *and* stop
 * being offered. Living in a service rather than beside the settings routes keeps those routes
 * importable on their own.
 *
 * An absent row (nothing saved yet) or an unreadable configuration counts as switched on: a
 * configuration that cannot be read has not switched anything off.
 */

export type ProviderSwitchName = 'microsoft' | 'google';

export interface ProviderSwitches {
  enabled: boolean;
  webEnabled: boolean;
  deviceEnabled: boolean;
  apiEnabled: boolean;
}

const ALL_ON: ProviderSwitches = { enabled: true, webEnabled: true, deviceEnabled: true, apiEnabled: true };
const ALL_OFF: ProviderSwitches = { enabled: false, webEnabled: false, deviceEnabled: false, apiEnabled: false };

/**
 * Whether the provider layer is available at all, as one operator switch.
 *
 * The per-provider and per-method switches say which parts a configured installation offers; this says
 * whether to offer any of it, which is what an operator wants before configuring a client.
 *
 * Read here so that the four authorization flows and the readiness report answer the same question from
 * the same place. **It does not yet cover every path that reaches a provider**: the three provider sync
 * routes and the scheduled refresh call the adapters directly, so an installation that switches the layer
 * off can still make a scheduled or manual sync call out for collections it already has. Closing that means
 * checking this function in those four places — the two route groups and `runProviderSyncs` — which is
 * recorded here rather than implied, because a switch whose documentation overstates its reach is worse
 * than one that admits the hole.
 *
 * Unset or any value other than an explicit off counts as enabled, so an existing installation is
 * unaffected by the flag's arrival.
 */
export function providerIntegrationsEnabled(): boolean {
  const value = (process.env.PROVIDER_INTEGRATIONS_ENABLED ?? '').trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(value);
}

interface StoredSwitchConfig {
  disabled?: boolean;
  webEnabled?: boolean;
  deviceEnabled?: boolean;
  apiEnabled?: boolean;
}

export async function readProviderSwitches(provider: ProviderSwitchName): Promise<ProviderSwitches> {
  // Switched off wholesale: no query, and no flow may start or be offered.
  if (!providerIntegrationsEnabled()) return ALL_OFF;
  try {
    const result = await query<{ config?: StoredSwitchConfig }>(
      'SELECT config FROM integration_config WHERE provider = $1',
      [provider],
    );
    const stored = result?.rows?.[0]?.config ?? {};
    return {
      enabled: stored.disabled !== true,
      webEnabled: stored.webEnabled !== false,
      deviceEnabled: stored.deviceEnabled !== false,
      apiEnabled: stored.apiEnabled !== false,
    };
  } catch {
    return ALL_ON;
  }
}
