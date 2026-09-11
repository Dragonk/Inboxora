// Server-side push configuration shared by the routes, the device registry and
// the native transports.
//
// The public UnifiedPush base is:
//   - PUSH_BASE_URL when set (advanced: an external ntfy), otherwise
//   - ${APP_URL}/push (the default single-domain setup).
//
// The endpoint itself is generated on the phone: the Android ntfy app builds
// "<base>/<up-topic>?up=1" from the server URL the user typed, so this value is
// what the settings screen shows and what the user enters into ntfy.

function trimTrailingSlashes(value) {
  return typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
}

export function configuredAppUrl() {
  return trimTrailingSlashes(process.env.APP_URL);
}

export function pushBaseUrl() {
  const explicit = trimTrailingSlashes(process.env.PUSH_BASE_URL);
  if (explicit) return explicit;
  const appUrl = configuredAppUrl();
  return appUrl ? `${appUrl}/push` : null;
}

// Off by default: a logged-in user must not be able to aim the server at an
// internal address (SSRF). Self-hosted LAN installs opt in.
export function allowPrivatePushEndpoints() {
  return process.env.PUSH_ALLOW_PRIVATE_ENDPOINTS === 'true';
}
