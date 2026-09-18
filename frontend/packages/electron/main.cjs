const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, shell, dialog, Notification, session, clipboard } = require('electron');
const { execFileSync, spawn, spawnSync } = require('child_process');
const os = require('os');
const { createHash } = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { pathToFileURL } = require('url');
const {
  createNavigationPolicy,
  hasMatchingMacTeam,
  hasMatchingWindowsPublisher,
  isSameOrigin,
  normalizeHost,
} = require('./security.cjs');
const {
  MAILTO_PROG_ID,
  TITLEBAR_HEIGHT,
  WINDOWS_ASSOCIATION_CHANGE_NOTIFICATION,
  WINDOWS_MAIL_CLIENT_KEY,
  WINDOWS_MAILTO_USER_CHOICE_KEY,
  WINDOWS_REGISTERED_APPLICATIONS_KEY,
  defaultAppsSettingsUri,
  isDefaultMailtoHandler,
  keepsApplicationMenuBar,
  mailtoRegistrationHealth,
  mailtoRegistrationState,
  normalizeTestNotification,
  parseMailtoUserChoice,
  parseWindowsNotificationsEnabled,
  readDesktopNotificationSettings,
  readTitlebarTheme,
  usesTitleBarOverlay,
  withDesktopNotificationEnabled,
  withTitlebarTheme,
} = require('./desktop-settings.cjs');

const CONFIG_FILE = 'inboxora-host.json';
const UPDATE_STATUS_CHANNEL = 'inboxora:updates:status';
const UPDATE_RELEASE_URL = 'https://api.github.com/repos/Dragonk/Inboxora/releases/latest';


const UPDATE_ERROR_MESSAGE = 'Could not check for Inboxora updates. Please visit the website instead.';
const NATIVE_ACTION_CHANNEL = 'inboxora:native-action';
const NATIVE_ACTION_ARG = '--inboxora-action=';
const NEW_MAIL_NOTIFICATION_MAX_LENGTH = 240;
// The Windows AppUserModelID. It is both what the app registers with and the
// registry key Windows stores per-app notification settings under, so the two
// must never drift apart.
const APP_USER_MODEL_ID = 'io.github.dragonk.inboxora';
// How long a registration waits for the shell notification before giving up on it.
const SHELL_NOTIFY_TIMEOUT_MS = 2000;
// How long to wait for Electron's 'show' / 'failed' after calling show() on a test
// notification. Some desktops raise neither, which is reported as unconfirmed.
const TEST_NOTIFICATION_TIMEOUT_MS = 4000;
// What the Windows Settings app writes. `Notification.isSupported()` only reports
// that the process *can* notify, not that Windows will actually display it.
const WINDOWS_NOTIFICATION_APP_KEY = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\${APP_USER_MODEL_ID}`;
const WINDOWS_NOTIFICATION_GLOBAL_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications';
const MAILTO_PROTOCOL = 'mailto';
const EXTERNAL_LINK_PROTOCOLS = new Set(['http:', 'https:', `${MAILTO_PROTOCOL}:`]);
const REWRITE_ERROR_PATTERNS = [
  /Rewrite\s+502\s+Bad\s+Gateway\s+Page/i,
  /Rewrite\s+404\s+Error\s+Page/i,
];
const HOST_UNAVAILABLE_STATUS_CODES = new Set([404, 502, 503, 504]);
const LINUX_BADGE_DESKTOP_IDS = [
  'Inboxora.desktop',
  'mailflow.desktop',
  'io.github.dragonk.inboxora.desktop',
  'mailflow-frontend.desktop',
];

let mainWindow;
let tray = null;
let isQuitting = false;
let updateInfo = null;
let downloadedUpdate = null;
let pendingUpdateDownloadUrl = null;
let updateDownloadsInitialized = false;
let nextNativeActionId = 1;

function isAllowedExternalUrl(url) {
  try {
    return EXTERNAL_LINK_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}
const pendingNativeActions = new Map();
const pendingProtocolUrls = [];

app.setName('Inboxora');
if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}
if (process.platform === 'linux' && typeof app.setDesktopName === 'function') {
  app.setDesktopName('Inboxora.desktop');
}

if (process.platform === 'linux' && process.env.APPIMAGE) {
  app.commandLine.appendSwitch('no-sandbox');
}

// The command Windows should run for a mailto: link. In development the handler has
// to launch Electron with the app path, not just the Electron binary.
function mailtoLaunchCommand() {
  if (process.defaultApp && process.argv.length >= 2) {
    return `"${process.execPath}" "${path.resolve(process.argv[1])}" "%1"`;
  }
  return `"${process.execPath}" "%1"`;
}

function registerMailtoProtocol() {
  // Windows is handled entirely by our own ProgID plus the RegisteredApplications
  // entry: Electron's setAsDefaultProtocolClient() would write a second, legacy
  // HKCU\Software\Classes\mailto command that the uninstaller cannot recognise, and
  // simply launching the app would claim the generic key instead of only offering
  // Inboxora as a choice.
  if (process.platform === 'win32') {
    return registerWindowsMailtoCapabilities();
  }

  try {
    if (process.defaultApp && process.argv.length >= 2) {
      return app.setAsDefaultProtocolClient(MAILTO_PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
    }

    return app.setAsDefaultProtocolClient(MAILTO_PROTOCOL);
  } catch (error) {
    console.error('Could not register mailto protocol handler:', error);
    return false;
  }
}

function writeCurrentUserRegValue(key, name, value) {
  const args = ['add', key, name ? '/v' : '/ve'];
  if (name) args.push(name);
  args.push('/t', 'REG_SZ', '/d', value, '/f');
  execFileSync('reg', args, { stdio: 'ignore', windowsHide: true });
}

function registerWindowsMailtoCapabilities() {
  if (process.platform !== 'win32') return false;

  try {
    const exePath = process.execPath;
    const command = mailtoLaunchCommand();

    // The Capabilities key is what makes Inboxora appear as an email client under
    // Windows Settings -> Default apps; the ProgID is what mailto: resolves to. Both
    // are needed for the user to be able to pick Inboxora for mail and email links.
    writeCurrentUserRegValue(WINDOWS_REGISTERED_APPLICATIONS_KEY, 'Inboxora', 'Software\\Clients\\Mail\\Inboxora\\Capabilities');
    writeCurrentUserRegValue(WINDOWS_MAIL_CLIENT_KEY, '', 'Inboxora');
    writeCurrentUserRegValue(`${WINDOWS_MAIL_CLIENT_KEY}\\Capabilities`, 'ApplicationName', 'Inboxora');
    writeCurrentUserRegValue(`${WINDOWS_MAIL_CLIENT_KEY}\\Capabilities`, 'ApplicationDescription', 'A self-hosted, unified webmail client.');
    writeCurrentUserRegValue(`${WINDOWS_MAIL_CLIENT_KEY}\\Capabilities`, 'ApplicationIcon', `${exePath},0`);
    writeCurrentUserRegValue(`${WINDOWS_MAIL_CLIENT_KEY}\\Capabilities\\URLAssociations`, MAILTO_PROTOCOL, MAILTO_PROG_ID);
    writeCurrentUserRegValue(`HKCU\\Software\\Classes\\${MAILTO_PROG_ID}`, '', 'URL:Inboxora MailTo Protocol');
    writeCurrentUserRegValue(`HKCU\\Software\\Classes\\${MAILTO_PROG_ID}`, 'URL Protocol', '');
    writeCurrentUserRegValue(`HKCU\\Software\\Classes\\${MAILTO_PROG_ID}\\DefaultIcon`, '', `${exePath},0`);
    writeCurrentUserRegValue(`HKCU\\Software\\Classes\\${MAILTO_PROG_ID}\\shell\\open\\command`, '', command);

    return true;
  } catch (error) {
    console.error('Could not register Windows mailto capabilities:', error);
    return false;
  }
}

// Windows 10/11 keep the user's choice in UserChoice\ProgId and refuse to let an
// app make itself the default, so the settings card can only report the state,
// (re-)register Inboxora as an available handler and send the user to Settings.
function readMailtoSettings() {
  if (process.platform !== 'win32') {
    return {
      supported: false,
      state: mailtoRegistrationState(process.platform, null, false),
      isDefault: false,
      currentHandler: null,
      settingsUri: null,
      canOpenSettings: false,
      requiresUserConfirmation: false,
    };
  }

  const userChoice = parseMailtoUserChoice(
    queryWindowsRegistry(WINDOWS_MAILTO_USER_CHOICE_KEY, { valueName: 'ProgId' }),
  );
  // Complete, not merely present: a half-written registration must not be reported
  // as "registered".
  const registered = mailtoRegistrationHealth({
    clientTree: queryWindowsRegistry(WINDOWS_MAIL_CLIENT_KEY, { recursive: true }),
    registeredApplications: queryWindowsRegistry(WINDOWS_REGISTERED_APPLICATIONS_KEY),
    progIdCommand: queryWindowsRegistry(`HKCU\\Software\\Classes\\${MAILTO_PROG_ID}\\shell\\open\\command`, { defaultValue: true }),
  });

  return {
    supported: true,
    state: mailtoRegistrationState('win32', userChoice, registered),
    isDefault: registered && isDefaultMailtoHandler(userChoice),
    currentHandler: userChoice,
    settingsUri: defaultAppsSettingsUri(os.release()),
    canOpenSettings: true,
    // An app cannot set itself as the default handler on Windows 10/11.
    requiresUserConfirmation: true,
  };
}

// Windows caches shell associations. Without SHChangeNotify(SHCNE_ASSOCCHANGED) the
// Default apps page can keep showing the state from before the registration. There is
// no Node binding for shell32, so this is a PowerShell P/Invoke with SHCNF_FLUSH —
// which does not return until the shell has delivered the notification.
//
// It resolves when the helper exits, or after SHELL_NOTIFY_TIMEOUT_MS, so a
// registration can wait for it without ever hanging on a broken PowerShell (blocked
// by policy, machine under load). Failure is reported, never fatal.
function notifyWindowsShellOfAssociationChange() {
  if (process.platform !== 'win32') return Promise.resolve(false);

  const { eventId, flags } = WINDOWS_ASSOCIATION_CHANGE_NOTIFICATION;
  const script = [
    "$sig = '[DllImport(\"shell32.dll\")] public static extern void SHChangeNotify(int eventId, uint flags, IntPtr item1, IntPtr item2);'",
    "Add-Type -Namespace Inboxora -Name Shell32 -MemberDefinition $sig",
    `[Inboxora.Shell32]::SHChangeNotify(${eventId}, ${flags}, [IntPtr]::Zero, [IntPtr]::Zero)`,
  ].join('; ');

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (notified) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(notified);
    };

    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch (error) {
      console.error('Could not notify the Windows shell about the mail handler change:', error);
      finish(false);
      return;
    }

    // Deliberately not unref()'d: the caller waits for this, bounded by the timeout.
    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
      finish(false);
    }, SHELL_NOTIFY_TIMEOUT_MS);

    child.on('error', () => finish(false));
    child.on('exit', (code) => finish(code === 0));
  });
}

// Async so the caller's "register, then open Default apps" cannot race the shell
// notification: by the time the renderer opens the page, the shell has been told.
async function registerAsMailtoHandler() {
  if (process.platform !== 'win32') return readMailtoSettings();

  registerMailtoProtocol();
  const notified = await notifyWindowsShellOfAssociationChange();
  if (!notified) {
    console.warn('The Windows shell was not notified about the mail handler change.');
  }
  return readMailtoSettings();
}

async function openDefaultAppsSettings() {
  if (process.platform !== 'win32') return { opened: false, uri: null };

  const uri = defaultAppsSettingsUri(os.release());
  try {
    await shell.openExternal(uri);
    return { opened: true, uri };
  } catch (error) {
    console.error('Could not open the Windows default apps settings:', error);
    return { opened: false, uri };
  }
}

function getIconPath() {
  return path.join(__dirname, 'icons', 'icon.png');
}

function getWindowIconPath() {
  if (process.platform === 'win32') return path.join(__dirname, 'icons', 'icon.ico');
  if (process.platform === 'linux') return getIconPath();
  return undefined;
}

function getConfigPath() {
  return path.join(app.getPath('userData'), CONFIG_FILE);
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(getConfigPath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(config) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

function readHost() {
  try {
    const config = readConfig();
    return normalizeHost(config.host);
  } catch {
    return null;
  }
}

function writeHost(host) {
  const normalized = normalizeHost(host);
  writeConfig({ ...readConfig(), host: normalized });
  return normalized;
}

function clearHost() {
  const config = readConfig();
  delete config.host;
  writeConfig(config);
}

// The main process is the source of truth for the desktop notification
// preference: the renderer only asks, and every notification path re-reads it.
// This is the cheap config-only read used on the notification hot path.
function readNotificationPreference() {
  return readDesktopNotificationSettings(readConfig());
}

// What the operating system itself thinks. Only Windows exposes this without an
// extra dependency; elsewhere the honest answer is "unknown", which the settings
// card words differently from "active".
function readOsNotificationState() {
  if (!Notification.isSupported()) return 'unsupported';
  if (process.platform !== 'win32') return 'unknown';

  const enabled = parseWindowsNotificationsEnabled(
    queryWindowsRegistry(WINDOWS_NOTIFICATION_APP_KEY),
    queryWindowsRegistry(WINDOWS_NOTIFICATION_GLOBAL_KEY),
  );
  if (enabled === false) return 'disabled';
  if (enabled === true) return 'enabled';
  return 'unknown';
}

// A missing key or value is normal (the user never changed the default), so an
// unreadable query is "no data" rather than an error. `defaultValue` asks for the
// empty-named value with `/ve`, so the result never depends on the localised label
// reg.exe prints for it ("(Default)", "(Domyślna)", ...).
function queryWindowsRegistry(key, { valueName, defaultValue = false, recursive = false } = {}) {
  try {
    const args = ['query', key];
    if (defaultValue) args.push('/ve');
    else if (valueName) args.push('/v', valueName);
    if (recursive) args.push('/s');
    return execFileSync('reg', args, { encoding: 'utf8', windowsHide: true });
  } catch {
    return '';
  }
}

function canOpenSystemNotificationSettings() {
  return process.platform === 'win32' || process.platform === 'darwin';
}

// The full view the settings screen needs. It probes the registry, so it is not
// used on the new-mail path.
function getDesktopNotificationSettings() {
  return {
    ...readNotificationPreference(),
    supported: Notification.isSupported(),
    osState: readOsNotificationState(),
    canOpenSystemSettings: canOpenSystemNotificationSettings(),
  };
}

function setDesktopNotificationEnabled(enabled) {
  const config = withDesktopNotificationEnabled(readConfig(), enabled);
  writeConfig(config);
  return getDesktopNotificationSettings();
}

function getTitlebarTheme() {
  return readTitlebarTheme(readConfig());
}

function persistTitlebarTheme(theme) {
  const config = withTitlebarTheme(readConfig(), theme);
  if (!config) return null;
  writeConfig(config);
  return readTitlebarTheme(config);
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `Inboxora/${app.getVersion()}`,
      },
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        requestJson(response.headers.location).then(resolve, reject);
        return;
      }

      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Update request failed with status ${response.statusCode}`));
          return;
        }

        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });

    request.on('error', reject);
    request.setTimeout(15000, () => {
      request.destroy(new Error('Update request timed out'));
    });
  });
}

