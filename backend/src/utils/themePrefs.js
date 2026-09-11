// Allow-list for the separate light/dark theme defaults persisted by
// PATCH /auth/preferences, plus the mode that decides which default is rendered.
//
// `themeMode` selects the appearance ("system" follows the OS colour scheme,
// "light"/"dark" force one of the two defaults). Theme identifiers are frontend
// theme keys — lowercase letters, digits and underscores, e.g. "ink" or
// "dark_ink" — so the JSONB value can never carry arbitrary text.

export const THEME_MODES = ['system', 'light', 'dark'];

const THEME_NAME_PATTERN = /^[a-z0-9_]{1,64}$/;

export function sanitizeThemeName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return THEME_NAME_PATTERN.test(name) ? name : null;
}

export function sanitizeThemeMode(value) {
  return THEME_MODES.includes(value) ? value : null;
}

export function sanitizeThemePrefs(body = {}) {
  return {
    themeMode: sanitizeThemeMode(body.themeMode),
    themeLight: sanitizeThemeName(body.themeLight),
    themeDark: sanitizeThemeName(body.themeDark),
  };
}
