let installed = false;
/** A handle returned by a plugin listener registration. */
interface NativePluginHandle { remove?(): void }

type NativePlugin = Record<string, (args?: unknown, extra?: unknown) => Promise<unknown>> & {
  addListener<T>(event: string, listener: (payload: T) => void): Promise<NativePluginHandle>;
};
let plugin: NativePlugin | null = null;
let registerNativePlugin: ((name: string) => NativePlugin) | null = null;
let installPromise: Promise<boolean> | null = null;
let pluginUnavailable = false;

function getPlugin(): NativePlugin {
  if (plugin) return plugin;
  if (!registerNativePlugin) throw new Error('native bridge is not installed');
  plugin = registerNativePlugin('InboxoraNative');
  return plugin;
}

/** Like callNative, but a supplied fallback makes the result non-null (the bridge's own contract). */
async function callNativeWithFallback<T>(method: string, args: unknown, fallback: T): Promise<T> {
  const result = await callNative<T>(method, args, fallback);
  return result ?? fallback;
}

async function callNative<T>(method: string, args: unknown = undefined, fallback: T | null = null): Promise<T | null> {
  if (pluginUnavailable) return fallback;

  try {
    const InboxoraNative = getPlugin();
    // The native side is untyped by definition; the caller declares the shape it expects.
    return (await InboxoraNative[method](args)) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('not implemented')) {
      pluginUnavailable = true;
    }
    return fallback;
  }
}

export async function installCapacitorNativeBridge(): Promise<boolean> {
  if (installed) return true;
  if (installPromise) return installPromise;

  installPromise = (async () => {
    if (!window.Capacitor?.isNativePlatform?.()) return false;

    const { Capacitor, registerPlugin } = await import('@capacitor/core');
    if (!Capacitor.isNativePlatform()) return false;
    registerNativePlugin = registerPlugin;

    const existingBridge = window.inboxoraNative || {};

    window.inboxoraNative = {
      ...existingBridge,
      platform: 'android',
      getHost: async () => {
        const result = await callNative<{ host?: string | null }>('getHost', undefined, {});
        return result?.host || null;
      },
      saveHost: async (host) => {
        const result = await callNative<{ host?: string | null }>('saveHost', { host }, { host });
        return result?.host || host;
      },
      resetHost: async () => callNative('resetHost'),
      badges: {
        ...existingBridge.badges,
        setUnreadCount: async (count: number) => callNative('setUnreadCount', { count }),
      },
      updates: {
        ...existingBridge.updates,
        check: async (verbose) => callNative('checkForUpdates', { verbose }),
        installDownloaded: async () => callNativeWithFallback('installDownloadedUpdate', undefined, { installed: false, reason: 'unavailable' }),
        installAuto: async () => callNativeWithFallback('installDownloadedUpdate', undefined, { installed: false, reason: 'unavailable' }),
        openDownload: async () => callNative('openDownloadedUpdate'),
        onStatus: (callback) => {
          if (pluginUnavailable) return () => {};
          const InboxoraNative = getPlugin();
          const handlePromise = InboxoraNative.addListener('updateStatus', callback).catch(() => null);
          return () => {
            handlePromise.then((handle) => handle?.remove?.()).catch(() => {});
          };
        },
      },
      notifications: {
        ...existingBridge.notifications,
        checkPermission: async () => {
          const result = await callNative<{ permission?: string }>('checkNotificationPermission', undefined, {});
          const permission = result?.permission;
          return permission === 'granted' || permission === 'denied' ? permission : 'default';
        },
        requestPermission: async () => {
          const result = await callNative<{ permission?: string }>('requestNotificationPermission', undefined, {});
          const permission = result?.permission;
          return permission === 'granted' || permission === 'denied' ? permission : 'default';
        },
        openSettings: async () => callNativeWithFallback('openNotificationSettings', undefined, { status: 'unavailable' }),
        showNewMail: async (notification) => callNative('showNewMail', notification || {}),
        // Native push (Android) lifecycle. The native layer owns the provider
        // endpoint/token and the server registration; JS only triggers it and
        // reads a non-secret status for the settings screen.
        getStatus: async () => callNativeWithFallback('getPushStatus', undefined, { status: 'unavailable' }),
        register: async () => callNativeWithFallback('registerPush', undefined, { status: 'unavailable' }),
        clear: async () => callNativeWithFallback('clearPush', undefined, { status: 'unavailable' }),
        openDistributor: async () => callNativeWithFallback('openPushDistributor', undefined, { opened: false }),
        openInstallPage: async () => callNativeWithFallback('openPushInstallPage', undefined, { status: 'unavailable' }),
        openHelp: async () => callNativeWithFallback('openPushHelp', undefined, { status: 'unavailable' }),
      },
      actions: {
        ...existingBridge.actions,
        getPending: async () => {
          const result = await callNative<{ actions?: Array<{ id?: string; type?: string; [key: string]: unknown }> }>('getPendingActions', undefined, {});
          return result?.actions || [];
        },
        ack: async (id: string) => callNative('ackAction', { id }),
        onAction: (callback) => {
          if (pluginUnavailable) return () => {};
          const InboxoraNative = getPlugin();
          const handlePromise = InboxoraNative.addListener('nativeAction', callback).catch(() => null);
          return () => {
            handlePromise.then((handle) => handle?.remove?.()).catch(() => {});
          };
        },
      },
    };

    installed = true;
    return true;
  })();

  return installPromise;
}