function parseVersion(value) {
  const match = String(value || '').match(/\d+(?:\.\d+){0,2}/);
  if (!match) return null;
  return match[0].split('.').map((part) => Number.parseInt(part, 10));
}

function isNewerVersion(candidate, current) {
  const next = parseVersion(candidate);
  const installed = parseVersion(current);
  if (!next || !installed) return false;

  for (let index = 0; index < 3; index += 1) {
    const nextPart = next[index] || 0;
    const installedPart = installed[index] || 0;
    if (nextPart > installedPart) return true;
    if (nextPart < installedPart) return false;
  }

  return false;
}

function getLinuxDistributionIds() {
  if (process.platform !== 'linux') return [];

  try {
    const osRelease = fs.readFileSync('/etc/os-release', 'utf8');
    const ids = [];

    for (const key of ['ID', 'ID_LIKE']) {
      const match = osRelease.match(new RegExp(`^${key}=(.+)$`, 'm'));
      if (!match) continue;

      const values = match[1]
        .replace(/^"|"$/g, '')
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
      ids.push(...values);
    }

    return ids;
  } catch {
    return [];
  }
}

function isDebLikeLinuxDistribution(distroIds = getLinuxDistributionIds()) {
  return distroIds.some((id) => ['debian', 'ubuntu', 'linuxmint', 'pop'].some((match) => id === match || id.includes(match)));
}

function isRpmLikeLinuxDistribution(distroIds = getLinuxDistributionIds()) {
  return distroIds.some((id) => ['fedora', 'rhel', 'centos', 'rocky', 'almalinux', 'suse', 'opensuse'].some((match) => id === match || id.includes(match)));
}

