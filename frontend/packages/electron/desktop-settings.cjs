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
// "disabled", so it must not be reported as blocked. Registry value names are
// case-insensitive, hence the `i` flag.
function readRegDword(output, name) {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^\\s*${escaped}\\s+REG_DWORD\\s+0x([0-9a-fA-F]+)\\s*$`, 'mi');
  const match = String(output || '').match(pattern);
  if (!match) return null;
  // Parse the hex value: `0x00000000` is a legitimate way to write zero and must
  // not be mistaken for "non-zero".
  return Number.parseInt(match[1], 16) !== 0;
}

// The ProgID the app registers for `mailto:` links, and the mail-client key
// Windows lists under Settings -> Default apps -> Email.
const MAILTO_PROG_ID = 'Inboxora.mailto';
const MAIL_CLIENT_NAME = 'Inboxora';
const MAIL_CLIENT_CAPABILITIES_PATH = 'Software\\Clients\\Mail\\Inboxora\\Capabilities';
const MAILTO_SCHEME = 'mailto';
const WINDOWS_MAIL_CLIENT_KEY = 'HKCU\\Software\\Clients\\Mail\\Inboxora';
const WINDOWS_REGISTERED_APPLICATIONS_KEY = 'HKCU\\Software\\RegisteredApplications';
const WINDOWS_MAILTO_USER_CHOICE_KEY = 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\mailto\\UserChoice';

/** Read a REG_SZ value out of a `reg query` dump, or null when it is absent. */
function readRegString(output, name) {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(output || '').match(new RegExp(`^\\s*${escaped}\\s+REG_SZ\\s+(.*?)\\s*$`, 'mi'));
  if (!match) return null;
  const value = match[1].trim().replace(/^"(.*)"$/, '$1');
  return value || null;
}

/**
 * Read the ProgID Windows currently uses for `mailto:` out of a `reg query` of the
 * UserChoice key. Returns null when Windows holds no explicit choice (or the key is
 * unreadable), which means "not us" rather than "unknown".
 */
function parseMailtoUserChoice(output) {
  return readRegString(output, 'ProgId');
}

/** Whether Windows is configured to open `mailto:` links with this app. */
function isDefaultMailtoHandler(userChoiceProgId) {
  return typeof userChoiceProgId === 'string'
    && userChoiceProgId.toLowerCase() === MAILTO_PROG_ID.toLowerCase();
}

/**
 * Whether the registration is actually complete, not merely present: the client
 * capabilities exist with the right `mailto` association, the app is listed in
 * `RegisteredApplications`, and the ProgID still has a launch command. A half-written
 * registration must not be reported as "registered".
 */
function mailtoRegistrationHealth({ clientTree, registeredApplications, progIdCommand } = {}, progId = MAILTO_PROG_ID) {
  const applicationName = readRegString(clientTree, 'ApplicationName');
  const urlAssociation = readRegString(clientTree, MAILTO_SCHEME);
  const registeredPath = readRegString(registeredApplications, MAIL_CLIENT_NAME);
  const command = readRegString(progIdCommand, '(Default)');

  return Boolean(
    applicationName
    && urlAssociation
    && urlAssociation.toLowerCase() === String(progId).toLowerCase()
    && registeredPath
    && registeredPath.toLowerCase() === MAIL_CLIENT_CAPABILITIES_PATH.toLowerCase()
    && command,
  );
}

/** Windows 11 is still reported as version 10; the build number is what separates them. */
function isWindows11(release) {
  const [major, , build] = String(release || '')
    .split('.')
    .map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(major) || !Number.isFinite(build)) return false;
  return major > 10 || (major === 10 && build >= 22000);
}

/**
 * Deep link to the Default apps page. Windows 11 (21H2/22H2 with the April 2023
 * update and later) supports jumping straight to the per-app page for an app
 * registered under HKCU\Software\RegisteredApplications; Windows 10 only has the
 * general list, so that stays the fallback.
 */
function defaultAppsSettingsUri(release, appName = MAIL_CLIENT_NAME) {
  return isWindows11(release)
    ? `ms-settings:defaultapps?registeredAppUser=${encodeURIComponent(appName)}`
    : 'ms-settings:defaultapps';
}

/**
 * What the user can expect to see in the desktop settings card.
 *
 * - `unsupported`     — not Windows; there is nothing to configure.
 * - `default`         — Windows opens `mailto:` links with Inboxora.
 * - `registered`      — Inboxora is listed as an email app, but another app is default.
 * - `not-registered`  — the shell has no (complete) Inboxora mail handler yet.
 */
function mailtoRegistrationState(platform, userChoiceProgId, appRegistered) {
  if (platform !== 'win32') return 'unsupported';
  if (isDefaultMailtoHandler(userChoiceProgId)) return 'default';
  return appRegistered ? 'registered' : 'not-registered';
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
  MAILTO_PROG_ID,
  MAIL_CLIENT_CAPABILITIES_PATH,
  MAIL_CLIENT_NAME,
  MAILTO_SCHEME,
  TITLEBAR_HEIGHT,
  WINDOWS_MAILTO_USER_CHOICE_KEY,
  WINDOWS_MAIL_CLIENT_KEY,
  WINDOWS_REGISTERED_APPLICATIONS_KEY,
  defaultAppsSettingsUri,
  isDefaultMailtoHandler,
  isWindows11,
  keepsApplicationMenuBar,
  mailtoRegistrationHealth,
  mailtoRegistrationState,
  normalizeTestNotification,
  normalizeTitlebarTheme,
  parseMailtoUserChoice,
  parseWindowsNotificationsEnabled,
  readDesktopNotificationSettings,
  readRegString,
  readTitlebarTheme,
  usesTitleBarOverlay,
  withDesktopNotificationEnabled,
  withTitlebarTheme,
};
