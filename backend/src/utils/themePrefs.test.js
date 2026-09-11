import { describe, it, expect } from 'vitest';
import { sanitizeThemeMode, sanitizeThemeName, sanitizeThemePrefs } from './themePrefs.js';

describe('sanitizeThemeName', () => {
  it('accepts frontend theme identifiers', () => {
    expect(sanitizeThemeName('ink')).toBe('ink');
    expect(sanitizeThemeName('dark_ink')).toBe('dark_ink');
    expect(sanitizeThemeName('catppuccin_mocha')).toBe('catppuccin_mocha');
    expect(sanitizeThemeName('  nord  ')).toBe('nord');
  });

  it('rejects anything that is not a plain lowercase identifier', () => {
    expect(sanitizeThemeName('Dark Ink')).toBeNull();
    expect(sanitizeThemeName('dark-ink')).toBeNull();
    expect(sanitizeThemeName('ink;drop table users')).toBeNull();
    expect(sanitizeThemeName('')).toBeNull();
    expect(sanitizeThemeName('a'.repeat(65))).toBeNull();
    expect(sanitizeThemeName(42)).toBeNull();
    expect(sanitizeThemeName(null)).toBeNull();
    expect(sanitizeThemeName(undefined)).toBeNull();
  });
});

describe('sanitizeThemeMode', () => {
  it('accepts only the three known modes', () => {
    expect(sanitizeThemeMode('system')).toBe('system');
    expect(sanitizeThemeMode('light')).toBe('light');
    expect(sanitizeThemeMode('dark')).toBe('dark');
    expect(sanitizeThemeMode('auto')).toBeNull();
    expect(sanitizeThemeMode(true)).toBeNull();
  });
});

describe('sanitizeThemePrefs — allow-list integrity', () => {
  it('reads only the theme preference keys', () => {
    const out = sanitizeThemePrefs({
      themeMode: 'system',
      themeLight: 'ink',
      themeDark: 'dark_ink',
      theme: 'evil',
    });
    expect(out).toEqual({ themeMode: 'system', themeLight: 'ink', themeDark: 'dark_ink' });
    expect(out).not.toHaveProperty('theme');
  });

  it('returns nulls for absent or invalid values', () => {
    expect(sanitizeThemePrefs({})).toEqual({ themeMode: null, themeLight: null, themeDark: null });
    expect(sanitizeThemePrefs({ themeMode: 'neon', themeLight: 'Bad Name' }))
      .toEqual({ themeMode: null, themeLight: null, themeDark: null });
  });
});