function getInstalledLinuxPackageType() {
  if (process.platform !== 'linux') return null;
  if (process.env.APPIMAGE) return 'appimage';

  try {
    const packageType = fs.readFileSync(path.join(process.resourcesPath, 'package-type'), 'utf8').trim().toLowerCase();
    if (['deb', 'rpm', 'appimage'].includes(packageType)) return packageType;
  } catch {}

  if (getLinuxPackageManagerVersion('rpm')) return 'rpm';
  if (getLinuxPackageManagerVersion('deb')) return 'deb';

  const distroIds = getLinuxDistributionIds();
  if (isRpmLikeLinuxDistribution(distroIds) || getAvailableCommand(['rpm', 'dnf', 'dnf5', 'yum'])) return 'rpm';
  if (isDebLikeLinuxDistribution(distroIds) || getAvailableCommand(['dpkg', 'apt', 'apt-get'])) return 'deb';

  return null;
}

function getLinuxPackageManagerVersion(packageType) {
  if (process.platform !== 'linux' || !['deb', 'rpm'].includes(packageType)) return null;

  const packageNames = ['mailflow', 'Inboxora', 'mailflow-frontend'];
  for (const packageName of packageNames) {
    try {
      const args = packageType === 'rpm'
        ? ['-q', '--qf', '%{VERSION}', packageName]
        : ['-W', '-f=${Version}', packageName];
      const command = packageType === 'rpm' ? 'rpm' : 'dpkg-query';
      const output = execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (output) return output;
    } catch {}
  }

  return null;
}

function getInstalledAppVersion(packageType = getInstalledLinuxPackageType()) {
  return getLinuxPackageManagerVersion(packageType) || app.getVersion();
}

function getAvailableCommand(commands = []) {
  for (const command of commands) {
    try {
      const output = execFileSync('which', [command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (output) return command;
    } catch {}
  }

  return null;
}

function emitUnityLauncherBadgeCount(count) {
  if (process.platform !== 'linux') return false;

  const gdbus = getAvailableCommand(['gdbus']);
  if (!gdbus) return false;

  const visible = count > 0;
  const properties = visible
    ? `{'count': <int64 ${count}>, 'count-visible': <true>}`
    : `{'count': <int64 0>, 'count-visible': <false>}`;

  for (const desktopId of LINUX_BADGE_DESKTOP_IDS) {
    const child = spawn(gdbus, [
      'emit',
      '--session',
      '--object-path',
      '/',
      '--signal',
      'com.canonical.Unity.LauncherEntry.Update',
      `application://${desktopId}`,
      properties,
    ], {
      detached: true,
      stdio: 'ignore',
    });

    child.unref();
  }

  return true;
}

function setUnreadBadgeCount(count) {
  let badgeSet = false;

  if (typeof app.setBadgeCount === 'function') {
    badgeSet = app.setBadgeCount(count);
  }

  return emitUnityLauncherBadgeCount(count) || badgeSet;
}

function getLinuxPackagePatternGroups() {
  const arch = process.arch === 'arm64'
    ? '(?:arm64|aarch64)'
    : '(?:amd64|x64|x86_64)';
  const deb = [new RegExp(`${arch}\\.deb$`, 'i'), /\.deb$/i];
  const rpm = [new RegExp(`${arch}\\.rpm$`, 'i'), /\.rpm$/i];

  const installedPackageType = getInstalledLinuxPackageType();
  if (installedPackageType === 'appimage') return [];
  if (installedPackageType === 'deb') return [deb];
  if (installedPackageType === 'rpm') return [rpm];

  const distroIds = getLinuxDistributionIds();
  if (isDebLikeLinuxDistribution(distroIds)) {
    return [deb];
  }
  if (isRpmLikeLinuxDistribution(distroIds)) {
    return [rpm];
  }

  if (getAvailableCommand(['rpm', 'dnf', 'dnf5', 'yum'])) return [rpm];
  if (getAvailableCommand(['dpkg', 'apt', 'apt-get'])) return [deb];

  return [];
}

function getUpdateAsset(release) {
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const platformAssetPatternGroups = {
    win32: [[/setup.*\.exe$/i], [/\.exe$/i]],
    darwin: [[/\.dmg$/i]],
    linux: getLinuxPackagePatternGroups(),
  };
  const patternGroups = platformAssetPatternGroups[process.platform] || [];

  for (const patterns of patternGroups) {
    for (const pattern of patterns) {
      const asset = assets.find((item) => pattern.test(item.name || '') && item.browser_download_url);
      if (asset) return asset;
    }
  }

  return null;
}

function sendUpdateStatus(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(UPDATE_STATUS_CHANNEL, payload);
}

function showInAppNotification({ title = '', message = '', type = 'info', actionLabel = '', action = '', persistent = false }) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const payload = JSON.stringify({ title, message, type, actionLabel, action, persistent });
  mainWindow.webContents.executeJavaScript(`
    (() => {
      if (window.__inboxoraNativeBridgeReady) return;

      const notification = ${payload};
      const id = 'mailflow-electron-toasts';
      let root = document.getElementById(id);

      if (!root) {
        root = document.createElement('div');
        root.id = id;
        root.style.position = 'fixed';
        root.style.right = '24px';
        root.style.bottom = '24px';
        root.style.zIndex = '2147483647';
        root.style.display = 'flex';
        root.style.flexDirection = 'column-reverse';
        root.style.gap = '8px';
        root.style.pointerEvents = 'none';
        document.documentElement.appendChild(root);
      }

      const toast = document.createElement('div');
      toast.style.width = '340px';
      toast.style.maxWidth = 'calc(100vw - 48px)';
      toast.style.boxSizing = 'border-box';
      toast.style.display = 'flex';
      toast.style.alignItems = 'flex-start';
      toast.style.gap = '10px';
      toast.style.padding = '12px 14px';
      toast.style.borderRadius = '10px';
      toast.style.border = '1px solid rgba(255,255,255,0.10)';
      toast.style.background = 'rgba(36,36,41,0.98)';
      toast.style.boxShadow = '0 4px 20px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.04)';
      toast.style.color = '#e8e8ed';
      toast.style.font = '13px Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      toast.style.pointerEvents = 'all';
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(100%)';
      toast.style.transition = 'opacity 180ms ease, transform 180ms ease';

      const icon = document.createElement('div');
      icon.style.width = '32px';
      icon.style.height = '32px';
      icon.style.borderRadius = '8px';
      icon.style.flex = '0 0 auto';
      icon.style.display = 'grid';
      icon.style.placeItems = 'center';
      icon.style.background = notification.type === 'negative' || notification.type === 'error'
        ? 'rgba(248,113,113,0.15)'
        : 'rgba(124,106,247,0.28)';
      icon.style.color = notification.type === 'negative' || notification.type === 'error' ? '#f87171' : '#a99cff';
      icon.textContent = notification.type === 'positive' ? '✓' : notification.type === 'negative' || notification.type === 'error' ? '!' : 'i';

      const copy = document.createElement('div');
      copy.style.flex = '1';
      copy.style.minWidth = '0';

      const heading = document.createElement('div');
      heading.textContent = notification.title;
      heading.style.fontWeight = '650';
      heading.style.marginBottom = '2px';
      heading.style.whiteSpace = 'nowrap';
      heading.style.overflow = 'hidden';
      heading.style.textOverflow = 'ellipsis';

      const body = document.createElement('div');
      body.textContent = notification.message;
      body.style.fontSize = '12px';
      body.style.color = '#9898a8';
      body.style.whiteSpace = 'pre-wrap';
      body.style.overflow = 'visible';
      body.style.textOverflow = 'clip';
      body.style.lineHeight = '1.35';

      const close = document.createElement('button');
      close.type = 'button';
      close.setAttribute('aria-label', 'Dismiss');
      close.textContent = '×';
      close.style.border = '0';
      close.style.background = 'transparent';
      close.style.color = '#9898a8';
      close.style.cursor = 'pointer';
      close.style.font = '20px/1 Inter, ui-sans-serif, system-ui';
      close.style.padding = '0';

      let action = null;
      if (notification.actionLabel && notification.action) {
        action = document.createElement('button');
        action.type = 'button';
        action.textContent = notification.actionLabel;
        action.style.border = '1px solid rgba(255,255,255,0.12)';
        action.style.borderRadius = '6px';
        action.style.background = 'rgba(255,255,255,0.08)';
        action.style.color = '#e8e8ed';
        action.style.cursor = 'pointer';
        action.style.font = '600 12px Inter, ui-sans-serif, system-ui';
        action.style.padding = '5px 10px';
        action.style.flex = '0 0 auto';
        action.addEventListener('click', () => {
          if (notification.action === 'install-update') {
            window.inboxoraNative?.updates?.installDownloaded?.();
          } else if (notification.action === 'copy-update-command-and-quit') {
            window.inboxoraNative?.updates?.copyInstallCommandAndQuit?.();
          }
          dismiss();
        });
      }

      const dismiss = () => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        window.setTimeout(() => toast.remove(), 190);
      };

      close.addEventListener('click', dismiss);
      copy.append(heading, body);
      toast.append(icon, copy);
      if (action) toast.appendChild(action);
      toast.appendChild(close);
      root.appendChild(toast);

      window.requestAnimationFrame(() => {
        toast.style.opacity = '1';
        toast.style.transform = 'translateX(0)';
      });

      if (!notification.persistent) {
        window.setTimeout(dismiss, 5000);
      }
    })();
  `).catch(() => {});
}

function notifyUpdateStatus({ title, message, type = 'info' }) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  showInAppNotification({ title, message, type });
  mainWindow.webContents.send('inboxora:notifications:push', { title, message, type });
}

