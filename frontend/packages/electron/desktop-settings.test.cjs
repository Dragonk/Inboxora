const assert = require('node:assert/strict');
const test = require('node:test');
const settings = require('./desktop-settings.cjs');

test('the titlebar height is the shared layout contract (preload duplicates it)', () => {
  // preload.cjs exposes the same number as window.inboxoraNative.titlebar.height
  // and the renderer reserves that strip; a silent change here would misalign the
  // native window controls with the custom title bar.
  assert.equal(settings.TITLEBAR_HEIGHT, 48);
});

test('desktop notifications default to enabled for empty, legacy and malformed configs', () => {
  assert.deepEqual(settings.readDesktopNotificationSettings({}), { enabled: true });
  assert.deepEqual(settings.readDesktopNotificationSettings(undefined), { enabled: true });
  assert.deepEqual(settings.readDesktopNotificationSettings({ host: 'https://mail.example.com' }), { enabled: true });
  assert.deepEqual(settings.readDesktopNotificationSettings({ desktopNotifications: null }), { enabled: true });
  assert.deepEqual(settings.readDesktopNotificationSettings({ desktopNotifications: { enabled: 'no' } }), { enabled: true });
});

test('desktop notifications honor an explicit boolean and never mutate the input config', () => {
  const config = { host: 'https://mail.example.com', desktopNotifications: { enabled: true } };
  const disabled = settings.withDesktopNotificationEnabled(config, false);
  const enabled = settings.withDesktopNotificationEnabled(disabled, true);

  assert.deepEqual(config.desktopNotifications, { enabled: true });
  assert.deepEqual(disabled, { host: 'https://mail.example.com', desktopNotifications: { enabled: false } });
  assert.deepEqual(enabled.desktopNotifications, { enabled: true });
  assert.deepEqual(settings.readDesktopNotificationSettings(disabled), { enabled: false });
});

test('desktop notifications stay disabled for non-boolean truthy values', () => {
  for (const value of ['true', 1, {}, [], 'yes']) {
    assert.deepEqual(
      settings.withDesktopNotificationEnabled({}, value).desktopNotifications,
      { enabled: false },
      `expected ${JSON.stringify(value)} not to enable notifications`,
    );
  }
});

test('titlebar theme accepts only opaque lowercase hex colors', () => {
  assert.deepEqual(
    settings.normalizeTitlebarTheme({ color: ' #1F2024 ', symbolColor: '#FFFFFF' }),
    { color: '#1f2024', symbolColor: '#ffffff' },
  );
});

test('titlebar theme rejects partial, named, gradient and non-object values', () => {
  for (const value of [
    null,
    'black',
    {},
    { color: '#fff', symbolColor: '#fff' },
    { color: 'rgba(0,0,0,0.5)', symbolColor: '#ffffff' },
    { color: '#1f2024', symbolColor: 'white' },
    { color: '#1f2024;background:url(x)', symbolColor: '#ffffff' },
  ]) {
    assert.equal(settings.normalizeTitlebarTheme(value), null, `expected ${JSON.stringify(value)} to be rejected`);
  }
});

test('titlebar theme falls back to the dark default and round-trips through the config', () => {
  assert.deepEqual(settings.readTitlebarTheme({}), { ...settings.DEFAULT_TITLEBAR_THEME });
  assert.deepEqual(settings.readTitlebarTheme({ titlebarTheme: { color: 'nope' } }), { ...settings.DEFAULT_TITLEBAR_THEME });

  const updated = settings.withTitlebarTheme({ host: 'https://mail.example.com' }, { color: '#f6f5f1', symbolColor: '#000000' });
  assert.deepEqual(updated, {
    host: 'https://mail.example.com',
    titlebarTheme: { color: '#f6f5f1', symbolColor: '#000000' },
  });
  assert.equal(settings.withTitlebarTheme({}, { color: 'red', symbolColor: 'blue' }), null);
});

