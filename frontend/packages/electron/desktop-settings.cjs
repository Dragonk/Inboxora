'use strict';

// Pure helpers for the desktop-only settings the Electron shell owns: the native
// notification preference, the window-controls-overlay colours and the back /
// forward availability. They take plain values so they can be unit tested
// without booting Electron (see desktop-settings.test.cjs).

// Window Controls Overlay height, shared with the renderer through the exposed
// bridge so the custom title bar and the reserved layout strip never disagree.
const TITLEBAR_HEIGHT = 48;

// Used before the renderer has reported the resolved theme (first paint) and as a
// fallback for profiles that were created before the overlay existed.
const DEFAULT_TITLEBAR_THEME = Object.freeze({
  color: '#0f0f11',
  symbolColor: '#ffffff',
});

// Window controls only accept `#rrggbb`; anything else is ignored so a hostile or
// buggy renderer cannot push arbitrary strings into the native overlay API.
const TITLEBAR_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

const NOTIFICATION_TEXT_MAX_LENGTH = 200;

// Native notifications are on by default: the pre-change behaviour already showed
// them, so an existing installation must not silently lose them after upgrading.
const DEFAULT_DESKTOP_NOTIFICATIONS = Object.freeze({ enabled: true });

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Resolve the desktop notification preference from a parsed config object.
 * Missing / malformed values fall back to the default (enabled).
 */
function readDesktopNotificationSettings(config) {
  const stored = isPlainObject(config) ? config.desktopNotifications : null;
  if (isPlainObject(stored) && typeof stored.enabled === 'boolean') {
    return { enabled: stored.enabled };
  }
  return { ...DEFAULT_DESKTOP_NOTIFICATIONS };
}

/**
 * Return a new config object with the desktop notification preference updated.
 * Only `true` enables notifications; every other value (including a non-boolean)
 * disables them, so a bad renderer payload can never re-enable them by accident.
 */
function withDesktopNotificationEnabled(config, enabled) {
  const base = isPlainObject(config) ? config : {};
  return { ...base, desktopNotifications: { enabled: enabled === true } };
}

/** Validate a renderer-supplied overlay theme. Returns null when unusable. */
function normalizeTitlebarTheme(value) {
  if (!isPlainObject(value)) return null;
  const color = typeof value.color === 'string' ? value.color.trim().toLowerCase() : '';
  const symbolColor = typeof value.symbolColor === 'string' ? value.symbolColor.trim().toLowerCase() : '';
  if (!TITLEBAR_COLOR_PATTERN.test(color) || !TITLEBAR_COLOR_PATTERN.test(symbolColor)) return null;
  return { color, symbolColor };
}

/** The overlay theme persisted from the last session, or the dark default. */
function readTitlebarTheme(config) {
  const stored = isPlainObject(config) ? config.titlebarTheme : null;
  return normalizeTitlebarTheme(stored) || { ...DEFAULT_TITLEBAR_THEME };
}

/** New config object carrying a validated overlay theme, or null when invalid. */
function withTitlebarTheme(config, theme) {
  const normalized = normalizeTitlebarTheme(theme);
  if (!normalized) return null;
  return { ...(isPlainObject(config) ? config : {}), titlebarTheme: normalized };
}

/**
 * Whether the platform paints native window controls for a hidden title bar.
 * macOS keeps its traffic lights without an overlay; Windows and Linux need one.
 */
function usesTitleBarOverlay(platform) {
  return platform !== 'darwin';
}

/**
 * Whether a visible application menu bar must stay. macOS puts it in the system
 * menu bar, so only Windows and Linux have to lose it inside the window.
 */
function keepsApplicationMenuBar(platform) {
  return platform === 'darwin';
}

/**
 * Clamp and sanitize a renderer-supplied test-notification payload. Returns null
 * when the payload cannot produce a meaningful notification.
 */
function normalizeTestNotification(payload, fallback = {}) {
  const source = isPlainObject(payload) ? payload : {};
  const title = sanitizeNotificationText(source.title, fallback.title);
  const body = sanitizeNotificationText(source.body, fallback.body);
  if (!title && !body) return null;
  return { title, body };
}

function sanitizeNotificationText(value, fallback = '') {
  const text = String(value === undefined || value === null ? fallback || '' : value)
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= NOTIFICATION_TEXT_MAX_LENGTH) return text;
  return text.slice(0, NOTIFICATION_TEXT_MAX_LENGTH - 1) + '…';
}

// `reg query` prints one `NAME    TYPE    VALUE` row per line. Both keys below are
// DWORDs; a missing value/key means "never configured", which is not the same as
// "disabled", so it must not be reported as blocked.
function readRegDword(output, name) {
  const pattern = new RegExp(`^\\s*${name}\\s+REG_DWORD\\s+0x([0-9a-fA-F]+)\\s*$`, 'm');
  const match = String(output || '').match(pattern);
  if (!match) return null;
  return match[1] !== '0';
}

/**
 * Whether Windows itself will show Inboxora's toasts.
 *
 * `Notification.isSupported()` only says the process *can* raise notifications —
 * Windows silently drops them when the user turned them off. The two registry
 * values below are what the Settings app writes, so reading them turns "we sent
 * it" into "the OS will actually show it".
 *
 * @returns true (enabled) | false (disabled) | null (not configured / unknown)
 */
function parseWindowsNotificationsEnabled(perAppOutput, globalOutput) {
  const perApp = readRegDword(perAppOutput, 'Enabled');
  const global = readRegDword(globalOutput, 'ToastEnabled');

  if (global === false) return false;
  if (perApp === false) return false;
  if (perApp === true) return true;
  if (global === true) return true;
  return null;
}

module.exports = {
  DEFAULT_DESKTOP_NOTIFICATIONS,
  DEFAULT_TITLEBAR_THEME,
  TITLEBAR_HEIGHT,
  keepsApplicationMenuBar,
  normalizeTestNotification,
  normalizeTitlebarTheme,
  parseWindowsNotificationsEnabled,
  readDesktopNotificationSettings,
  readTitlebarTheme,
  usesTitleBarOverlay,
  withDesktopNotificationEnabled,
  withTitlebarTheme,
};
