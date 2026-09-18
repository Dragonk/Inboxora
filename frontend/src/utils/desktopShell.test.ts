import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_DESKTOP_TITLEBAR_HEIGHT,
  desktopTitlebarHeight,
  isElectronShell,
  parseCssColor,
  relativeLuminance,
  titlebarThemeForBackground,
} from './desktopShell.ts';

function withWindow<T>(value: unknown, run: () => T): T {
  const original = globalThis.window;
  try {
    // @ts-expect-error - a partial test double is enough here.
    globalThis.window = value;
    return run();
  } finally {
    globalThis.window = original as unknown as Window & typeof globalThis;
  }
}

test('only the Electron shell is detected as desktop, never the web or Capacitor build', () => {
  assert.equal(withWindow(undefined, isElectronShell), false);
  assert.equal(withWindow({}, isElectronShell), false);
  // Capacitor Android exposes the same inboxoraNative object without `shell`.
  assert.equal(withWindow({ inboxoraNative: { platform: 'android' } }, isElectronShell), false);
  assert.equal(withWindow({ inboxoraNative: { shell: 'capacitor' } }, isElectronShell), false);
  assert.equal(withWindow({ inboxoraNative: { shell: 'electron' } }, isElectronShell), true);
});

test('the titlebar height contract matches the Electron shell', () => {
  assert.equal(DEFAULT_DESKTOP_TITLEBAR_HEIGHT, 48);
});

test('titlebar height comes from the native bridge when present', () => {
  assert.equal(withWindow({ inboxoraNative: { titlebar: { height: 48 } } }, desktopTitlebarHeight), 48);
  assert.equal(
    withWindow({ inboxoraNative: { titlebar: { height: 'tall' } } }, desktopTitlebarHeight),
    DEFAULT_DESKTOP_TITLEBAR_HEIGHT,
  );
  assert.equal(withWindow({}, desktopTitlebarHeight), DEFAULT_DESKTOP_TITLEBAR_HEIGHT);
});

test('parses the CSS color shapes the theme variables resolve to', () => {
  assert.deepEqual(parseCssColor('#0f0f11'), { r: 15, g: 15, b: 17 });
  assert.deepEqual(parseCssColor('  #FFF '), { r: 255, g: 255, b: 255 });
  assert.deepEqual(parseCssColor('rgb(246, 245, 241)'), { r: 246, g: 245, b: 241 });
  assert.deepEqual(parseCssColor('rgba(20,23,28,0.98)'), { r: 20, g: 23, b: 28 });
});

test('rejects colors it cannot reason about instead of guessing', () => {
  for (const value of ['', ' ', 'black', 'var(--bg-primary)', 'linear-gradient(#000, #fff)', '#12345', 'rgb(a,b,c)']) {
    assert.equal(parseCssColor(value), null, `expected ${JSON.stringify(value)} to be rejected`);
  }
});

test('relative luminance ranks the Inboxora light and dark surfaces', () => {
  assert.ok(relativeLuminance({ r: 246, g: 245, b: 241 }) > 0.4);
  assert.ok(relativeLuminance({ r: 15, g: 15, b: 17 }) < 0.4);
  assert.ok(relativeLuminance({ r: 255, g: 255, b: 255 }) > relativeLuminance({ r: 0, g: 0, b: 0 }));
});

test('picks dark window-control symbols on a light bar and light symbols on a dark bar', () => {
  assert.deepEqual(titlebarThemeForBackground('#f6f5f1'), { color: '#f6f5f1', symbolColor: '#000000' });
  assert.deepEqual(titlebarThemeForBackground('#0f0f11'), { color: '#0f0f11', symbolColor: '#ffffff' });
  assert.deepEqual(
    titlebarThemeForBackground('rgb(29, 32, 33)'),
    { color: '#1d2021', symbolColor: '#ffffff' },
  );
});

test('returns null for an unusable background so the last good overlay stays', () => {
  assert.equal(titlebarThemeForBackground(''), null);
  assert.equal(titlebarThemeForBackground('var(--bg-primary)'), null);
  assert.equal(titlebarThemeForBackground(undefined), null);
});
