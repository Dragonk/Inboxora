// Bridge exposed by the native (Capacitor/Electron) shells. Optional because the
// web build runs without any native host.
export {};

declare global {
  interface Window {
    inboxoraNative?: any;
  }
}
