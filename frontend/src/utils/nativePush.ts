import { api } from './api.ts';
import { installCapacitorNativeBridge } from './capacitorNativeBridge.ts';

// Native (Android) push lifecycle, driven from JS but executed natively.
//
// The provider registration (UnifiedPush endpoint or FCM token) and the server
// POST /api/push/devices are owned by the native layer, because a new endpoint
// can arrive while the WebView process does not exist. JS is the coordinator:
// it triggers a refresh after login/host change and clears the device
// registration on logout, so the server never keeps a subscription for a session
// the user has left.

type NativeStatus = {
  status?: string;
  deviceId?: string;
  [key: string]: unknown;
};

type NativeNotifications = {
  getStatus?: () => Promise<NativeStatus>;
  register?: () => Promise<NativeStatus>;
  clear?: () => Promise<NativeStatus>;
  openDistributor?: () => Promise<NativeStatus>;
  openInstallPage?: () => Promise<NativeStatus>;
  openHelp?: () => Promise<NativeStatus>;
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
  distributor: string | null;
  distributorLabel: string | null;
  distributors: string[];
  hasEndpoint: boolean;
  pushBaseUrl: string | null;
  nativeTransports: string[] | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item): item is string => typeof item === 'string') ? value : [];
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
// already hold a confirmed endpoint + device token.
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

// Combined state for the settings card: native distributor/permission info plus
// the server's advertised UnifiedPush base URL (the value to type into ntfy).
// The server value wins; when the server has no APP_URL configured, the current
// origin is the best local guess for a single-domain install.
export async function getInstantPushState(): Promise<InstantPushState> {
  if (!isNativePlatform()) {
    return {
      platformSupported: false,
      status: 'unavailable',
      transport: null,
      deviceId: null,
      distributor: null,
      distributorLabel: null,
      distributors: [],
      hasEndpoint: false,
      pushBaseUrl: null,
      nativeTransports: null,
    };
  }

  await installCapacitorNativeBridge();
  const [native, serverResult] = await Promise.all([
    getNativeStatus(),
    api.getPushStatus().catch((): null => null),
  ]);
  const server: unknown = serverResult;
  const serverStatus = isRecord(server) ? server : null;
  const nativeResult = normalizeNativeStatus(native);
  const nativeRecord: Record<string, unknown> | null = native;
  const serverPushBaseUrl = serverStatus === null ? null : readString(serverStatus.pushBaseUrl);
  const origin = window.location.origin;

  return {
    platformSupported: true,
    status: nativeResult.status,
    transport: nativeResult.transport,
    deviceId: nativeResult.deviceId,
    distributor: nativeRecord === null ? null : readString(nativeRecord.distributor),
    distributorLabel: nativeRecord === null ? null : readString(nativeRecord.distributorLabel),
    distributors: nativeRecord === null ? [] : readStringArray(nativeRecord.distributors),
    hasEndpoint: nativeRecord !== null && readBoolean(nativeRecord.hasEndpoint),
    pushBaseUrl: serverPushBaseUrl === null ? origin : serverPushBaseUrl,
    nativeTransports: serverStatus === null ? null : readStringArray(serverStatus.nativeTransports),
  };
}

export async function openPushDistributor(): Promise<boolean> {
  if (!isNativePlatform()) return false;
  await installCapacitorNativeBridge();
  const notifications = getNotifications();
  if (notifications === null || notifications.openDistributor === undefined) return false;
  try {
    const result = await notifications.openDistributor();
    return readBoolean(result.opened);
  } catch {
    return false;
  }
}

async function openNativePushPage(action: 'install' | 'help'): Promise<void> {
  if (!isNativePlatform()) return;
  await installCapacitorNativeBridge();
  const notifications = getNotifications();
  if (notifications === null) return;
  const open = action === 'install' ? notifications.openInstallPage : notifications.openHelp;
  if (open === undefined) return;
  await open().catch(() => undefined);
}

export async function openPushInstallPage(): Promise<void> {
  await openNativePushPage('install');
}

export async function openPushHelp(): Promise<void> {
  await openNativePushPage('help');
}
