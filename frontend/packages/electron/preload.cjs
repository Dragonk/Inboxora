const { contextBridge, ipcRenderer } = require('electron');
const pendingNativeActions = [];
const nativeActionSubscribers = new Set();

// Must match TITLEBAR_HEIGHT in desktop-settings.cjs, which sizes the native
// Window Controls Overlay. It is duplicated here because a sandboxed preload
// cannot require project files; desktop-settings.test.cjs pins the main value.
const TITLEBAR_HEIGHT = 48;

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

ipcRenderer.on('inboxora:native-action', (_event, payload) => {
  if (nativeActionSubscribers.size === 0) {
    pendingNativeActions.push(payload);
    return;
  }

  nativeActionSubscribers.forEach((callback) => callback(payload));
});

function subscribeNativeAction(callback) {
  nativeActionSubscribers.add(callback);

  while (pendingNativeActions.length > 0) {
    callback(pendingNativeActions.shift());
  }

  return () => nativeActionSubscribers.delete(callback);
}

contextBridge.exposeInMainWorld('inboxoraNative', {
  shell: 'electron',
  platform: process.platform,
  getHost: () => ipcRenderer.invoke('inboxora:getHost'),
  saveHost: (host) => ipcRenderer.invoke('inboxora:saveHost', host),
  resetHost: () => ipcRenderer.invoke('inboxora:resetHost'),
  badges: {
    setUnreadCount: (count) => ipcRenderer.invoke('inboxora:badge:set-unread-count', count),
  },
  updates: {
    check: (verbose) => ipcRenderer.invoke('inboxora:updates:check', { verbose }),
    installDownloaded: () => ipcRenderer.invoke('inboxora:updates:install-downloaded'),
    installAuto: () => ipcRenderer.invoke('inboxora:updates:install-auto'),
    copyInstallCommandAndQuit: (options) => ipcRenderer.invoke('inboxora:updates:copy-install-command-and-quit', options),
    openDownload: () => ipcRenderer.invoke('inboxora:updates:open-download'),
    onStatus: (callback) => subscribe('inboxora:updates:status', callback),
  },
  notifications: {
    onPush: (callback) => subscribe('inboxora:notifications:push', callback),
    showNewMail: (notification) => ipcRenderer.invoke('inboxora:notification:new-mail', notification),
    getSettings: () => ipcRenderer.invoke('inboxora:notifications:get-settings'),
    setEnabled: (enabled) => ipcRenderer.invoke('inboxora:notifications:set-enabled', enabled),
    isSupported: () => ipcRenderer.invoke('inboxora:notifications:is-supported'),
    showTest: (payload) => ipcRenderer.invoke('inboxora:notifications:test', payload),
    openSettings: () => ipcRenderer.invoke('inboxora:notifications:open-settings'),
  },
  titlebar: {
    height: TITLEBAR_HEIGHT,
    setTheme: (theme) => ipcRenderer.invoke('inboxora:titlebar:set-theme', theme),
  },
  actions: {
    getPending: () => ipcRenderer.invoke('inboxora:native-actions:pending'),
    ack: (id) => ipcRenderer.invoke('inboxora:native-actions:ack', id),
    onAction: subscribeNativeAction,
  },
});
