// Native push transports for the Android (and future native) clients.
//
// A transport is a pure sender: it takes a decrypted device endpoint and the
// opaque mail.changed event and reports a delivery verdict. It never touches the
// database — pruning/backoff live in the dispatcher — and it never logs an
// endpoint/token. Adding a provider means adding one function here, not touching
// mail sync or the routes.
//
// Supported:
//   - unifiedpush: an HTTP POST to the endpoint a UnifiedPush distributor gave
//     the app. Fully self-hosted: the user chooses (or runs) the distributor and
//     the Inboxora server is the only sender. Preferred transport.
//   - fcm: Google Firebase Cloud Messaging HTTP v1, for Android builds that were
//     compiled with their own google-services.json and a server Firebase project.
//     Optional; the server must be given its own service-account credentials.
import { SignJWT, importPKCS8 } from 'jose';
import { safeFetch } from './safeFetch.js';

export const TRANSPORT_INVALID = 'invalid';     // permanent: drop the registration
export const TRANSPORT_RETRY = 'retry';         // transient: keep it, count the failure
export const TRANSPORT_DELIVERED = 'delivered';
export const TRANSPORT_DISABLED = 'disabled';   // transport not configured

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── UnifiedPush ──────────────────────────────────────────────────────────────

// A distributor on a private LAN (self-hosted ntfy) is opt-in, because allowing
// arbitrary private endpoints by default would turn this into an SSRF primitive.
function allowPrivateEndpoints() {
  return process.env.PUSH_ALLOW_PRIVATE_ENDPOINTS === 'true';
}

export async function sendUnifiedPush(device, event) {
  if (!device?.endpoint || !event) return TRANSPORT_DISABLED;

  let response;
  try {
    response = await safeFetch(device.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(10000),
    }, { allowPrivate: allowPrivateEndpoints(), requireHttps: !allowPrivateEndpoints() });
  } catch (err) {
    // A blocked/private endpoint is a permanent rejection (SSRF guard); every
    // other network error is transient and worth retrying later.
    if (err?.code === 'ERR_BLOCKED_PRIVATE_IP' || err?.code === 'ERR_INSECURE_TRANSPORT' || err?.code === 'ERR_UNSUPPORTED_SCHEME') {
      return TRANSPORT_INVALID;
    }
    return TRANSPORT_RETRY;
  }

  if (response.status === 404 || response.status === 410) return TRANSPORT_INVALID;
  if (response.status === 429 || response.status >= 500) return TRANSPORT_RETRY;
  if (!response.ok) return TRANSPORT_RETRY;
  return TRANSPORT_DELIVERED;
}

// ── FCM HTTP v1 ──────────────────────────────────────────────────────────────

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const FCM_TOKEN_URL = 'https://oauth2.googleapis.com/token';

let cachedServiceAccount = null;
let cachedServiceAccountRaw = null;
let cachedAccessToken = null;
let cachedAccessTokenExpiry = 0;

export function parseServiceAccount(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let text = raw.trim();
  // Accept either raw JSON or a base64-encoded service-account file.
  if (!text.startsWith('{')) {
    try { text = Buffer.from(text, 'base64').toString('utf8'); } catch { return null; }
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed.project_id || !parsed.client_email || !parsed.private_key) return null;
    return {
      projectId: parsed.project_id,
      clientEmail: parsed.client_email,
      privateKey: String(parsed.private_key).replace(/\\n/g, '\n'),
    };
  } catch {
    return null;
  }
}

function serviceAccount() {
  const raw = process.env.FCM_SERVICE_ACCOUNT_JSON || '';
  if (!raw) return null;
  if (cachedServiceAccountRaw === raw) return cachedServiceAccount;
  cachedServiceAccountRaw = raw;
  cachedServiceAccount = parseServiceAccount(raw);
  if (!cachedServiceAccount) console.warn('FCM disabled: FCM_SERVICE_ACCOUNT_JSON could not be parsed.');
  return cachedServiceAccount;
}

export const fcmConfigured = () => !!serviceAccount();

async function fcmAccessToken(account) {
  if (cachedAccessToken && Date.now() < cachedAccessTokenExpiry) return cachedAccessToken;

  const key = await importPKCS8(account.privateKey, 'RS256');
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({ scope: FCM_SCOPE })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(account.clientEmail)
    .setSubject(account.clientEmail)
    .setAudience(FCM_TOKEN_URL)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);

  const response = await fetch(FCM_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`FCM OAuth token request failed (HTTP ${response.status})`);
  const data = await response.json();
  if (!data.access_token) throw new Error('FCM OAuth response did not contain an access token');
  cachedAccessToken = data.access_token;
  cachedAccessTokenExpiry = Date.now() + Math.max(60, Number(data.expires_in) || 3600) * 1000 - 60000;
  return cachedAccessToken;
}

export async function sendFcmPush(device, event) {
  const account = serviceAccount();
  if (!account || !device?.endpoint || !event) return TRANSPORT_DISABLED;

  let accessToken;
  try {
    accessToken = await fcmAccessToken(account);
  } catch (err) {
    console.warn('FCM credential error:', err.message);
    return TRANSPORT_RETRY;
  }

  const body = {
    message: {
      token: device.endpoint,
      data: { type: String(event.type || 'mail.changed'), eventId: String(event.eventId || '') },
      android: { priority: 'high', ttl: '3600s' },
    },
  };

  let response;
  try {
    response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.projectId)}/messages:send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    return TRANSPORT_RETRY;
  }

  if (response.ok) return TRANSPORT_DELIVERED;

  if (response.status === 404) return TRANSPORT_INVALID;
  if (response.status === 401 || response.status === 403) {
    // Server misconfiguration (wrong project/credentials) — never the device's fault.
    console.warn(`FCM rejected the server credentials (HTTP ${response.status}); check FCM_SERVICE_ACCOUNT_JSON.`);
    return TRANSPORT_RETRY;
  }
  if (response.status === 429 || response.status >= 500) return TRANSPORT_RETRY;

  // 400: the registration token is malformed/expired (UNREGISTERED, INVALID_ARGUMENT).
  const errorCode = await response.json().then((data) => data?.error?.details?.[0]?.errorCode || data?.error?.status).catch(() => null);
  if (response.status === 400 || errorCode === 'UNREGISTERED' || errorCode === 'INVALID_ARGUMENT') return TRANSPORT_INVALID;
  return TRANSPORT_RETRY;
}

export async function sendNativePush(device, event) {
  if (device?.transport === 'unifiedpush') return sendUnifiedPush(device, event);
  if (device?.transport === 'fcm') return sendFcmPush(device, event);
  return TRANSPORT_DISABLED;
}

export function transportStatus() {
  return { unifiedpush: true, fcm: fcmConfigured() };
}

export const _internal = { delay };