function cleanNotificationText(value, fallback = '') {
  const text = String(value || fallback)
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length <= NEW_MAIL_NOTIFICATION_MAX_LENGTH) return text;
  return `${text.slice(0, NEW_MAIL_NOTIFICATION_MAX_LENGTH - 1)}…`;
}

function requestInboxoraApi(url, { method, body } = {}) {
  return session.defaultSession.cookies.get({ url: readHost() })
    .then((cookies) => new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const request = (parsedUrl.protocol === 'http:' ? http : https).request(parsedUrl, {
        method,
        headers: {
          Accept: 'application/json',
          Cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
      }, (response) => {
        response.resume();
        response.on('end', () => {
          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve();
            return;
          }

          reject(new Error(`Mail action failed with status ${response.statusCode}`));
        });
      });

      request.on('error', reject);
      if (body) request.write(JSON.stringify(body));
      request.end();
    }));
}

function runBackgroundMailAction(action, messageId) {
  const host = readHost();
  if (!host || !messageId) return Promise.resolve();

  const encodedMessageId = encodeURIComponent(messageId);
  if (action === 'delete-message') {
    return requestInboxoraApi(`${host}/api/mail/messages/${encodedMessageId}`, {
      method: 'DELETE',
    });
  }

  if (action === 'star-message') {
    return requestInboxoraApi(`${host}/api/mail/messages/${encodedMessageId}/star`, {
      method: 'PATCH',
      body: { starred: true },
    });
  }

  return Promise.resolve();
}

function showNewMailNotification({ title, body, count, messageId, accountId, folder, message } = {}) {
  if (!readNotificationPreference().enabled) {
    return { shown: false, reason: 'disabled' };
  }

  if (!Notification.isSupported()) {
    return { shown: false, reason: 'unsupported' };
  }

  const normalizedTitle = cleanNotificationText(title, 'New mail');
  const normalizedBody = cleanNotificationText(body, 'No subject');
  const notification = new Notification({
    title: normalizedTitle,
    body: count > 1 ? `${normalizedBody}\n${count} new messages` : normalizedBody,
    icon: getIconPath(),
    silent: true,
    ...(process.platform !== 'linux' ? {
      actions: [
        { type: 'button', text: 'Reply' },
        { type: 'button', text: 'Delete' },
        { type: 'button', text: 'Star' },
      ],
    } : {}),
  });

  notification.on('click', () => {
    if (messageId) {
      sendNativeAction('open-message', {
        messageId,
        accountId,
        folder,
        message,
      });
      return;
    }

    showMainWindow();
  });
  notification.on('action', (event, index) => {
    const actionIndex = Number.isInteger(index) ? index : event.actionIndex;
    if (!messageId) return;

    if (actionIndex === 0) {
      sendNativeAction('reply-message', {
        messageId,
        accountId,
        folder,
        message,
      });
      return;
    }

    const action = actionIndex === 1 ? 'delete-message' : actionIndex === 2 ? 'star-message' : null;
    if (!action) return;

    notification.close();
    runBackgroundMailAction(action, messageId)
      .catch((error) => console.error(`Could not ${action} from desktop notification:`, error));
  });
  notification.show();

  return { shown: true };
}

// Renders exactly the same native `Notification` type as a new-mail alert so the
// settings button proves the real OS integration instead of a renderer toast.
// It resolves on Electron's own 'show' / 'failed' events: reporting `{shown:true}`
// right after show() would claim success even when Windows silently drops the
// toast because notifications are turned off for Inboxora.
function showTestNotification(payload) {
  if (!readNotificationPreference().enabled) {
    return { shown: false, reason: 'disabled' };
  }

  if (!Notification.isSupported()) {
    return { shown: false, reason: 'unsupported' };
  }

  const normalized = normalizeTestNotification(payload, {
    title: 'Inboxora',
    body: 'System notifications are working correctly.',
  });
  if (!normalized) {
    return { shown: false, reason: 'invalid' };
  }

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    const notification = new Notification({
      title: normalized.title,
      body: normalized.body,
      icon: getIconPath(),
      silent: true,
    });

    notification.on('show', () => finish({ shown: true, confirmed: true }));
    notification.on('failed', (_event, error) => {
      const message = String((error && error.message) || error || '').slice(0, NEW_MAIL_NOTIFICATION_MAX_LENGTH);
      finish({ shown: false, reason: 'failed', error: message });
    });
    notification.on('click', () => {
      showMainWindow();
    });

    // Several desktops raise neither event (a Linux session without a notification
    // daemon, for example). "Handed to the system but unconfirmed" is the honest
    // answer there, and the settings card words it that way.
    timer = setTimeout(() => finish({ shown: true, confirmed: false }), TEST_NOTIFICATION_TIMEOUT_MS);
    notification.show();
  });
}

// Deep-links into the OS notification settings so a user whose system blocks
// Inboxora toasts has a one-click way to re-enable them. Linux has no portable
// settings URI, so the caller is told nothing was opened instead of guessing.
async function openSystemNotificationSettings() {
  if (!canOpenSystemNotificationSettings()) return { opened: false };

  const target = process.platform === 'win32'
    ? 'ms-settings:notifications'
    : 'x-apple.systempreferences:com.apple.preference.notifications';

  try {
    await shell.openExternal(target);
    return { opened: true };
  } catch (error) {
    console.error('Could not open the system notification settings:', error);
    return { opened: false };
  }
}

function notifyCheckingUpdate(verbose) {
  if (!verbose) return;

  sendUpdateStatus({ type: 'checking' });
  notifyUpdateStatus({
    title: 'Checking for update',
    message: 'Checking for new Inboxora updates.',
  });
}

function notifyUpdateError(message = UPDATE_ERROR_MESSAGE) {
  sendUpdateStatus({ type: 'error', message });
  notifyUpdateStatus({
    title: 'Update Error',
    message,
    type: 'negative',
  });
}

function notifyUpToDate(verbose) {
  if (!verbose) return;

  sendUpdateStatus({ type: 'up-to-date' });
  notifyUpdateStatus({
    title: 'Up to date',
    message: 'Your version of Inboxora is up to date.',
    type: 'positive',
  });
}

function notifyUpdateAvailable(verbose = true) {
  sendUpdateStatus({
    type: 'available',
    data: {
      releaseNotes: updateInfo.releaseNotes,
      releaseName: updateInfo.releaseName,
      releaseDate: updateInfo.releaseDate,
      updateUrl: updateInfo.updateUrl,
      manual: true,
    },
  });

  if (!verbose) return;

  notifyUpdateStatus({
    title: 'Update Available',
    message: 'Inboxora is downloading the newest version for you.',
  });
}

function notifyUpdateDownloaded() {
  const linuxInstallCommand = getLinuxUpdateInstallCommand(downloadedUpdate);
  const isLinuxManualInstall = Boolean(linuxInstallCommand);
  const linuxInstallMessage = linuxInstallCommand
    ? `Inboxora downloaded and verified the update. Install it from a terminal with:\n${linuxInstallCommand}`
    : null;

  sendUpdateStatus({
    type: 'downloaded',
    data: {
      releaseNotes: updateInfo && updateInfo.releaseNotes,
      releaseName: updateInfo && updateInfo.releaseName,
      releaseDate: updateInfo && updateInfo.releaseDate,
      updateUrl: updateInfo && updateInfo.updateUrl,
      filePath: downloadedUpdate,
      installCommand: linuxInstallCommand,
      manualInstall: isLinuxManualInstall,
      manual: true,
    },
  });
  showInAppNotification({
    title: 'Update Ready',
    message: linuxInstallMessage || 'Inboxora downloaded the update.',
    type: 'positive',
    actionLabel: isLinuxManualInstall ? 'Copy & Quit' : 'Install',
    action: isLinuxManualInstall ? 'copy-update-command-and-quit' : 'install-update',
    persistent: true,
  });
}

