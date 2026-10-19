import { api } from './api.ts';
import { installCapacitorNativeBridge } from './capacitorNativeBridge.ts';

// Native (Android) push lifecycle, driven from JS but executed natively.
//
// The transport registration (the built-in live socket, or FCM in builds with
// google-services.json) and the server POST /api/push/devices are owned by the
// native layer, because the connection can come up while the WebView process
// does not exist. JS is the coordinator: it triggers a refresh after login/host
// change and clears the device registration on logout, so the server never
// keeps a subscription for a session the user has left.

type NativeStatus = {
  status?: string;
  deviceId?: string;
  [key: string]: unknown;
};

type NativeNotifications = {
  getStatus?: () => Promise<NativeStatus>;
  register?: () => Promise<NativeStatus>;
  clear?: () => Promise<NativeStatus>;
  openLiveChannelSettings?: () => Promise<NativeStatus>;
  cancelMessageNotifications?: (messageIds: string[]) => Promise<NativeStatus>;
  syncReminders?: () => Promise<NativeStatus>;
  getReminderStatus?: () => Promise<NativeStatus>;
  requestExactAlarmPermission?: () => Promise<NativeStatus>;
  requestIgnoreBatteryOptimizations?: () => Promise<NativeStatus>;
};

type NativePushResult = {
  status: string;
  transport: string | null;
  deviceId: string | null;
  supported: boolean;
  reason: string | null;
};

type InstantPushState = {
  platformSupported: boolean;
  status: string;
  transport: string | null;
  deviceId: string | null;
  hasDeviceToken: boolean;
  hasEndpoint: boolean;
  live: string | null;
  exactAlarmsGranted: boolean | null;
  batteryOptimized: boolean | null;
};

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function unavailable(reason: string): NativePushResult {
  return { status: 'unavailable', transport: null, deviceId: null, supported: false, reason };
}

function normalizeNativeStatus(result: NativeStatus | null): NativePushResult {
  if (result === null) return unavailable('native-bridge-unavailable');

  const status = readString(result.status);
  return {
    status: status === null ? 'unavailable' : status,
    transport: readString(result.transport),
    deviceId: readString(result.deviceId),
    supported: true,
    reason: readString(result.reason),
  };
}

function getNotifications(): NativeNotifications | null {
  const bridge = window.inboxoraNative;
  if (bridge === undefined) return null;
  const notifications = bridge.notifications;
  return notifications === undefined ? null : notifications;
}

async function getNativeStatus(): Promise<NativeStatus | null> {
  const notifications = getNotifications();
  if (notifications === null || notifications.getStatus === undefined) return null;
  try {
    return await notifications.getStatus();
  } catch {
    return null;
  }
}

async function registerNativeStatus(): Promise<NativeStatus | null> {
  const notifications = getNotifications();
  if (notifications === null || notifications.register === undefined) return null;
  try {
    return await notifications.register();
  } catch {
    return null;
  }
}

async function getNativeReminderStatus(): Promise<NativeStatus | null> {
  const notifications = getNotifications();
  if (notifications === null || notifications.getReminderStatus === undefined) return null;
  try {
    return await notifications.getReminderStatus();
  } catch {
    return null;
  }
}

export function isNativePlatform(): boolean {
  if (typeof window === 'undefined') return false;
  const capacitor = window.Capacitor;
  return capacitor !== undefined && capacitor.isNativePlatform() === true;
}

export async function getNativePushStatus(): Promise<NativePushResult> {
  if (!isNativePlatform()) return unavailable('not-native');
  await installCapacitorNativeBridge();
  return normalizeNativeStatus(await getNativeStatus());
}

export async function registerNativePush(): Promise<NativePushResult> {
  if (!isNativePlatform()) return unavailable('not-native');
  await installCapacitorNativeBridge();
  return normalizeNativeStatus(await registerNativeStatus());
}

// Idempotent launch-time check: only re-register when the native side does not
// already hold a confirmed device token.
export async function ensureNativePushRegistered(): Promise<NativePushResult> {
  if (!isNativePlatform()) return unavailable('not-native');
  const status = await getNativePushStatus();
  return status.status === 'connected' ? status : registerNativePush();
}

// Logout / host reset. Removes THIS device's server registration (scoped by the
// server to the session user) and every local secret, so no notification can
// arrive for the previous account. Other devices keep their own registrations.
export async function clearNativePush(): Promise<void> {
  if (!isNativePlatform()) return;
  try {
    await installCapacitorNativeBridge();
    const status = await getNativeStatus();
    if (status !== null && typeof status.deviceId === 'string') {
      await api.removePushDevice(status.deviceId).catch(() => undefined);
    }
    const notifications = getNotifications();
    if (notifications !== null && notifications.clear !== undefined) {
      await notifications.clear().catch(() => undefined);
    }
  } catch {
    // Never block sign-out on push cleanup.
  }
}

// Combined state for the settings card: the transport/registration status plus
// the device-side delivery facts (alarm permission, battery optimization, live
// socket state) the UI turns into actionable warnings.
export async function getInstantPushState(): Promise<InstantPushState> {
  if (!isNativePlatform()) {
    return {
      platformSupported: false,
      status: 'unavailable',
      transport: null,
      deviceId: null,
      hasDeviceToken: false,
      hasEndpoint: false,
      live: null,
      exactAlarmsGranted: null,
      batteryOptimized: null,
    };
  }

  await installCapacitorNativeBridge();
  const [native, reminders] = await Promise.all([
    getNativeStatus(),
    getNativeReminderStatus(),
  ]);
  const nativeResult = normalizeNativeStatus(native);

  return {
    platformSupported: true,
    status: nativeResult.status,
    transport: nativeResult.transport,
    deviceId: nativeResult.deviceId,
    hasDeviceToken: native !== null && native.hasDeviceToken === true,
    hasEndpoint: native !== null && native.hasEndpoint === true,
    live: reminders === null ? null : readString(reminders.live),
    exactAlarmsGranted: reminders === null ? null : readBoolean(reminders.exactAlarmsGranted),
    batteryOptimized: reminders === null ? null : readBoolean(reminders.batteryOptimized),
  };
}

// Opens the live-push channel settings, where the low-priority foreground card
// Android requires can be hidden without stopping the live socket.
export async function openLiveChannelSettings(): Promise<boolean> {
  if (!isNativePlatform()) return false;
  await installCapacitorNativeBridge();
  const notifications = getNotifications();
  if (notifications === null || notifications.openLiveChannelSettings === undefined) return false;
  try {
    await notifications.openLiveChannelSettings();
    return true;
  } catch {
    return false;
  }
}
