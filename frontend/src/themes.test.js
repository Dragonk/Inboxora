// Run with: node --test src/themes.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { THEMES, DEFAULT_LIGHT_THEME, DEFAULT_DARK_THEME, themeTone, themesByTone, resolveTheme, readThemePrefs } from './themes.js';

const names = Object.keys(THEMES);

// The canonical CSS-variable contract every theme must satisfy is taken from the
// first theme rather than a hardcoded list — so the check tracks the real set and a
// var added to every theme can never drift out of sync with this test.
const [reference] = names;
const canonicalVars = Object.keys(THEMES[reference].vars);

// One theme (parchment) intentionally carries a var the others don't need
// (--selection-bg, a sepia selection tint that only the light parchment surface
// wants). The invariant we pin is "no theme silently OMITS a canonical var", so
// extras beyond the canonical set are tolerated only from this known list — a *new*
// stray var still trips the guard and has to be justified (added everywhere or listed).
const KNOWN_THEME_EXTRAS = new Set(['--selection-bg']);

describe('THEMES CSS-var contract', () => {
  it('every theme defines all canonical CSS vars (no silent omissions)', () => {
    for (const name of names) {
      const keys = new Set(Object.keys(THEMES[name].vars));
      const missing = canonicalVars.filter(v => !keys.has(v));
      assert.deepEqual(missing, [], `${name} is missing vars: ${missing.join(', ')}`);
    }
  });

  it('no theme introduces an unexpected CSS var beyond the canonical set', () => {
    const canonical = new Set(canonicalVars);
    for (const name of names) {
      const extras = Object.keys(THEMES[name].vars)
        .filter(v => !canonical.has(v) && !KNOWN_THEME_EXTRAS.has(v));
      assert.deepEqual(extras, [], `${name} has unexpected vars: ${extras.join(', ')}`);
    }
  });

  it('every theme preview is an array of the same arity', () => {
    const arity = THEMES[reference].preview.length;
    for (const name of names) {
      assert.ok(Array.isArray(THEMES[name].preview), `${name} preview must be an array`);
      assert.equal(THEMES[name].preview.length, arity, `${name} preview arity differs from ${reference}`);
    }
  });
});

describe('light/dark theme defaults', () => {
  it('ships Dark ink as the dark counterpart of Ink', () => {
    assert.ok(THEMES.dark_ink, 'the Dark ink theme must exist');
    assert.equal(themeTone('dark_ink'), 'dark');
    assert.equal(THEMES.dark_ink.label, 'Dark ink');
    // Same palette contract as Ink — the canonical-vars test covers the vars, this
    // pins the shared fountain-pen indigo accent family and its dark surface.
    assert.equal(THEMES.dark_ink.vars['--accent'], '#8aa5dd');
    assert.notEqual(THEMES.dark_ink.vars['--bg-primary'], THEMES.ink.vars['--bg-primary']);
  });

  it('defaults to Ink for light and Dark ink for dark', () => {
    assert.equal(DEFAULT_LIGHT_THEME, 'ink');
    assert.equal(DEFAULT_DARK_THEME, 'dark_ink');
    assert.equal(themeTone(DEFAULT_LIGHT_THEME), 'light');
    assert.equal(themeTone(DEFAULT_DARK_THEME), 'dark');
  });

  it('declares a valid tone on every theme and partitions them exactly', () => {
    const light = themesByTone('light').map(([key]) => key);
    const dark = themesByTone('dark').map(([key]) => key);
    for (const name of names) {
      assert.ok(['light', 'dark'].includes(THEMES[name].tone), `${name} has no valid tone`);
    }
    assert.deepEqual([...light, ...dark].sort(), [...names].sort(), 'tone groups must cover every theme once');
  });

  it('resolves a forced appearance from its own default slot', () => {
    const prefs = { mode: 'light', light: 'parchment', dark: 'nord' };
    assert.equal(resolveTheme(prefs), 'parchment');
    assert.equal(resolveTheme({ ...prefs, mode: 'dark' }), 'nord');
  });

  it('resolves the system mode from the OS colour scheme', () => {
    const original = globalThis.window;
    try {
      globalThis.window = { matchMedia: () => ({ matches: false }) };
      assert.equal(resolveTheme({ mode: 'system', light: 'parchment', dark: 'nord' }), 'parchment');
      globalThis.window = { matchMedia: () => ({ matches: true }) };
      assert.equal(resolveTheme({ mode: 'system', light: 'parchment', dark: 'nord' }), 'nord');
    } finally {
      if (original === undefined) delete globalThis.window;
      else globalThis.window = original;
    }
  });

  it('falls back to the shipped defaults when a stored theme is unknown', () => {
    const original = globalThis.localStorage;
    try {
      globalThis.localStorage = {
        getItem: key => ({
          mailflow_theme_mode: 'system',
          mailflow_theme_light: 'does_not_exist',
          mailflow_theme_dark: 'dark_ink',
        })[key] ?? null,
      };
      assert.deepEqual(readThemePrefs(), { mode: 'system', light: 'ink', dark: 'dark_ink' });
    } finally {
      if (original === undefined) delete globalThis.localStorage;
      else globalThis.localStorage = original;
    }
  });

  it('migrates a legacy single theme choice into an explicit mode for its tone', () => {
    const original = globalThis.localStorage;
    try {
      globalThis.localStorage = {
        getItem: key => (key === 'mailflow_theme' ? 'gruvbox' : null),
      };
      assert.deepEqual(readThemePrefs(), { mode: 'dark', light: 'ink', dark: 'gruvbox' });
      globalThis.localStorage = {
        getItem: key => (key === 'mailflow_theme' ? 'parchment' : null),
      };
      assert.deepEqual(readThemePrefs(), { mode: 'light', light: 'parchment', dark: 'dark_ink' });
    } finally {
      if (original === undefined) delete globalThis.localStorage;
      else globalThis.localStorage = original;
    }
  });
});
