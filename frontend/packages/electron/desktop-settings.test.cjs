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

test('navigation state tolerates a missing or throwing navigation history', () => {
  assert.deepEqual(settings.readNavigationState(undefined), { canGoBack: false, canGoForward: false });
  assert.deepEqual(
    settings.readNavigationState({ canGoBack: () => true, canGoForward: () => false }),
    { canGoBack: true, canGoForward: false },
  );
  assert.deepEqual(
    settings.readNavigationState({ canGoBack() { throw new Error('destroyed'); }, canGoForward: () => true }),
    { canGoBack: false, canGoForward: false },
  );
});

test('navigation invocation only calls an existing method and reports the attempt', () => {
  const calls = [];
  const history = {
    goBack: () => calls.push('back'),
    goForward: () => calls.push('forward'),
  };

  assert.equal(settings.invokeNavigation(history, 'goBack'), true);
  assert.equal(settings.invokeNavigation(history, 'goForward'), true);
  assert.deepEqual(calls, ['back', 'forward']);

  assert.equal(settings.invokeNavigation(undefined, 'goBack'), false);
  assert.equal(settings.invokeNavigation({ goBack() { throw new Error('no entry'); } }, 'goBack'), false);
});
