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

interface StoredSwitchConfig {
  disabled?: boolean;
  webEnabled?: boolean;
  deviceEnabled?: boolean;
  apiEnabled?: boolean;
}

export async function readProviderSwitches(provider: ProviderSwitchName): Promise<ProviderSwitches> {
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
