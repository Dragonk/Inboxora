// Bridge exposed by the native (Capacitor/Electron) shells. Optional because the
// web build runs without any native host.
export {};

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
    inboxoraNative?: any;
    // Capacitor runtime, present only inside the native shells.
    Capacitor?: any;
    // Legacy Safari/WebKit AudioContext constructor.
    webkitAudioContext?: any;
    // Android hardware-back handler installed by the native shell bridge.
    __inboxoraHandleAndroidBack?: any;
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
