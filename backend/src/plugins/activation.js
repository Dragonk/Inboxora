// Per-user plugin activation (v3.0 plugin platform).
//
// Registration (loadBundledPlugins) says a plugin EXISTS in this build; activation says a given
// USER turned it on. They are independent layers — like an app installed system-wide but enabled
// per account. A plugin's own per-account config (e.g. GTD's gtd_enabled / gtd_folders) is a third,
// deeper layer the plugin owns; the effective "is this plugin doing anything for this account" is
// activation AND the plugin's config (GTD composes this inside getGtdConfig).
//
// State lives in `users.preferences.enabledPlugins` (a JSONB array of plugin ids). Absent = none
// activated (default OFF). A short-TTL per-user cache keeps the hot paths (getGtdConfig et al.)
// from hitting the DB on every call; `invalidateActivationCache` is called on every toggle.
import { query } from '../services/db.js';

const activationCache = new Map(); // userId -> { value: Set<pluginId>, expiry }
const CACHE_TTL_MS = 5 * 60 * 1000;

export function invalidateActivationCache(userId) {
  activationCache.delete(userId);
}

// The set of plugin ids this user has activated. Reads preferences.enabledPlugins; a missing/
// malformed value reads as the empty set (default off). Cached per user with a short TTL.
export async function getActivatedPlugins(userId) {
  if (!userId) return new Set();
  const cached = activationCache.get(userId);
  if (cached && cached.expiry > Date.now()) return cached.value;

  let value = new Set();
  try {
    const { rows } = await query('SELECT preferences->\'enabledPlugins\' AS list FROM users WHERE id = $1', [userId]);
    const list = rows[0]?.list;
    if (Array.isArray(list)) value = new Set(list.filter((id) => typeof id === 'string'));
  } catch {
    // A prefs read blip degrades to "nothing activated" rather than throwing on a hot path.
    value = new Set();
  }
  activationCache.set(userId, { value, expiry: Date.now() + CACHE_TTL_MS });
  return value;
}

// Whether a specific plugin is activated for a user. The cheap gate plugins compose with their
// own config.
export async function isPluginActivated(userId, pluginId) {
  return (await getActivatedPlugins(userId)).has(pluginId);
}

// Turn a plugin on/off for a user (persisted to preferences.enabledPlugins) and drop the cache so
// the change takes effect immediately. Returns the new activated set. Read-modify-write is fine
// here: activation toggles are rare and single-user, never a hot concurrent path.
export async function setPluginActivated(userId, pluginId, activated) {
  const set = new Set(await getActivatedPlugins(userId));
  if (activated) set.add(pluginId); else set.delete(pluginId);
  await query(
    `UPDATE users
        SET preferences = jsonb_set(COALESCE(preferences, '{}'::jsonb), '{enabledPlugins}', $2::jsonb)
      WHERE id = $1`,
    [userId, JSON.stringify([...set])]
  );
  invalidateActivationCache(userId);
  return set;
}
