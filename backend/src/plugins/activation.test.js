import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
import { query } from '../services/db.js';
import { getActivatedPlugins, isPluginActivated, setPluginActivated, invalidateActivationCache } from './activation.js';

describe('plugin activation', () => {
  beforeEach(() => {
    query.mockReset();
    ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'].forEach(invalidateActivationCache);
  });

  it('reads the activated set from preferences.enabledPlugins', async () => {
    query.mockResolvedValueOnce({ rows: [{ list: ['gtd', 'other'] }] });
    const set = await getActivatedPlugins('u1');
    expect(set).toEqual(new Set(['gtd', 'other']));
    expect(query.mock.calls[0][0]).toMatch(/preferences->'enabledPlugins'/);
    expect(query.mock.calls[0][1]).toEqual(['u1']);
  });

  it('treats a missing/absent value as nothing activated', async () => {
    query.mockResolvedValueOnce({ rows: [{ list: null }] });
    expect(await getActivatedPlugins('u2')).toEqual(new Set());
  });

  it('treats a malformed (non-array) value as nothing activated', async () => {
    query.mockResolvedValueOnce({ rows: [{ list: { gtd: true } }] });
    expect(await getActivatedPlugins('u3')).toEqual(new Set());
  });

  it('returns empty (no query) for a falsy userId', async () => {
    expect(await getActivatedPlugins(undefined)).toEqual(new Set());
    expect(query).not.toHaveBeenCalled();
  });

  it('degrades to empty on a prefs read failure', async () => {
    query.mockRejectedValueOnce(new Error('db boom'));
    expect(await getActivatedPlugins('u4')).toEqual(new Set());
  });

  it('caches per user until invalidated', async () => {
    query.mockResolvedValueOnce({ rows: [{ list: ['gtd'] }] });
    await getActivatedPlugins('u5');
    await getActivatedPlugins('u5');
    expect(query).toHaveBeenCalledTimes(1); // second read served from cache
    invalidateActivationCache('u5');
    query.mockResolvedValueOnce({ rows: [{ list: [] }] });
    expect(await getActivatedPlugins('u5')).toEqual(new Set());
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('isPluginActivated reflects membership', async () => {
    query.mockResolvedValueOnce({ rows: [{ list: ['gtd'] }] });
    expect(await isPluginActivated('u1', 'gtd')).toBe(true);
    expect(await isPluginActivated('u1', 'nope')).toBe(false); // served from same cached read
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('setPluginActivated adds/removes the id, persists via jsonb_set, and invalidates the cache', async () => {
    query.mockResolvedValueOnce({ rows: [{ list: [] }] }); // current read
    query.mockResolvedValueOnce({ rows: [] });             // the UPDATE
    const set = await setPluginActivated('u6', 'gtd', true);
    expect(set).toEqual(new Set(['gtd']));
    const updateCall = query.mock.calls.find(([sql]) => /UPDATE users/.test(sql));
    expect(updateCall[0]).toMatch(/jsonb_set\(COALESCE\(preferences/);
    expect(updateCall[1]).toEqual(['u6', JSON.stringify(['gtd'])]);

    // next read hits the DB again (cache was invalidated) — returns the freshly written value
    query.mockResolvedValueOnce({ rows: [{ list: ['gtd'] }] });
    expect(await isPluginActivated('u6', 'gtd')).toBe(true);
  });

  it('setPluginActivated removes an id when deactivating', async () => {
    query.mockResolvedValueOnce({ rows: [{ list: ['gtd', 'other'] }] });
    query.mockResolvedValueOnce({ rows: [] });
    const set = await setPluginActivated('u6', 'gtd', false);
    expect(set).toEqual(new Set(['other']));
    const updateCall = query.mock.calls.find(([sql]) => /UPDATE users/.test(sql));
    expect(updateCall[1]).toEqual(['u6', JSON.stringify(['other'])]);
  });
});