function toLinuxInstructionPath(filePath) {
  if (process.platform !== 'linux' || !filePath) return null;

  const normalizedPath = path.resolve(filePath);
  const homePath = path.resolve(app.getPath('home'));
  const relativeToHome = path.relative(homePath, normalizedPath);

  if (relativeToHome && !relativeToHome.startsWith('..') && !path.isAbsolute(relativeToHome)) {
    return `$HOME/${relativeToHome.split(path.sep).join('/')}`;
  }

  return normalizedPath.split(path.sep).join('/');
}

function quoteLinuxCommandPath(filePath) {
  const displayPath = toLinuxInstructionPath(filePath);
  if (!displayPath) return null;

  const escaped = displayPath.startsWith('$HOME/')
    ? displayPath.replace(/(["\\`])/g, '\\$1')
    : displayPath.replace(/(["\\$`])/g, '\\$1');
  return `"${escaped}"`;
}

function getLinuxUpdateInstallCommand(filePath) {
  if (process.platform !== 'linux' || !filePath) return null;

  const quotedPath = quoteLinuxCommandPath(filePath);
  if (!quotedPath) return null;
  const packageName = `${filePath} ${updateInfo?.assetName || ''}`;

  if (/\.deb(?:\s|$)/i.test(packageName)) {
    return `sudo apt install ${quotedPath}`;
  }

  if (/\.rpm(?:\s|$)/i.test(packageName)) {
    return `sudo dnf install ${quotedPath}`;
  }

  return null;
}

function filePostfix() {
  const date = new Date();
  return `${date.getMonth() + 1}.${date.getDate()}-${date.getHours()}.${date.getMinutes()}.${date.getSeconds()}`;
}

function getUniqueFilename(filename) {
  const extension = path.extname(filename);
  const file = path.basename(filename, extension);
  return `${file} (${filePostfix()})${extension}`;
}

function setDownloadProgress(window, value) {
  try {
    if (!window || window.isDestroyed()) return;
    window.setProgressBar(value);
  } catch {
    // Download events can outlive the BrowserWindow they started from.
  }
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function verifyExpectedDigest(filePath) {
  const digest = String(updateInfo?.digest || '').trim();
  if (!digest) return;

  const match = digest.match(/^sha256:([a-f0-9]{64})$/i);
  if (!match) throw new Error('The release asset has an unsupported digest.');

  const actual = await hashFile(filePath);
  if (actual.toLowerCase() !== match[1].toLowerCase()) {
    throw new Error('The update digest does not match the release asset.');
  }
}

function readWindowsSignature(filePath) {
  const script = [
    '$signature = Get-AuthenticodeSignature -LiteralPath $args[0]',
    '[pscustomobject]@{',
    '  status = [string]$signature.Status',
    '  subject = [string]$signature.SignerCertificate.Subject',
    '} | ConvertTo-Json -Compress',
  ].join('\n');
  const output = execFileSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
    filePath,
  ], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return JSON.parse(output);
}

function readMacSignatureDetails(filePath) {
  const result = spawnSync('codesign', ['--display', '--verbose=4', filePath], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || 'Could not read the code signature.');
  }
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

function verifyPlatformSignature(filePath) {
  if (process.platform === 'win32') {
    const installed = readWindowsSignature(process.execPath);
    const downloaded = readWindowsSignature(filePath);
    if (!hasMatchingWindowsPublisher(installed, downloaded)) {
      throw new Error('The update is not signed by the installed Inboxora publisher.');
    }
    return;
  }

  if (process.platform === 'darwin') {
    execFileSync('codesign', ['--verify', '--deep', '--strict', filePath], { stdio: 'ignore' });
    execFileSync('spctl', [
      '--assess',
      '--type',
      'open',
      '--context',
      'context:primary-signature',
      filePath,
    ], { stdio: 'ignore' });

    const installed = readMacSignatureDetails(process.execPath);
    const downloaded = readMacSignatureDetails(filePath);
    if (!hasMatchingMacTeam(installed, downloaded)) {
      throw new Error('The update is not signed by the installed Inboxora team.');
    }
  }
}

async function verifyDownloadedUpdate(filePath) {
  await verifyExpectedDigest(filePath);
  verifyPlatformSignature(filePath);
}

function isUpdateDownloadItem(item) {
  if (!pendingUpdateDownloadUrl && !updateInfo?.updateUrl) return false;

  const expectedUrl = pendingUpdateDownloadUrl || updateInfo.updateUrl;
  try {
    if (item.getURL() === expectedUrl) return true;
    if (typeof item.getURLChain === 'function' && item.getURLChain().includes(expectedUrl)) return true;
  } catch {}

  return false;
}

function initializeUpdateDownloads(window) {
  if (updateDownloadsInitialized) return;
  updateDownloadsInitialized = true;

  window.webContents.session.on('will-download', (_event, item) => {
    if (!isUpdateDownloadItem(item)) return;

    const totalBytes = item.getTotalBytes();
    const filePath = path.join(app.getPath('downloads'), getUniqueFilename(item.getFilename()));

    item.setSavePath(filePath);

    item.on('updated', () => {
      if (totalBytes > 0) {
        setDownloadProgress(window, item.getReceivedBytes() / totalBytes);
      }
    });

    item.on('done', async (_event, state) => {
      setDownloadProgress(window, -1);

      if (state === 'interrupted') {
        dialog.showErrorBox('Download error', `The download of ${item.getFilename()} was interrupted.`);
      }

      if (state === 'completed') {
        const updatePath = item.getSavePath();
        try {
          await verifyDownloadedUpdate(updatePath);
          downloadedUpdate = updatePath;
          notifyUpdateDownloaded();
        } catch (error) {
          downloadedUpdate = null;
          console.error('Downloaded update failed security verification:', error);
          notifyUpdateError('The downloaded update could not be verified and will not be opened.');
        }
      }

      pendingUpdateDownloadUrl = null;
    });
  });
}

function downloadUpdate(url) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  pendingUpdateDownloadUrl = url;
  mainWindow.webContents.downloadURL(url);
}

async function checkForUpdates(verbose = false) {
  notifyCheckingUpdate(verbose);

  try {
    const release = await requestJson(UPDATE_RELEASE_URL);
    const releaseVersion = release.tag_name || release.name;
    const installedPackageType = getInstalledLinuxPackageType();
    const installedVersion = getInstalledAppVersion(installedPackageType);
    const asset = getUpdateAsset(release);

    if (!isNewerVersion(releaseVersion, installedVersion)) {
      notifyUpToDate(verbose);
      return { updateAvailable: false };
    }

    if (!asset) {
      notifyUpdateError('A Inboxora update is available, but no installer was found for this platform.');
      return { updateAvailable: true, downloadAvailable: false };
    }

    updateInfo = {
      digest: asset.digest || null,
      assetName: asset.name || '',
      releaseNotes: release.body || '',
      releaseName: release.name || release.tag_name,
      releaseDate: release.published_at,
      updateUrl: asset.browser_download_url,
    };

    notifyUpdateAvailable(verbose);
    downloadUpdate(asset.browser_download_url);
    return { updateAvailable: true, downloadAvailable: true };
  } catch (error) {
    console.error('Update check failed:', error);
    notifyUpdateError();
    return { updateAvailable: false, error: error.message };
  }
}

function launchDownloadedUpdate(updatePath) {
  const linuxInstallCommand = getLinuxUpdateInstallCommand(updatePath);
  if (linuxInstallCommand) {
    const error = new Error('Manual installation is required for Linux packages.');
    error.code = 'MANUAL_LINUX_INSTALL';
    error.installCommand = linuxInstallCommand;
    throw error;
  }

  if (process.platform === 'win32' && /\.exe$/i.test(updatePath)) {
    const child = spawn(updatePath, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });

    child.unref();
    return Promise.resolve();
  }

  return shell.openPath(updatePath).then((error) => {
    if (error) throw new Error(error);
  });
}

function installDownloadedUpdate() {
  if (!downloadedUpdate) {
    return Promise.resolve({ installed: false, reason: 'missing-download' });
  }

  const linuxInstallCommand = getLinuxUpdateInstallCommand(downloadedUpdate);
  if (linuxInstallCommand) {
    return Promise.resolve({
      installed: false,
      reason: 'manual-install-required',
      installCommand: linuxInstallCommand,
    });
  }

  return new Promise((resolve) => {
    fs.access(downloadedUpdate, fs.constants.F_OK, async (error) => {
      if (error) {
        shell.showItemInFolder(downloadedUpdate);
        resolve({ installed: false, reason: 'missing-file' });
        return;
      }

      try {
        await verifyDownloadedUpdate(downloadedUpdate);
        await launchDownloadedUpdate(downloadedUpdate);
        isQuitting = true;
        setTimeout(() => app.quit(), 500);
        resolve({ installed: true });
      } catch (launchError) {
        if (launchError.code === 'MANUAL_LINUX_INSTALL') {
          resolve({
            installed: false,
            reason: 'manual-install-required',
            installCommand: launchError.installCommand,
          });
          return;
        }

        console.error('Could not launch downloaded update:', launchError);
        shell.showItemInFolder(downloadedUpdate);
        notifyUpdateError('The update was downloaded, but Inboxora could not start the installer.');
        resolve({ installed: false, reason: 'launch-failed', error: launchError.message });
      }
    });
  });
}

function copyLinuxUpdateCommandAndQuit({ installCommand, filePath } = {}) {
  const linuxInstallCommand = getLinuxUpdateInstallCommand(downloadedUpdate)
    || getLinuxUpdateInstallCommand(filePath);
  if (!linuxInstallCommand) {
    return { copied: false, reason: downloadedUpdate ? 'not-linux-package' : 'missing-download' };
  }

  const requestedCommand = typeof installCommand === 'string' ? installCommand.trim() : '';
  const commandToCopy = requestedCommand === linuxInstallCommand ? requestedCommand : linuxInstallCommand;

  clipboard.writeText(commandToCopy);
  isQuitting = true;
  setTimeout(() => app.quit(), 1250);
  return { copied: true, installCommand: commandToCopy };
}

function openDownloadedUpdatePath() {
  if (!downloadedUpdate) return;
  shell.showItemInFolder(downloadedUpdate);
}

function isMailtoUrl(value) {
  return /^mailto:/i.test(String(value || '').trim());
}

function parseProtocolUrlArg(args = []) {
  return args.find(isMailtoUrl) || null;
}

function splitMailtoAddresses(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function appendMailtoAddresses(target, value) {
  target.push(...splitMailtoAddresses(value));
}

function parseMailtoUrl(url) {
  const input = String(url || '').trim();
  if (!isMailtoUrl(input)) return null;

  try {
    const parsed = new URL(input);
    const composeData = {
      to: [],
      cc: [],
      bcc: [],
      subject: '',
      body: '',
    };

    appendMailtoAddresses(composeData.to, decodeURIComponent(parsed.pathname || ''));

    for (const [key, value] of parsed.searchParams.entries()) {
      const normalizedKey = key.toLowerCase();

      if (normalizedKey === 'to') appendMailtoAddresses(composeData.to, value);
      else if (normalizedKey === 'cc') appendMailtoAddresses(composeData.cc, value);
      else if (normalizedKey === 'bcc') appendMailtoAddresses(composeData.bcc, value);
      else if (normalizedKey === 'subject') composeData.subject = value;
      else if (normalizedKey === 'body') composeData.body = value;
    }

    composeData.to = [...new Set(composeData.to)];
    composeData.cc = [...new Set(composeData.cc)];
    composeData.bcc = [...new Set(composeData.bcc)];

    return composeData;
  } catch (error) {
    console.error('Could not parse mailto URL:', error);
    return null;
  }
}

function sendMailtoAction(url) {
  const composeData = parseMailtoUrl(url);
  if (!composeData) return false;

  sendNativeAction('new-mail', { composeData, source: 'mailto' });
  return true;
}

function flushPendingProtocolUrls() {
  while (pendingProtocolUrls.length > 0) {
    sendMailtoAction(pendingProtocolUrls.shift());
  }
}

function parseNativeActionArg(args = []) {
  const actionArg = args.find((arg) => String(arg).startsWith(NATIVE_ACTION_ARG));
  if (!actionArg) return null;

  const action = actionArg.slice(NATIVE_ACTION_ARG.length);
  if (['new-mail', 'sync'].includes(action)) return action;
  return null;
}

function createNativeActionPayload(action, data = {}) {
  const payload = {
    ...data,
    id: nextNativeActionId,
    action,
    createdAt: Date.now(),
  };
  nextNativeActionId += 1;
  pendingNativeActions.set(payload.id, payload);
  return payload;
}

function sendNativeAction(action, data = {}) {
  if (!action) return;

  const payload = createNativeActionPayload(action, data);
  showMainWindow();

  const send = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send(NATIVE_ACTION_CHANNEL, payload);
  };

  if (!mainWindow || mainWindow.isDestroyed()) return;

  if (mainWindow.webContents.isLoading()) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(send, 100);
    });
    return;
  }

  setTimeout(send, 100);
}

function nativeActionMenuItems() {
  return [
    {
      label: 'New Mail',
      click: () => sendNativeAction('new-mail'),
    },
    {
      label: 'Sync',
      click: () => sendNativeAction('sync'),
    },
  ];
}

function changeInboxoraHost() {
  clearHost();
  showMainWindow();
  loadSetup();
}

function fileMenuItems() {
  return [
    {
      label: 'Change Inboxora Host',
      accelerator: 'CmdOrCtrl+,',
      click: changeInboxoraHost,
    },
  ];
}

function editMenuItems() {
  return [
    { label: 'Undo', accelerator: 'CmdOrCtrl+Z', role: 'undo' },
    { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', role: 'redo' },
    { type: 'separator' },
    { label: 'Cut', accelerator: 'CmdOrCtrl+X', role: 'cut' },
    { label: 'Copy', accelerator: 'CmdOrCtrl+C', role: 'copy' },
    { label: 'Paste', accelerator: 'CmdOrCtrl+V', role: 'paste' },
    { label: 'Paste and Match Style', accelerator: 'Shift+CmdOrCtrl+V', role: 'pasteAndMatchStyle' },
    { label: 'Delete', role: 'delete' },
    { type: 'separator' },
    { label: 'Select All', accelerator: 'CmdOrCtrl+A', role: 'selectAll' },
  ];
}

function viewMenuItems() {
  return [
    {
      label: 'Reload',
      accelerator: 'CmdOrCtrl+R',
      click(_item, focusedWindow) {
        if (focusedWindow) focusedWindow.reload();
      },
    },
    {
      label: 'Toggle Full Screen',
      accelerator: process.platform === 'darwin' ? 'Ctrl+Command+F' : 'F11',
      click(_item, focusedWindow) {
        if (!focusedWindow) return;
        focusedWindow.setFullScreen(!focusedWindow.isFullScreen());
      },
    },
  ];
}

function windowMenuItems() {
  if (process.platform === 'darwin') {
    return [
      { label: 'Close', accelerator: 'CmdOrCtrl+W', role: 'close' },
      { label: 'Minimize', accelerator: 'CmdOrCtrl+M', role: 'minimize' },
      { label: 'Zoom', role: 'zoom' },
      { type: 'separator' },
      { label: 'Bring All to Front', role: 'front' },
    ];
  }

  return [
    { label: 'Minimize', accelerator: 'CmdOrCtrl+M', role: 'minimize' },
    { label: 'Close', accelerator: 'CmdOrCtrl+W', role: 'close' },
  ];
}

function helpMenuItems() {
  return [
    {
      label: 'Learn More',
      click: () => shell.openExternal('https://github.com/Dragonk/Inboxora'),
    },
    { type: 'separator' },
    {
      label: 'Help',
      click: () => shell.openExternal('https://github.com/Dragonk/Inboxora/docs'),
    },
    {
      label: 'Report Issue',
      click: () => shell.openExternal('https://github.com/Dragonk/Inboxora/issues'),
    },
    { type: 'separator' },
    {
      label: 'Check For Updates',
      click: () => checkForUpdates(true),
    },
  ];
}

function buildDarwinMenuTemplate() {
  const name = app.name;

  return [
    {
      label: name,
      submenu: [
        { label: `About ${name}`, role: 'about' },
        { type: 'separator' },
        {
          label: 'Preferences',
          accelerator: 'Command+,',
          click: changeInboxoraHost,
        },
        { label: 'Services', role: 'services', submenu: [] },
        { type: 'separator' },
        { label: `Hide ${name}`, accelerator: 'Command+H', role: 'hide' },
        { label: 'Hide Others', accelerator: 'Command+Alt+H', role: 'hideOthers' },
        { label: 'Show All', role: 'unhide' },
        { type: 'separator' },
        { label: `Quit ${name}`, accelerator: 'Command+Q', role: 'quit' },
      ],
    },
    {
      label: 'File',
      id: 'file',
      submenu: fileMenuItems(),
    },
    {
      label: 'Edit',
      submenu: editMenuItems(),
    },
    {
      label: 'View',
      submenu: viewMenuItems(),
    },
    {
      label: 'Window',
      role: 'window',
      submenu: windowMenuItems(),
    },
    {
      label: 'Help',
      role: 'help',
      submenu: helpMenuItems(),
    },
  ];
}

function setupMenu() {
  // macOS hosts the application menu in the system menu bar, so it stays as-is.
  // Windows and Linux must not show an in-window File / Edit / View / Window /
  // Help bar at all: the custom title bar replaces it. Removing the menu also
  // removes its accelerators, so the few that still matter are re-registered
  // directly on the window below.
  if (keepsApplicationMenuBar(process.platform)) {
    Menu.setApplicationMenu(Menu.buildFromTemplate(buildDarwinMenuTemplate()));
    return;
  }

  Menu.setApplicationMenu(null);
}

// Native clipboard shortcuts keep working without a menu on Windows/Linux, but
// accelerators otherwise live on application-menu items — so removing the menu
// also removes them. Everything the old File/View/Window menus offered is
// re-registered here instead of being silently dropped.
function registerWindowAccelerators(webContents) {
  if (keepsApplicationMenuBar(process.platform)) return;

  const getTarget = () => {
    const target = BrowserWindow.fromWebContents(webContents);
    return target && !target.isDestroyed() ? target : null;
  };

  webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.isAutoRepeat) return;

    if (input.control && !input.alt && !input.meta) {
      const key = String(input.key || '').toLowerCase();

      if (key === 'r') {
        event.preventDefault();
        webContents.reload();
        return;
      }

      // Close funnels through the existing 'close' handler, so Ctrl+W keeps
      // meaning "hide to the tray" (and quits for real once the app is quitting).
      if (key === 'w') {
        event.preventDefault();
        getTarget()?.close();
        return;
      }

      if (key === 'm') {
        event.preventDefault();
        getTarget()?.minimize();
        return;
      }

      // Preserved from the old File menu (and still Command+, on macOS): Change
      // Inboxora Host, not Preferences.
      if (key === ',') {
        event.preventDefault();
        changeInboxoraHost();
        return;
      }
    }

    if (input.key === 'F11') {
      const target = getTarget();
      if (!target) return;
      event.preventDefault();
      target.setFullScreen(!target.isFullScreen());
    }
  });
}

