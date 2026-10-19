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
      getLanguage: existingBridge.getLanguage || (async () => {
        try { return await getPlugin().getLanguage() as { language?: string }; } catch { return null; }
      }),
      setLanguage: existingBridge.setLanguage || (async language => {
        try { return await getPlugin().setLanguage({ language }); } catch { return null; }
      }),
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

      // Attachment downloads. Inside the Android WebView an <a download> click
      // silently does nothing, so every download route re-routes through the
      // native side: server URLs go through the system DownloadManager, and
      // blobs the app already holds (archive entries, exports) are streamed
      // back as bounded base64 chunks and reassembled natively.
      attachments: {
        ...existingBridge.attachments,
        download: async (url: string, filename?: string) => callNativeWithFallback('downloadAttachment', { url, ...(filename ? { filename } : {}) }, { queued: false }),
        saveBlob: async (blob: Blob, filename: string) => {
          const begin = await callNative<{ id?: string }>('saveAttachmentBegin', { filename, mimeType: blob.type || 'application/octet-stream', size: blob.size }, null);
          if (!begin?.id) throw new Error('native attachment save unavailable');
          const buffer = new Uint8Array(await blob.arrayBuffer());
          // 384 KiB of bytes encodes to 512 KiB of base64, safely under the
          // 1 MB Binder transaction limit.
          const CHUNK_BYTES = 384 * 1024;
          for (let offset = 0; offset < buffer.length; offset += CHUNK_BYTES) {
            const slice = buffer.subarray(offset, Math.min(offset + CHUNK_BYTES, buffer.length));
            let binary = '';
            for (let i = 0; i < slice.length; i += 0x8000) binary += String.fromCharCode(...slice.subarray(i, i + 0x8000));
            await callNative('saveAttachmentChunk', { id: begin.id, data: btoa(binary) }, null);
          }
          return callNativeWithFallback('saveAttachmentFinish', { id: begin.id }, { ok: false });
        },
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
        // Live-push dismissal + calendar reminders. Fire-and-forget from JS: the
        // native layer owns dedup/cancel semantics and ignores ids it never posted.
        cancelMessageNotifications: async (messageIds: string[]) => callNativeWithFallback('cancelMessageNotifications', { messageIds: messageIds || [] }, {}),
        syncReminders: async () => callNativeWithFallback('syncReminders', undefined, { scheduled: 0 }),
        getReminderStatus: async () => callNativeWithFallback('getReminderStatus', undefined, { exactAlarmsGranted: true, remindersScheduled: 0, batteryOptimized: true, live: 'unavailable' }),
        requestExactAlarmPermission: async () => callNativeWithFallback('requestExactAlarmPermission', undefined, { granted: true }),
        requestIgnoreBatteryOptimizations: async () => callNativeWithFallback('requestIgnoreBatteryOptimizations', undefined, { ignored: false }),
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
