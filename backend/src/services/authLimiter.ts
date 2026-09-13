import { query } from './db.js';

// Mutable config read by the rate-limit middleware on every request, so
// admin changes (via reloadAuthSettings) take effect without a restart.
export const authLimiterConfig = { maxRequests: 10, windowMs: 15 * 60 * 1000 };

export async function reloadAuthSettings() {
  try {
    const result = await query(
      "SELECT key, value FROM system_settings WHERE key IN ('auth_max_attempts', 'auth_window_minutes')"
    );
    for (const row of result.rows) {
      if (row.key === 'auth_max_attempts') {
        const val = parseInt(row.value);
        if (Number.isInteger(val) && val >= 1 && val <= 100)
          authLimiterConfig.maxRequests = val;
      } else if (row.key === 'auth_window_minutes') {
        const val = parseInt(row.value);
        if (Number.isInteger(val) && val >= 1 && val <= 1440)
          authLimiterConfig.windowMs = val * 60 * 1000;
      }
    }
  } catch (err) {
    console.error('[auth] Failed to load rate limit settings:', err.message);
  }
}
