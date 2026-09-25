import { afterEach, describe, expect, it, vi } from 'vitest';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('./db.js', () => ({ query }));

import { providerOperationalForSync, readProviderSwitches } from './providerSwitches.js';

describe('provider sync switches', () => {
  const original = process.env.PROVIDER_INTEGRATIONS_ENABLED;
  afterEach(() => {
    query.mockReset().mockResolvedValue({ rows: [] });
    if (original === undefined) delete process.env.PROVIDER_INTEGRATIONS_ENABLED;
    else process.env.PROVIDER_INTEGRATIONS_ENABLED = original;
  });

  it.each([
    [{ disabled: true }, 'google'],
    [{ apiEnabled: false }, 'google'],
    [{ disabled: true }, 'microsoft'],
    [{ apiEnabled: false }, 'microsoft'],
  ] as const)('does not permit %s sync when its API policy is off', async (config, provider) => {
    query.mockResolvedValueOnce({ rows: [{ config }] });
    await expect(providerOperationalForSync(provider)).resolves.toBe(false);
  });

  it('permits an existing provider sync when no switch has disabled it', async () => {
    query.mockResolvedValueOnce({ rows: [{ config: {} }] });
    await expect(providerOperationalForSync('google')).resolves.toBe(true);
  });

  it('treats the global integration switch as stronger than a stored provider setting', async () => {
    process.env.PROVIDER_INTEGRATIONS_ENABLED = 'off';
    await expect(readProviderSwitches('google')).resolves.toMatchObject({ enabled: false, apiEnabled: false });
    expect(query).not.toHaveBeenCalled();
  });
});
