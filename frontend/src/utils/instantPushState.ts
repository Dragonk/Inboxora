// Pure view-model for the "Instant notifications" settings card.
//
// Keeping the branching here (instead of inside JSX) makes every state -
// unsupported, permission denied, registration pending, connected - and the
// delivery warnings (battery optimization, exact-alarm permission, live
// socket) unit-testable without a device.
//
//   unsupported       not a Capacitor native platform (web/PWA or desktop)
//   permission_denied Android notification permission is off
//   pending           the live/FCM registration is not confirmed yet
//   connected         device token registered and the transport active
type PushState = Record<string, unknown>;

export type InstantPushWarnings = {
  battery: boolean;
  exactAlarms: boolean;
  liveNotRunning: boolean;
};

export type InstantPushView =
  | { kind: 'unsupported' }
  | { kind: 'permission_denied'; showSettings: boolean; showRetry: boolean; warnings: InstantPushWarnings }
  | { kind: 'pending'; transport: string | null; showRetry: boolean; warnings: InstantPushWarnings }
  | { kind: 'connected'; transport: string | null; showRetry: boolean; warnings: InstantPushWarnings };

function isPushState(value: unknown): value is PushState {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function deriveInstantPushView(state: unknown): InstantPushView {
  if (!isPushState(state) || state.platformSupported !== true) return { kind: 'unsupported' };

  // Delivery warnings. The alarm permission and the battery exemption matter in
  // every state; the live-socket warning only makes sense for the built-in live
  // transport - FCM builds deliberately do not hold the socket, the provider
  // wakes them instead.
  const transport = readNonEmptyString(state.transport);
  const warnings: InstantPushWarnings = {
    battery: state.batteryOptimized === true,
    exactAlarms: state.exactAlarmsGranted === false,
    liveNotRunning: transport === 'live' && readNonEmptyString(state.live) !== 'connected',
  };

  if (state.status === 'permission_denied') {
    return { kind: 'permission_denied', showSettings: true, showRetry: false, warnings };
  }

  if (state.status === 'connected') {
    return { kind: 'connected', transport, showRetry: false, warnings };
  }

  return { kind: 'pending', transport, showRetry: true, warnings };
}