function showContextMenu(webContents, params) {
  const template = [];
  const hasSelection = Boolean(params.selectionText && params.selectionText.trim());
  const hasLink = Boolean(params.linkURL);
  const hasImage = params.mediaType === 'image' && Boolean(params.srcURL);

  if (params.isEditable) {
    template.push(
      { label: 'Cut', role: 'cut' },
      { label: 'Copy', role: 'copy', enabled: hasSelection },
      { label: 'Paste', role: 'paste' },
      { type: 'separator' },
      { label: 'Select All', role: 'selectAll' },
    );
  } else {
    if (hasLink) {
      template.push(
        {
          label: 'Open Link',
          click: () => {
            if (isAllowedExternalUrl(params.linkURL)) shell.openExternal(params.linkURL);
          },
        },
        {
          label: 'Copy Link',
          click: () => clipboard.writeText(params.linkURL),
        },
      );
    }

    if (hasImage) {
      if (template.length > 0) template.push({ type: 'separator' });
      template.push({
        label: 'Copy Image Address',
        click: () => clipboard.writeText(params.srcURL),
      });
    }

    if (hasSelection) {
      if (template.length > 0) template.push({ type: 'separator' });
      template.push(
        { label: 'Copy', role: 'copy' },
        { label: 'Select All', role: 'selectAll' },
      );
    }
  }

  if (template.length === 0) return;

  Menu.buildFromTemplate(template).popup({
    window: BrowserWindow.fromWebContents(webContents) || mainWindow,
  });
}

