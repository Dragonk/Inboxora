import { getGoogleAccessToken } from '../../providerTokenService.js';
import type { FetchLike, GoogleConfig } from '../../providerAuthService.js';
import type { ApiProblemCode } from '../contracts.js';

/**
 * Authenticated Google API access for the provider adapters (P09).
 *
 * The adapter never sees a token: it asks for one through the grant/token
 * service, which refreshes single-flight. A 401 triggers exactly one controlled
 * re-read (forcing a refresh) before the failure is surfaced, and every provider
 * error is mapped to the domain's closed code set so callers can decide between
 * "retry later", "re-authorize" and "give up".
 */

export const GOOGLE_API_TIMEOUT_MS = 20_000;

export class GoogleApiError extends Error {
  readonly code: ApiProblemCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
  readonly providerReason?: string;
  readonly providerService?: string;

  constructor(input: {
    code: ApiProblemCode;
    message: string;
    status: number;
    retryable?: boolean;
    retryAfterSeconds?: number;
    providerReason?: string;
    providerService?: string;
  }) {
    super(input.message);
    this.name = 'GoogleApiError';
    this.code = input.code;
    this.status = input.status;
    this.retryable = input.retryable ?? false;
    if (input.retryAfterSeconds !== undefined) this.retryAfterSeconds = input.retryAfterSeconds;
    if (input.providerReason !== undefined) this.providerReason = input.providerReason;
    if (input.providerService !== undefined) this.providerService = input.providerService;
  }
}

export interface GoogleApiOptions {
  userId: string;
  connectionId: string;
  config: GoogleConfig;
  fetchImpl?: FetchLike;
  owner?: string;
}

interface GoogleErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    errors?: Array<{ reason?: string; message?: string }>;
    /**
     * Structured error details (`google.rpc.ErrorInfo`). The People API reports an out-of-date sync token here
     * as `reason: EXPIRED_SYNC_TOKEN` even when the HTTP status is not 410, and that is the documented signal
     * for "your sync token expired, do a full sync" (SYNC-07).
     */
    details?: Array<{ '@type'?: string; reason?: string; domain?: string; metadata?: Record<string, string> }>;
  };
}

/** `google.rpc.ErrorInfo` reasons that mean the stored synchronization cursor is no longer usable. */
const EXPIRED_SYNC_TOKEN_REASONS = new Set(['EXPIRED_SYNC_TOKEN', 'SYNC_TOKEN_EXPIRED']);

/**
 * The provider's own "the sync token expired" signal, read from the structured details rather than inferred
 * from the status code: the People API documents `EXPIRED_SYNC_TOKEN` and the status it arrives with is not
 * part of the contract.
 */
function expiredSyncTokenReason(body: GoogleErrorBody): string | null {
  for (const detail of body.error?.details ?? []) {
    if (detail['@type'] && !detail['@type'].includes('google.rpc.ErrorInfo')) continue;
    if (detail.reason && EXPIRED_SYNC_TOKEN_REASONS.has(detail.reason)) return detail.reason;
  }
  return null;
}

/** Google's `reason` values that mean "slow down / quota", not "not allowed". */
const RATE_LIMIT_REASONS = new Set([
  'ratelimitexceeded',
  'userratelimitexceeded',
  'quotaexceeded',
  'dailylimitexceeded',
]);

// Google can put these in legacy `errors[]` or structured `google.rpc.ErrorInfo`.
const API_DISABLED_REASONS = new Set(['service_disabled', 'servicedisabled', 'accessnotconfigured']);
const SCOPE_REASONS = new Set(['insufficientpermissions', 'insufficientauthenticationscopes', 'authentication_scope_insufficient']);
const ACCESS_DENIED_REASONS = new Set(['accessdenied', 'forbidden', 'acl_denied']);

/** Gather all structured and legacy reasons; never let array order decide the diagnosis. */
function googleReasons(body: GoogleErrorBody): string[] {
  return [...new Set([
    ...(body.error?.errors ?? []).map(entry => entry.reason),
    body.error?.status,
    ...(body.error?.details ?? []).map(detail => detail.reason),
  ].filter((reason): reason is string => typeof reason === 'string' && reason.trim() !== '')
    .map(reason => reason.trim()))];
}

function normalizedReasons(reasons: readonly string[]): Set<string> {
  return new Set(reasons.map(reason => reason.toLowerCase()));
}

function errorInfoService(body: GoogleErrorBody): string | undefined {
  const service = body.error?.details?.find(detail => detail['@type']?.includes('google.rpc.ErrorInfo'))?.metadata?.service;
  return typeof service === 'string' && /^[a-z0-9.-]{1,120}$/i.test(service) ? service : undefined;
}

function retryAfterSeconds(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : undefined;
}

