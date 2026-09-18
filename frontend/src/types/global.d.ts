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
  /** Notification.isSupported() — the process can raise notifications. */
  supported?: boolean;
  /** Whether the OS itself will display them (Windows; 'unknown' elsewhere). */
  osState?: 'enabled' | 'disabled' | 'unknown' | 'unsupported';
  canOpenSystemSettings?: boolean;
  [key: string]: unknown;
}

interface InboxoraNativeNotificationResult {
  shown?: boolean;
  /** True only when Electron reported the native 'show' event. */
  confirmed?: boolean;
  reason?: string;
  error?: string;
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

interface InboxoraNativeMailtoSettings {
  /** Whether the shell can register itself as a mail handler (Windows only). */
  supported?: boolean;
  state?: 'default' | 'registered' | 'not-registered' | 'unsupported';
  isDefault?: boolean;
  /** The app Windows currently opens mailto: links with, or null. */
  currentHandler?: string | null;
  /** Deep link used by openSettings(): per-app page on Windows 11, general list on 10. */
  settingsUri?: string | null;
  canOpenSettings?: boolean;
  /** Windows 10/11 require the user to confirm the default app in Settings. */
  requiresUserConfirmation?: boolean;
  [key: string]: unknown;
}

interface InboxoraNativeMailto {
  getSettings?(): Promise<InboxoraNativeMailtoSettings>;
  /** Re-assert the registration so Inboxora is listed as an email app. */
  register?(): Promise<InboxoraNativeMailtoSettings>;
  openSettings?(): Promise<{ opened?: boolean }>;
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
  mailto?: InboxoraNativeMailto;
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
