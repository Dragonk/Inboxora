const assert = require('node:assert/strict');
const test = require('node:test');
const settings = require('./desktop-settings.cjs');

test('reads the ProgId Windows uses for mailto out of the UserChoice key', () => {
  const key = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\mailto\\UserChoice\r\n    Hash    REG_SZ    abc\r\n    ProgId    REG_SZ    Inboxora.mailto\r\n';
  assert.equal(settings.parseMailtoUserChoice(key), 'Inboxora.mailto');
  assert.equal(
    settings.parseMailtoUserChoice('    ProgId    REG_SZ    ChromeHTML\r\n'),
    'ChromeHTML',
  );
  // No UserChoice (the user never picked one) or an unreadable key is "not us",
  // never a crash.
  assert.equal(settings.parseMailtoUserChoice(''), null);
  assert.equal(settings.parseMailtoUserChoice('ERROR: The system was unable to find the specified registry key'), null);
  assert.equal(settings.parseMailtoUserChoice('    ProgId    REG_SZ    \r\n'), null);
  assert.equal(settings.parseMailtoUserChoice(undefined), null);
});

test('only Inboxora counts as the default mailto handler', () => {
  assert.equal(settings.isDefaultMailtoHandler('Inboxora.mailto'), true);
  assert.equal(settings.isDefaultMailtoHandler('inboxora.MAILTO'), true);
  assert.equal(settings.isDefaultMailtoHandler('Outlook.URL.mailto.15'), false);
  assert.equal(settings.isDefaultMailtoHandler('Inboxora'), false);
  assert.equal(settings.isDefaultMailtoHandler(null), false);
  assert.equal(settings.isDefaultMailtoHandler(undefined), false);
});

test('describes what the user can expect in the default-app card', () => {
  assert.equal(settings.mailtoRegistrationState('win32', 'Inboxora.mailto', true), 'default');
  assert.equal(settings.mailtoRegistrationState('win32', 'Outlook.URL.mailto.15', true), 'registered');
  assert.equal(settings.mailtoRegistrationState('win32', 'Outlook.URL.mailto.15', false), 'not-registered');
  assert.equal(settings.mailtoRegistrationState('win32', null, false), 'not-registered');
  // Not Windows: nothing to configure, and no misleading "not registered".
  assert.equal(settings.mailtoRegistrationState('linux', null, false), 'unsupported');
  assert.equal(settings.mailtoRegistrationState('darwin', 'Inboxora.mailto', true), 'unsupported');
});

test('a broken registration is not reported as the working default', () => {
  // Windows still points at Inboxora, but the handler is half-written: claiming
  // "default" would also hide the repair button.
  assert.equal(settings.mailtoRegistrationState('win32', 'Inboxora.mailto', false), 'not-registered');
});

const HEALTHY_CLIENT_TREE = 'HKEY_CURRENT_USER\\Software\\Clients\\Mail\\Inboxora\r\n'
  + '    (Default)    REG_SZ    Inboxora\r\n\r\n'
  + 'HKEY_CURRENT_USER\\Software\\Clients\\Mail\\Inboxora\\Capabilities\r\n'
  + '    ApplicationName    REG_SZ    Inboxora\r\n'
  + '    ApplicationIcon    REG_SZ    C:\\Inboxora\\Inboxora.exe,0\r\n\r\n'
  + 'HKEY_CURRENT_USER\\Software\\Clients\\Mail\\Inboxora\\Capabilities\\URLAssociations\r\n'
  + '    mailto    REG_SZ    Inboxora.mailto\r\n';
const HEALTHY_REGISTERED_APPS = '    Inboxora    REG_SZ    Software\\Clients\\Mail\\Inboxora\\Capabilities\r\n';
// Deliberately Polish: the default value carries a localised label.
const HEALTHY_PROGID_COMMAND = '    (Domyślna)    REG_SZ    "C:\\Inboxora\\Inboxora.exe" "%1"\r\n';

test('the launch command is read through /ve, not through a localised label', () => {
  // reg.exe prints a translated label for the empty-named value, so the parser must
  // not depend on the literal "(Default)".
  assert.equal(settings.readRegDefaultString('    (Default)    REG_SZ    "C:\\Inboxora\\Inboxora.exe" "%1"\r\n'), '"C:\\Inboxora\\Inboxora.exe" "%1"');
  assert.equal(settings.readRegDefaultString('    (Domyślna)    REG_SZ    "C:\\Inboxora\\Inboxora.exe" "%1"\r\n'), '"C:\\Inboxora\\Inboxora.exe" "%1"');
  // Values are printed verbatim, so a command that quotes itself survives intact.
  assert.equal(settings.readRegString('    ApplicationIcon    REG_SZ    C:\\App\\a.exe,0\r\n', 'ApplicationIcon'), 'C:\\App\\a.exe,0');
  assert.equal(settings.readRegDefaultString('    (Standard)    REG_SZ    value\r\n'), 'value');
  // The key header line carries no REG_SZ and must be skipped.
  assert.equal(settings.readRegDefaultString('HKEY_CURRENT_USER\\Software\\Classes\\Inboxora.mailto\\shell\\open\\command\r\n'), null);
  assert.equal(settings.readRegDefaultString(''), null);
  assert.equal(settings.readRegDefaultString(undefined), null);
});