/** Map a failed Google response to the domain problem code. */
export function classifyGoogleError(status: number, body: unknown, headers: Headers): GoogleApiError {
  const parsed = (body ?? {}) as GoogleErrorBody;
  const reasons = googleReasons(parsed);
  const reason = reasons[0];
  const normalized = normalizedReasons(reasons);
  const message = parsed.error?.message || `Google API returned ${status}`;
  const after = retryAfterSeconds(headers);
  const providerService = errorInfoService(parsed);
  // The structured expiry signal wins over the status: a full rebuild is the only correct answer whatever the
  // transport answered with (SYNC-07).
  const expired = expiredSyncTokenReason(parsed);
  if (expired) {
    return new GoogleApiError({ code: 'INVALID_SYNC_CURSOR', message, status, providerReason: expired });
  }
  if (status === 401) {
    return new GoogleApiError({ code: 'PROVIDER_AUTH_REQUIRED', message, status, retryable: false, providerReason: reason });
  }
  if (status === 403) {
    // Precedence is evidence-based. A generic PERMISSION_DENIED is deliberately not
    // treated as consent: it does not identify whether the project, ACL or policy refused.
    if ([...normalized].some(value => RATE_LIMIT_REASONS.has(value))) {
      return new GoogleApiError({ code: 'RATE_LIMITED', message, status, retryable: true, retryAfterSeconds: after, providerReason: reason });
    }
    if ([...normalized].some(value => API_DISABLED_REASONS.has(value))) {
      return new GoogleApiError({ code: 'PROVIDER_API_DISABLED', message, status, providerReason: reason, providerService });
    }
    if ([...normalized].some(value => SCOPE_REASONS.has(value))) {
      return new GoogleApiError({ code: 'INSUFFICIENT_SCOPES', message, status, providerReason: reason });
    }
    if ([...normalized].some(value => ACCESS_DENIED_REASONS.has(value))) {
      return new GoogleApiError({ code: 'PROVIDER_ACCESS_DENIED', message, status, providerReason: reason });
    }
    return new GoogleApiError({ code: 'PROVIDER_FORBIDDEN', message, status, providerReason: reason });
  }
  if (status === 404) return new GoogleApiError({ code: 'RESOURCE_NOT_FOUND', message, status, providerReason: reason });
  if (status === 410) {
    // An expired sync token: the caller must reconcile this collection.
    return new GoogleApiError({ code: 'INVALID_SYNC_CURSOR', message, status, providerReason: reason });
  }
  if (status === 429) {
    return new GoogleApiError({ code: 'RATE_LIMITED', message, status, retryable: true, retryAfterSeconds: after, providerReason: reason });
  }
  if (status >= 500) {
    return new GoogleApiError({ code: 'UPSTREAM_UNAVAILABLE', message, status, retryable: true, retryAfterSeconds: after, providerReason: reason });
  }
  return new GoogleApiError({ code: 'INTERNAL_ERROR', message, status, providerReason: reason });
}

async function parseBody(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

/**
 * Perform an authenticated request against a Google API URL and hand back the raw
 * response.
 *
 * This is the one place the token is attached, so every Google adapter — the
 * Calendar/People reads and the Gmail REST calls — shares the same single-flight
 * refresh and the same one controlled 401 retry. The raw form exists because not
 * every answer carries a JSON body: Gmail's `labels.delete` and `messages.delete`
 * answer `204`, and the base64url `raw` upload answers only on success.
 *
 * `init.body` must already be serialised; this helper only attaches auth and the
 * timeout.
 */
export async function googleApiRequest(options: GoogleApiOptions, url: string, init: RequestInit = {}): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const send = async (accessToken: string): Promise<Response> => fetchImpl(url, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(GOOGLE_API_TIMEOUT_MS),
  });

  let token = await getGoogleAccessToken({
    userId: options.userId,
    connectionId: options.connectionId,
    config: options.config,
    ...(options.owner ? { owner: options.owner } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  let response = await send(token.accessToken);

  if (response.status === 401) {
    // At most one controlled refresh and retry: the cached token may have been
    // revoked between the validity check and the call.
    token = await getGoogleAccessToken({
      userId: options.userId,
      connectionId: options.connectionId,
      config: options.config,
      ...(options.owner ? { owner: options.owner } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      // A margin larger than any token lifetime forces one refresh.
      skewSeconds: 60 * 60 * 24 * 365,
    });
    response = await send(token.accessToken);
  }

  return response;
}

/** Throw the classified provider error for a failed response. */
async function throwForGoogleStatus(response: Response): Promise<never> {
  throw classifyGoogleError(response.status, await parseBody(response), response.headers);
}

/**
 * Perform an authenticated request and decode its JSON body. A `204`/empty answer
 * is a success with no body, so it decodes to `null` rather than failing.
 */
export async function googleApiJson<T>(options: GoogleApiOptions, url: string, init: RequestInit = {}): Promise<T | null> {
  const response = await googleApiRequest(options, url, init);
  if (!response.ok) await throwForGoogleStatus(response);
  if (response.status === 204) return null;
  return await response.json().catch(() => null) as T | null;
}

/** Perform an authenticated request whose success carries no body. */
export async function googleApiVoid(options: GoogleApiOptions, url: string, init: RequestInit = {}): Promise<void> {
  const response = await googleApiRequest(options, url, init);
  if (!response.ok) await throwForGoogleStatus(response);
}

/**
 * Perform an authenticated GET (or another method) against a Google API URL.
 * `init.body` must already be serialised; this helper only attaches auth.
 */
export async function googleApiFetch<T>(options: GoogleApiOptions, url: string, init: RequestInit = {}): Promise<T> {
  const response = await googleApiRequest(options, url, init);
  if (!response.ok) await throwForGoogleStatus(response);
  return await response.json() as T;
}

/**
 * Build a URL with only the defined query parameters. A value that is an array is
 * appended once per element, which is how Google's `metadataHeaders[]` and similar
 * repeated parameters are expressed.
 */
export function googleUrl(
  base: string,
  path: string,
  params: Record<string, string | number | boolean | readonly string[] | null | undefined>,
): string {
  const url = new URL(`${base}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry !== '') url.searchParams.append(key, String(entry));
      }
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}
