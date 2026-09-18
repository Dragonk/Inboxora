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

  constructor(input: {
    code: ApiProblemCode;
    message: string;
    status: number;
    retryable?: boolean;
    retryAfterSeconds?: number;
    providerReason?: string;
  }) {
    super(input.message);
    this.name = 'GoogleApiError';
    this.code = input.code;
    this.status = input.status;
    this.retryable = input.retryable ?? false;
    if (input.retryAfterSeconds !== undefined) this.retryAfterSeconds = input.retryAfterSeconds;
    if (input.providerReason !== undefined) this.providerReason = input.providerReason;
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
  };
}

/** Google's `reason` values that mean "slow down / quota", not "not allowed". */
const RATE_LIMIT_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'quotaExceeded',
  'dailyLimitExceeded',
]);

function retryAfterSeconds(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : undefined;
}

/** Map a failed Google response to the domain problem code. */
export function classifyGoogleError(status: number, body: unknown, headers: Headers): GoogleApiError {
  const parsed = (body ?? {}) as GoogleErrorBody;
  const reason = parsed.error?.errors?.[0]?.reason ?? parsed.error?.status;
  const message = parsed.error?.message || `Google API returned ${status}`;
  const after = retryAfterSeconds(headers);
  if (status === 401) {
    return new GoogleApiError({ code: 'PROVIDER_AUTH_REQUIRED', message, status, retryable: false, providerReason: reason });
  }
  if (status === 403) {
    // A 403 is not automatically an expired account: it can be a quota/policy signal.
    if (reason && RATE_LIMIT_REASONS.has(reason)) {
      return new GoogleApiError({ code: 'RATE_LIMITED', message, status, retryable: true, retryAfterSeconds: after, providerReason: reason });
    }
    return new GoogleApiError({ code: 'INSUFFICIENT_SCOPES', message, status, retryable: false, providerReason: reason });
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
 * Perform an authenticated GET (or another method) against a Google API URL.
 * `init.body` must already be serialised; this helper only attaches auth.
 */
export async function googleApiFetch<T>(options: GoogleApiOptions, url: string, init: RequestInit = {}): Promise<T> {
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

  if (!response.ok) {
    throw classifyGoogleError(response.status, await parseBody(response), response.headers);
  }
  return await response.json() as T;
}

/** Build a URL with only the defined query parameters. */
export function googleUrl(base: string, path: string, params: Record<string, string | number | boolean | null | undefined>): string {
  const url = new URL(`${base}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  return url.toString();
}