test('a complete registration is healthy', () => {
  assert.equal(settings.mailtoRegistrationHealth({
    clientTree: HEALTHY_CLIENT_TREE,
    registeredApplications: HEALTHY_REGISTERED_APPS,
    progIdCommand: HEALTHY_PROGID_COMMAND,
  }), true);
  // Registry paths and value names are case-insensitive.
  assert.equal(settings.mailtoRegistrationHealth({
    clientTree: HEALTHY_CLIENT_TREE.toLowerCase(),
    registeredApplications: HEALTHY_REGISTERED_APPS.toLowerCase(),
    progIdCommand: HEALTHY_PROGID_COMMAND,
  }), true);
});

test('a half-written registration is not reported as healthy', () => {
  const full = {
    clientTree: HEALTHY_CLIENT_TREE,
    registeredApplications: HEALTHY_REGISTERED_APPS,
    progIdCommand: HEALTHY_PROGID_COMMAND,
  };
  // The client key exists, but each piece is missing in turn.
  assert.equal(settings.mailtoRegistrationHealth({ ...full, registeredApplications: '' }), false);
  assert.equal(settings.mailtoRegistrationHealth({ ...full, progIdCommand: '' }), false);
  assert.equal(settings.mailtoRegistrationHealth({ ...full, clientTree: '    ApplicationName    REG_SZ    Inboxora\r\n' }), false);
  assert.equal(
    settings.mailtoRegistrationHealth({ ...full, clientTree: HEALTHY_CLIENT_TREE.replace('Inboxora.mailto', 'Other.mailto') }),
    false,
  );
  assert.equal(
    settings.mailtoRegistrationHealth({ ...full, registeredApplications: '    Inboxora    REG_SZ    Software\\Clients\\Mail\\Other\\Capabilities\r\n' }),
    false,
  );
  assert.equal(settings.mailtoRegistrationHealth(), false);
  assert.equal(settings.mailtoRegistrationHealth({}), false);
});

test('picks the per-app Default apps page on Windows 11 and the list on Windows 10', () => {
  assert.equal(settings.isWindows11('10.0.22621'), true);   // Windows 11 22H2
  assert.equal(settings.isWindows11('10.0.22000'), true);   // first Windows 11
  assert.equal(settings.isWindows11('10.0.19045'), false);  // Windows 10 22H2
  assert.equal(settings.isWindows11('11.0.1'), true);
  assert.equal(settings.isWindows11(''), false);
  assert.equal(settings.isWindows11(undefined), false);
  assert.equal(settings.isWindows11('not-a-version'), false);

  assert.equal(settings.defaultAppsSettingsUri('10.0.22621'), 'ms-settings:defaultapps?registeredAppUser=Inboxora');
  assert.equal(settings.defaultAppsSettingsUri('10.0.19045'), 'ms-settings:defaultapps');
  // The name is the RegisteredApplications value, URL-encoded.
  assert.equal(settings.defaultAppsSettingsUri('10.0.22621', 'In box'), 'ms-settings:defaultapps?registeredAppUser=In%20box');
});

test('the shell notification uses SHCNE_ASSOCCHANGED with SHCNF_IDLIST | SHCNF_FLUSH', () => {
  assert.deepEqual(settings.WINDOWS_ASSOCIATION_CHANGE_NOTIFICATION, { eventId: 0x08000000, flags: 0x1000 });
  // SHCNF_IDLIST is required for SHCNE_ASSOCCHANGED and its value is 0, so the flag
  // word is exactly SHCNF_FLUSH: the call must not return before the shell has
  // delivered the notification, or opening Default apps right after a registration
  // can still show the old list.
  assert.equal(settings.WINDOWS_ASSOCIATION_CHANGE_NOTIFICATION.flags, 0x1000);
  assert.equal(Object.isFrozen(settings.WINDOWS_ASSOCIATION_CHANGE_NOTIFICATION), true);
});

test('the registered ProgID and mail-client key are the ones the shell expects', () => {
  assert.equal(settings.MAILTO_PROG_ID, 'Inboxora.mailto');
  assert.equal(settings.WINDOWS_MAIL_CLIENT_KEY, 'HKCU\\Software\\Clients\\Mail\\Inboxora');
  assert.equal(settings.WINDOWS_REGISTERED_APPLICATIONS_KEY, 'HKCU\\Software\\RegisteredApplications');
  assert.equal(settings.MAIL_CLIENT_CAPABILITIES_PATH, 'Software\\Clients\\Mail\\Inboxora\\Capabilities');
  assert.equal(
    settings.WINDOWS_MAILTO_USER_CHOICE_KEY,
    'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\mailto\\UserChoice',
  );
});

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
