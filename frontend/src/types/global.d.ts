// Bridge exposed by the native (Capacitor/Electron) shells. Optional because the
// web build runs without any native host.
export {};

declare global {
  interface Window {
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
}