function getDefaultWindowBounds() {
  return {
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 620,
  };
}

function getSavedWindowBounds() {
  const bounds = readConfig().windowBounds;
  if (!bounds || typeof bounds !== 'object') return {};

  const numericBounds = {};
  for (const key of ['x', 'y', 'width', 'height']) {
    if (Number.isFinite(bounds[key])) numericBounds[key] = bounds[key];
  }

  return numericBounds;
}

function saveWindowBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  writeConfig({
    ...readConfig(),
    windowBounds: mainWindow.getBounds(),
  });
}

function showMainWindow({ reload = false } = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }

  const wasHidden = !mainWindow.isVisible();

  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();

  if (reload && wasHidden) {
    mainWindow.webContents.reload();
  }
}

function getTrayIcon() {
  const trayIconPath = process.platform === 'win32'
    ? path.join(__dirname, 'icons', 'icon.ico')
    : process.platform === 'darwin'
      ? path.join(__dirname, 'icons', 'icon.icns')
      : path.join(__dirname, 'icons', '96x96.png');

  return nativeImage.createFromPath(trayIconPath);
}

function refreshTrayMenu() {
  if (!tray) return;

  const isWindowVisible = !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible();
  tray.setContextMenu(Menu.buildFromTemplate([
    ...nativeActionMenuItems(),
    { type: 'separator' },
    {
      label: isWindowVisible ? 'Hide Inboxora' : 'Show Inboxora',
      click: () => {
        if (isWindowVisible) {
          saveWindowBounds();
          mainWindow.hide();
        } else {
          showMainWindow({ reload: true });
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Change Inboxora Host',
      click: () => {
        clearHost();
        showMainWindow();
        loadSetup();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => app.quit(),
    },
  ]));
}

function createTray() {
  if (tray) return;

  const trayIcon = getTrayIcon();
  if (trayIcon.isEmpty()) return;

  tray = new Tray(trayIcon);
  tray.setToolTip('Inboxora');
  tray.on('click', () => {
    refreshTrayMenu();
    showMainWindow({ reload: true });
  });
  refreshTrayMenu();
}

function setupDockMenu() {
  if (process.platform !== 'darwin' || !app.dock) return;
  app.dock.setMenu(Menu.buildFromTemplate(nativeActionMenuItems()));
}

function setupTaskbarTasks() {
  if (process.platform !== 'win32') return;

  app.setUserTasks([
    {
      program: process.execPath,
      arguments: `${NATIVE_ACTION_ARG}new-mail`,
      iconPath: getWindowIconPath(),
      iconIndex: 0,
      title: 'New Mail',
      description: 'Compose a new Inboxora message',
    },
    {
      program: process.execPath,
      arguments: `${NATIVE_ACTION_ARG}sync`,
      iconPath: getWindowIconPath(),
      iconIndex: 0,
      title: 'Sync',
      description: 'Sync Inboxora mail',
    },
  ]);
}

function createWindow() {
  // The custom title bar (DesktopTitleBar) draws the app's own bar. `titleBarStyle:
  // 'hidden'` removes the OS chrome but keeps the native minimize / maximize /
  // close controls on Windows and Linux through the Window Controls Overlay, so
  // there is no custom `frame: false` button row to maintain. `titleBarOverlay: true`
  // is not enough here: the colour has to follow the user's Inboxora theme, so the
  // last resolved theme is restored from the config to avoid a flash on start-up.
  const titlebarTheme = getTitlebarTheme();

  mainWindow = new BrowserWindow({
    ...getDefaultWindowBounds(),
    ...getSavedWindowBounds(),
    show: false,
    title: 'Inboxora',
    icon: getWindowIconPath(),
    titleBarStyle: 'hidden',
    ...(usesTitleBarOverlay(process.platform)
      ? {
          titleBarOverlay: {
            height: TITLEBAR_HEIGHT,
            color: titlebarTheme.color,
            symbolColor: titlebarTheme.symbolColor,
          },
        }
      : { trafficLightPosition: { x: 14, y: 16 } }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      shell.openExternal(url);
    }

    return { action: 'deny' };
  });

  mainWindow.webContents.on('context-menu', (_event, params) => {
    showContextMenu(mainWindow.webContents, params);
  });

  registerWindowAccelerators(mainWindow.webContents);

  const navigationPolicy = createNavigationPolicy(readHost);
  const internalPages = new Set([
    pathToFileURL(path.join(__dirname, '..', 'native-shell', 'index.html')).toString(),
    pathToFileURL(path.join(__dirname, '..', 'native-shell', 'host-unavailable.html')).toString(),
  ]);
  const guardNavigation = (event, url, kind) => {
    if (internalPages.has(url)) {
      navigationPolicy.reset();
      return;
    }
    if (navigationPolicy.decide(kind, url) === 'allow') return;
    event.preventDefault();
  };

  mainWindow.webContents.on('will-navigate', (event, url) => {
    guardNavigation(event, url, 'navigate');
  });
  mainWindow.webContents.on('will-redirect', (event, url, _isInPlace, isMainFrame) => {
    if (!isMainFrame) return;
    guardNavigation(event, url, 'redirect');
  });

  mainWindow.webContents.on('did-fail-load', (_event, _errorCode, _errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    const host = readHost();
    if (!host || !isSameOrigin(host, validatedURL)) return;
    loadHostUnavailable();
  });

  mainWindow.webContents.session.webRequest.onCompleted((details) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (details.webContentsId !== mainWindow.webContents.id) return;
    if (details.resourceType !== 'mainFrame') return;
    if (!HOST_UNAVAILABLE_STATUS_CODES.has(details.statusCode)) return;

    const host = readHost();
    if (!host || !isSameOrigin(host, details.url)) return;

    setTimeout(() => loadHostUnavailable(), 0);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    detectRewriteErrorPage();
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting && tray) {
      event.preventDefault();
      saveWindowBounds();
      mainWindow.hide();
      refreshTrayMenu();
      return;
    }

    saveWindowBounds();
  });

  mainWindow.on('show', refreshTrayMenu);
  mainWindow.on('hide', refreshTrayMenu);
  mainWindow.on('closed', () => {
    mainWindow = null;
    refreshTrayMenu();
  });

  initializeUpdateDownloads(mainWindow);

  const host = readHost();
  if (host) {
    mainWindow.loadURL(host);
  } else {
    loadSetup();
  }
}

function loadSetup() {
  if (!mainWindow) return;
  mainWindow.loadFile(path.join(__dirname, '..', 'native-shell', 'index.html'));
}

function loadHostUnavailable() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.loadFile(path.join(__dirname, '..', 'native-shell', 'host-unavailable.html'));
}

