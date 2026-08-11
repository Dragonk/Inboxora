// Per-account plugin config store (v3.0 plugin platform).
//
// A plugin's configuration for one account (an opaque JSON blob the plugin interprets), kept in
// the generic plugin_account_config table — cascade-cleaned when the account is deleted. Plugins
// reach this only through the getAccountConfig / setAccountConfig capabilities (barrel); core owns
// the storage. Replaces GTD's former gtd_enabled / gtd_folders columns on email_accounts.
import { query } from '../services/db.js';

// The plugin's config for an account, or {} when none is stored yet.
export async function getAccountConfig(pluginId, accountId) {
  const { rows } = await query(
    'SELECT config FROM plugin_account_config WHERE plugin_id = $1 AND account_id = $2',
    [pluginId, accountId]
  );
  return rows[0]?.config ?? {};
}

// Upsert the plugin's config for an account (replaces the whole blob).
export async function setAccountConfig(pluginId, accountId, config) {
  await query(
    `INSERT INTO plugin_account_config (plugin_id, account_id, config, updated_at)
     VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (plugin_id, account_id)
       DO UPDATE SET config = EXCLUDED.config, updated_at = now()`,
    [pluginId, accountId, JSON.stringify(config ?? {})]
  );
}
