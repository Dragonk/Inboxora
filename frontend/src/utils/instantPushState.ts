// Pure view-model for the "Instant notifications" settings card.
//
// Keeping the branching here (instead of inside JSX) makes every state — no
// distributor, distributor installed but not connected, connected, permission
// denied, unsupported — unit-testable without a device.
//
//   unsupported       not a Capacitor native platform (web/PWA or desktop)
//   permission_denied Android notification permission is off
//   no_distributor    no UnifiedPush distributor app (e.g. ntfy) is installed
//   pending           a distributor is installed but registration is not done yet
//   connected         endpoint registered and a device token issued
export function deriveInstantPushView(state) {
  if (!state?.platformSupported) return { kind: 'unsupported' };

  const pushBaseUrl = state.pushBaseUrl || null;
  const distributorName = state.distributorLabel || null;

  if (state.status === 'permission_denied') {
    return { kind: 'permission_denied', showSettings: true, showRetry: false };
  }

  const distributorPackages = Array.isArray(state.distributors) ? state.distributors : [];
  const hasDistributor = distributorPackages.length > 0 || !!state.distributor;

  if (state.status === 'connected') {
    return {
      kind: 'connected',
      distributorName,
      transport: state.transport || null,
      pushBaseUrl,
      showSettings: false,
      showRetry: false,
    };
  }

  if (hasDistributor) {
    return {
      kind: 'pending',
      distributorName,
      pushBaseUrl,
      showOpenDistributor: true,
      showRetry: true,
      showInstall: false,
    };
  }

  // No distributor: explain the extra app instead of surfacing a technical error.
  return {
    kind: 'no_distributor',
    pushBaseUrl,
    showInstall: true,
    showHelp: true,
    showRetry: false,
  };
}
