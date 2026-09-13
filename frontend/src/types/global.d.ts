// Bridge exposed by the native (Capacitor/Electron) shells. Optional because the
// web build runs without any native host.
export {};

interface InboxoraNativeStatus {
  deviceId?: string;
  status?: string;
  enabled?: boolean;
  [key: string]: unknown;
}

interface InboxoraNativePushNotification {
  type?: string;
  title?: string;
  body?: string;
  message?: string;
  [key: string]: unknown;
}

interface InboxoraNativeUpdateData {
  filePath?: string;
  updatePath?: string;
  installCommand?: string;
  [key: string]: unknown;
}

interface InboxoraNativeUpdateStatus {
  type?: string;
  data?: InboxoraNativeUpdateData;
  [key: string]: unknown;
}

interface InboxoraNativeNotifications {
  checkPermission?(): Promise<string>;
  requestPermission?(): Promise<NotificationPermission>;
  showNewMail?(payload: unknown): Promise<unknown>;
  getStatus?(): Promise<InboxoraNativeStatus>;
  register?(): Promise<InboxoraNativeStatus>;
  clear?(): Promise<InboxoraNativeStatus>;
  openDistributor?(): Promise<InboxoraNativeStatus>;
  openInstallPage?(): Promise<InboxoraNativeStatus>;
  openHelp?(): Promise<InboxoraNativeStatus>;
  openSettings?(): Promise<InboxoraNativeStatus>;
  onPush?(callback: (notification: InboxoraNativePushNotification) => void): () => void;
}

interface InboxoraNativeBadges {
  setUnreadCount?(count: number): Promise<unknown>;
}

interface InboxoraNativeCopyResult {
  copied?: boolean;
  reason?: string;
  installCommand?: string;
  [key: string]: unknown;
}

interface InboxoraNativeInstallResult {
  installed?: boolean;
  reason?: string;
  [key: string]: unknown;
}

interface InboxoraNativeUpdates {
  check?(foreground?: boolean): Promise<unknown>;
  onStatus?(callback: (status: InboxoraNativeUpdateStatus) => void): () => void;
  copyInstallCommandAndQuit?(options: unknown): Promise<InboxoraNativeCopyResult>;
  installDownloaded?(): Promise<InboxoraNativeInstallResult>;
  installAuto?(): Promise<InboxoraNativeInstallResult>;
  openDownload?(): Promise<unknown>;
}

interface InboxoraNativeActions {
  ack?(id: string): Promise<unknown>;
  onAction?(callback: (payload: unknown) => void): () => void;
  getPending?(): Promise<Array<{ id?: string; type?: string; [key: string]: unknown }>>;
}

interface InboxoraNativeBridge {
  platform?: string;
  getHost?(): Promise<unknown>;
  saveHost?(host: string): Promise<unknown>;
  resetHost?(): Promise<unknown>;
  notifications?: InboxoraNativeNotifications;
  badges?: InboxoraNativeBadges;
  updates?: InboxoraNativeUpdates;
  actions?: InboxoraNativeActions;
}

interface CapacitorRuntime {
  isNativePlatform(): boolean;
  [key: string]: unknown;
}

declare global {
  interface Error {
    status?: number;
    statusCode?: number;
    code?: string;
    details?: unknown;
    source?: string;
    sync?: unknown;
    signedOut?: boolean;
  }

  interface Navigator {
    // iOS standalone (home-screen web app) flag.
    standalone?: boolean;
  }

  interface Window {
    // Native bridge handshake flags (Electron/Capacitor shells).
    __inboxoraNativeBridgeReady?: boolean;
    __inboxoraPendingNativeActions?: unknown[];
    __mailflowPendingNativeActions?: unknown[];
    inboxoraNative?: InboxoraNativeBridge;
    // Capacitor runtime, present only inside the native shells.
    Capacitor?: CapacitorRuntime;
    // Legacy Safari/WebKit AudioContext constructor.
    webkitAudioContext?: typeof AudioContext;
    // Android hardware-back handler installed by the native shell bridge.
    __inboxoraHandleAndroidBack?: () => void;
  }
}

// Allow CSS custom properties (design tokens such as --right-sidebar-header-height)
// in React style objects, which csstype's Properties type does not include.
declare module 'react' {
  interface CSSProperties {
    [key: `--${string}`]: string | number | undefined;
  }

  // The installed React 18 type definitions predate the inert attribute, which the
  // mobile sidebar relies on to keep hidden content out of the a11y tree.
  // The type parameter must be named exactly 'T' (and stay "unused"): interface
  // merging requires identical type parameter lists.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface HTMLAttributes<T> {
    inert?: boolean;
  }
}