function detectRewriteErrorPage() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const currentUrl = mainWindow.webContents.getURL();
  const host = readHost();
  if (!host || !isSameOrigin(host, currentUrl)) return;

  mainWindow.webContents.executeJavaScript('document.body ? document.body.innerText : ""', true)
    .then((text) => {
      if (!REWRITE_ERROR_PATTERNS.some((pattern) => pattern.test(String(text || '')))) return;
      loadHostUnavailable();
    })
    .catch(() => {});
}

function scheduleStartupUpdateCheck() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!readHost()) return;

  const check = () => {
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      checkForUpdates(false);
    }, 5000);
  };

  if (mainWindow.webContents.isLoading()) {
    mainWindow.webContents.once('did-finish-load', check);
    return;
  }

  check();
}

// Every privileged IPC channel must come from the Inboxora window itself. The
// window can load an operator-configured host, so the reply is never trusted on
// its own.
function isTrustedIpcSender(event) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (!mainWindow.webContents || mainWindow.webContents.isDestroyed()) return false;
  return event.sender === mainWindow.webContents;
}

/**
 * Stricter check for the channels the Inboxora UI owns.
 *
 * `event.sender === mainWindow.webContents` is not enough: the same webContents
 * also hosts the local setup page and, while the navigation policy is in its
 * OIDC window, an identity-provider document. Those documents share the sender,
 * so the frame origin has to match the configured Inboxora host as well.
 */
function assertTrustedAppSender(event) {
  if (!isTrustedIpcSender(event)) {
    throw new Error('Untrusted IPC sender');
  }

  let frame = null;
  try {
    frame = event.senderFrame;
  } catch {
    frame = null;
  }
  if (!frame) throw new Error('Untrusted IPC sender');

  const host = readHost();
  if (!host) throw new Error('Untrusted IPC sender');

  const origin = typeof frame.origin === 'string' && frame.origin && frame.origin !== 'null'
    ? frame.origin
    : (typeof frame.url === 'string' ? frame.url : '');

  if (!origin || !isSameOrigin(host, origin)) {
    throw new Error('Untrusted IPC sender');
  }
}

function assertTrustedIpcSender(event) {
  if (!isTrustedIpcSender(event)) {
    throw new Error('Untrusted IPC sender');
  }
}

ipcMain.handle('inboxora:getHost', () => readHost());

ipcMain.handle('inboxora:saveHost', async (_event, host) => {
  const normalized = normalizeHost(host);
  if (new URL(normalized).protocol === 'http:') {
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Use unencrypted connection', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: 'Unencrypted Inboxora connection',
      message: 'Traffic to this Inboxora server is not encrypted.',
      detail: 'Your session cookie and email data can be read or changed by anyone who can observe this network. Continue only on a private network you trust.',
    });
    if (result.response !== 0) {
      throw new Error('The unencrypted Inboxora host was not saved.');
    }
  }

  writeHost(normalized);
  return normalized;
});

ipcMain.handle('inboxora:resetHost', () => {
  clearHost();
  loadSetup();
});

ipcMain.handle('inboxora:badge:set-unread-count', (_event, count) => {
  const unreadCount = Math.max(0, Number.parseInt(count, 10) || 0);
  return setUnreadBadgeCount(unreadCount);
});

ipcMain.handle('inboxora:notification:new-mail', (event, notification) => {
  assertTrustedAppSender(event);
  return showNewMailNotification(notification);
});

ipcMain.handle('inboxora:notifications:get-settings', (event) => {
  assertTrustedAppSender(event);
  return getDesktopNotificationSettings();
});

ipcMain.handle('inboxora:notifications:set-enabled', (event, enabled) => {
  assertTrustedAppSender(event);
  return setDesktopNotificationEnabled(enabled);
});

ipcMain.handle('inboxora:notifications:is-supported', (event) => {
  assertTrustedAppSender(event);
  return Notification.isSupported();
});

ipcMain.handle('inboxora:notifications:test', (event, payload) => {
  assertTrustedAppSender(event);
  return showTestNotification(payload);
});

ipcMain.handle('inboxora:notifications:open-settings', (event) => {
  assertTrustedAppSender(event);
  return openSystemNotificationSettings();
});

ipcMain.handle('inboxora:mailto:get-settings', (event) => {
  assertTrustedAppSender(event);
  return readMailtoSettings();
});

ipcMain.handle('inboxora:mailto:register', (event) => {
  assertTrustedAppSender(event);
  return registerAsMailtoHandler();
});

ipcMain.handle('inboxora:mailto:open-settings', (event) => {
  assertTrustedAppSender(event);
  return openDefaultAppsSettings();
});

ipcMain.handle('inboxora:titlebar:set-theme', (event, theme) => {
  assertTrustedAppSender(event);
  const persisted = persistTitlebarTheme(theme);
  if (!persisted) return { applied: false };

  if (mainWindow && !mainWindow.isDestroyed() && typeof mainWindow.setTitleBarOverlay === 'function'
      && usesTitleBarOverlay(process.platform)) {
    try {
      mainWindow.setTitleBarOverlay({
        height: TITLEBAR_HEIGHT,
        color: persisted.color,
        symbolColor: persisted.symbolColor,
      });
    } catch (error) {
      console.error('Could not update the title bar overlay:', error);
      return { applied: false };
    }
  }

  return { applied: true, theme: persisted, height: TITLEBAR_HEIGHT };
});

ipcMain.handle('inboxora:updates:check', async (_event, { verbose } = {}) => {
  return checkForUpdates(verbose);
});

ipcMain.handle('inboxora:updates:install-downloaded', () => {
  return installDownloadedUpdate();
});

ipcMain.handle('inboxora:updates:install-auto', () => {
  return installDownloadedUpdate();
});

ipcMain.handle('inboxora:updates:copy-install-command-and-quit', (_event, options) => {
  return copyLinuxUpdateCommandAndQuit(options);
});

ipcMain.handle('inboxora:updates:open-download', () => {
  openDownloadedUpdatePath();
});

ipcMain.handle('inboxora:native-actions:pending', () => {
  return Array.from(pendingNativeActions.values());
});

ipcMain.handle('inboxora:native-actions:ack', (_event, id) => {
  pendingNativeActions.delete(id);
});

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.whenReady().then(() => {
    registerMailtoProtocol();
    setupMenu();
    setupDockMenu();
    setupTaskbarTasks();
    createTray();
    createWindow();
    scheduleStartupUpdateCheck();
    sendNativeAction(parseNativeActionArg(process.argv));
    sendMailtoAction(parseProtocolUrlArg(process.argv));
    flushPendingProtocolUrls();

    app.on('activate', () => {
      showMainWindow();
    });
  });

  app.on('second-instance', (_event, args) => {
    const mailtoUrl = parseProtocolUrlArg(args);
    if (mailtoUrl) {
      sendMailtoAction(mailtoUrl);
      return;
    }

    showMainWindow();
    sendNativeAction(parseNativeActionArg(args));
  });
}

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('open-url', (event, url) => {
  event.preventDefault();

  if (mainWindow) {
    sendMailtoAction(url);
    return;
  }

  pendingProtocolUrls.push(url);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
