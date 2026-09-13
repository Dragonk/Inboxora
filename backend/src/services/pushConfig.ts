// Server-side push configuration shared by the routes, the device registry and
// the native transports.
//
// The public UnifiedPush base is:
//   - PUSH_BASE_URL when set (advanced: an external ntfy), otherwise
//   - ${APP_URL} itself (the default single-domain setup).
//
// It is the ORIGIN, not a /push path: the ntfy Android distributor rejects any
// base URL that contains a path (ntfy-android validBaseUrl), and the ntfy server
// itself also refuses a base-url with a path. Inboxora therefore proxies only
// the UnifiedPush topic namespace ("up" + 12 base62 characters) and ntfy's /v1
// API at the origin, and keeps /push/ as a compatibility alias. The endpoint is
// generated on the phone as "<base>/<up-topic>?up=1", so this value is what the
// settings screen shows and what the user enters into ntfy.

function trimTrailingSlashes(value) {
  return typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
}

export function configuredAppUrl() {
  return trimTrailingSlashes(process.env.APP_URL);
}

export function pushBaseUrl() {
  const explicit = trimTrailingSlashes(process.env.PUSH_BASE_URL);
  if (explicit) return explicit;
  return configuredAppUrl() || null;
}

// Off by default: a logged-in user must not be able to aim the server at an
// internal address (SSRF). Self-hosted LAN installs opt in.
export function allowPrivatePushEndpoints() {
  return process.env.PUSH_ALLOW_PRIVATE_ENDPOINTS === 'true';
}