test('Windows and Linux hide the application menu bar and draw an overlay; macOS keeps both native', () => {
  for (const platform of ['win32', 'linux']) {
    assert.equal(settings.keepsApplicationMenuBar(platform), false);
    assert.equal(settings.usesTitleBarOverlay(platform), true);
  }
  assert.equal(settings.keepsApplicationMenuBar('darwin'), true);
  assert.equal(settings.usesTitleBarOverlay('darwin'), false);
});

test('test notification payloads are trimmed, collapsed and length-bounded', () => {
  assert.deepEqual(
    settings.normalizeTestNotification({ title: '  Inboxora\n', body: 'System   notifications work.' }),
    { title: 'Inboxora', body: 'System notifications work.' },
  );

  const long = settings.normalizeTestNotification({ title: 'x'.repeat(500), body: '' });
  assert.equal(long.title.length, 200);
  assert.equal(long.title.endsWith('…'), true);

  assert.deepEqual(
    settings.normalizeTestNotification(undefined, { title: 'Inboxora', body: 'Fallback' }),
    { title: 'Inboxora', body: 'Fallback' },
  );
  assert.equal(settings.normalizeTestNotification(null), null);
});

test('reads the Windows notification state that Notification.isSupported() cannot report', () => {
  const enabled = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\io.github.dragonk.inboxora\r\n    Enabled    REG_DWORD    0x1\r\n';
  const disabled = '    Enabled    REG_DWORD    0x0\r\n';
  const globalOn = '    ToastEnabled    REG_DWORD    0x1\r\n';
  const globalOff = '    ToastEnabled    REG_DWORD    0x0\r\n';

  // Per-app setting wins, and a globally disabled toast surface blocks everything.
  assert.equal(settings.parseWindowsNotificationsEnabled(enabled, globalOn), true);
  assert.equal(settings.parseWindowsNotificationsEnabled(disabled, globalOn), false);
  assert.equal(settings.parseWindowsNotificationsEnabled(enabled, globalOff), false);
  assert.equal(settings.parseWindowsNotificationsEnabled(disabled, globalOff), false);

  // Inboxora has no per-app value yet: inherit the global one.
  assert.equal(settings.parseWindowsNotificationsEnabled('', globalOn), true);
  assert.equal(settings.parseWindowsNotificationsEnabled('', globalOff), false);

  // Neither key present (or unreadable output) is "unknown", never "blocked".
  assert.equal(settings.parseWindowsNotificationsEnabled('', ''), null);
  assert.equal(settings.parseWindowsNotificationsEnabled(undefined, undefined), null);
  assert.equal(
    settings.parseWindowsNotificationsEnabled('ERROR: The system was unable to find the specified registry key', ''),
    null,
  );
});

test('Windows registry parsing ignores a stray value that only looks similar', () => {
  // "Disabled" must not satisfy the "Enabled" match, and a REG_SZ is not a DWORD.
  assert.equal(settings.parseWindowsNotificationsEnabled('    Disabled    REG_DWORD    0x0', ''), null);
  assert.equal(settings.parseWindowsNotificationsEnabled('    Enabled    REG_SZ    0', ''), null);
});

test('a zero DWORD written with leading zeros is still zero', () => {
  // `reg query` prints DWORDs zero-padded, so 0x00000000 must not read as non-zero
  // (and 0x00000001 must read as enabled).
  assert.equal(settings.parseWindowsNotificationsEnabled('    Enabled    REG_DWORD    0x00000000', ''), false);
  assert.equal(settings.parseWindowsNotificationsEnabled('    Enabled    REG_DWORD    0x00000001', ''), true);
  assert.equal(settings.parseWindowsNotificationsEnabled('', '    ToastEnabled    REG_DWORD    0x00000000'), false);
  assert.equal(settings.parseWindowsNotificationsEnabled('', '    ToastEnabled    REG_DWORD    0x00000001'), true);
  assert.equal(settings.parseWindowsNotificationsEnabled('    Enabled    REG_DWORD    0x0000000A', ''), true);
});
