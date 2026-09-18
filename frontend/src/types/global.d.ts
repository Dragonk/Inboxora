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

interface InboxoraNativeNotificationSettings {
  enabled?: boolean;
  [key: string]: unknown;
}

interface InboxoraNativeNotificationResult {
  shown?: boolean;
  reason?: string;
  [key: string]: unknown;
}

interface InboxoraNativeNotifications {
  checkPermission?(): Promise<string>;
  requestPermission?(): Promise<NotificationPermission>;
  showNewMail?(payload: unknown): Promise<unknown>;
  getSettings?(): Promise<InboxoraNativeNotificationSettings>;
  setEnabled?(enabled: boolean): Promise<InboxoraNativeNotificationSettings>;
  isSupported?(): Promise<boolean>;
  showTest?(payload?: { title?: string; body?: string }): Promise<InboxoraNativeNotificationResult>;
  getStatus?(): Promise<InboxoraNativeStatus>;
  register?(): Promise<InboxoraNativeStatus>;
  clear?(): Promise<InboxoraNativeStatus>;
  openDistributor?(): Promise<InboxoraNativeStatus>;
  openInstallPage?(): Promise<InboxoraNativeStatus>;
  openHelp?(): Promise<InboxoraNativeStatus>;
  openSettings?(): Promise<InboxoraNativeStatus>;
  onPush?(callback: (notification: InboxoraNativePushNotification) => void): () => void;
}

interface InboxoraNativeNavigationState {
  canGoBack?: boolean;
  canGoForward?: boolean;
  [key: string]: unknown;
}

interface InboxoraNativeNavigation {
  back?(): Promise<InboxoraNativeNavigationState>;
  forward?(): Promise<InboxoraNativeNavigationState>;
  getState?(): Promise<InboxoraNativeNavigationState>;
  onStateChanged?(callback: (state: InboxoraNativeNavigationState) => void): () => void;
}

interface InboxoraNativeTitlebar {
  height?: number;
  setTheme?(theme: { color: string; symbolColor: string }): Promise<{ applied?: boolean; height?: number }>;
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
  // 'electron' only in the Inboxora Electron shell; Capacitor Android omits it.
  shell?: string;
  platform?: string;
  getHost?(): Promise<unknown>;
  saveHost?(host: string): Promise<unknown>;
  resetHost?(): Promise<unknown>;
  notifications?: InboxoraNativeNotifications;
  badges?: InboxoraNativeBadges;
  updates?: InboxoraNativeUpdates;
  navigation?: InboxoraNativeNavigation;
  titlebar?: InboxoraNativeTitlebar;
  actions?: InboxoraNativeActions;
}

interface CapacitorRuntime {
  isNativePlatform(): boolean;
  [key: string]: unknown;
}

declare global {
  /**
   * Typed view of the globals node:test suites swap out. The members are
   * deliberately `unknown`: tests replace them with partial doubles, and no test
   * reads through this view (it only assigns and restores).
   */
  interface TestGlobals {
    fetch: unknown;
    localStorage: unknown;
    window: unknown;
  }

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
  // Declaration merging retains React's `T` parameter. The attribute applies to
  // HTML elements, so constrain its availability to element-backed attributes.
  interface HTMLAttributes<T> {
    inert?: T extends HTMLElement ? boolean : never;
  }
}
