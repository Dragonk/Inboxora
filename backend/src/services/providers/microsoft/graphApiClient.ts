import { getMicrosoftAccessToken } from '../../providerTokenService.js';
import { microsoftConfigFromEnv } from '../../providerAuthService.js';
import type { FetchLike } from '../../providerAuthService.js';
import type { ApiProblemCode } from '../contracts.js';

/**
 * Authenticated Microsoft Graph access for the adapters (P07).
 *
 * The adapter never sees a token: it asks the grant service, which refreshes
 * single-flight. A 401 triggers exactly one controlled re-read before the failure
 * is surfaced, and every Graph failure is mapped to the domain's closed code set so
 * callers can tell "retry later" from "re-authorize" from "give up".
 */

export const GRAPH_API_BASE = 'https://graph.microsoft.com/v1.0';
export const GRAPH_TIMEOUT_MS = 20_000;

export class GraphApiError extends Error {
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
    this.name = 'GraphApiError';
    this.code = input.code;
    this.status = input.status;
    this.retryable = input.retryable ?? false;
    if (input.retryAfterSeconds !== undefined) this.retryAfterSeconds = input.retryAfterSeconds;
    if (input.providerReason !== undefined) this.providerReason = input.providerReason;
  }
}

interface GraphErrorBody {
  error?: { code?: string; message?: string; innerError?: { code?: string } };
}

function retryAfterSeconds(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : undefined;
}

/** Map a failed Graph response to the domain problem code. */
export function classifyGraphError(status: number, body: unknown, headers: Headers): GraphApiError {
  const parsed = (body ?? {}) as GraphErrorBody;
  const reason = parsed.error?.innerError?.code ?? parsed.error?.code;
  const message = parsed.error?.message || `Microsoft Graph returned ${status}`;
  const after = retryAfterSeconds(headers);
  if (status === 401) {
    return new GraphApiError({ code: 'PROVIDER_AUTH_REQUIRED', message, status, providerReason: reason });
  }
  if (status === 403) {
    // Graph uses 403 both for a missing scope and for a policy/tenant restriction.
    return new GraphApiError({ code: 'INSUFFICIENT_SCOPES', message, status, providerReason: reason });
  }
  if (status === 404) return new GraphApiError({ code: 'RESOURCE_NOT_FOUND', message, status, providerReason: reason });
  if (status === 410) {
    // An expired delta token: the caller must reconcile this collection.
    return new GraphApiError({ code: 'INVALID_SYNC_CURSOR', message, status, providerReason: reason });
  }
  if (status === 429) {
    return new GraphApiError({ code: 'RATE_LIMITED', message, status, retryable: true, retryAfterSeconds: after, providerReason: reason });
  }
  if (status >= 500) {
    return new GraphApiError({ code: 'UPSTREAM_UNAVAILABLE', message, status, retryable: true, retryAfterSeconds: after, providerReason: reason });
  }
  return new GraphApiError({ code: 'INTERNAL_ERROR', message, status, providerReason: reason });
}

export interface GraphApiOptions {
  userId: string;
  connectionId: string;
  /** Overrides the environment configuration (tests inject one). */
  config?: ReturnType<typeof microsoftConfigFromEnv>;
  fetchImpl?: FetchLike;
  owner?: string;
}

async function accessToken(options: GraphApiOptions, skewSeconds?: number): Promise<string> {
  const result = await getMicrosoftAccessToken({
    userId: options.userId,
    connectionId: options.connectionId,
    config: options.config ?? microsoftConfigFromEnv(),
    ...(options.owner ? { owner: options.owner } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(skewSeconds !== undefined ? { skewSeconds } : {}),
  });
  return result.accessToken;
}

/**
 * Perform an authenticated GET against Graph. `url` may be a path (`/me/...`) or a
 * full URL, because Graph hands back absolute `@odata.nextLink` values.
 */
export async function graphGet<T>(options: GraphApiOptions, pathOrUrl: string): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${GRAPH_API_BASE}${pathOrUrl}`;
  const send = async (token: string): Promise<Response> => fetchImpl(url, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
  });

  let response = await send(await accessToken(options));
  if (response.status === 401) {
    // At most one controlled refresh and retry: the cached token may have been
    // revoked between the validity check and the call.
    response = await send(await accessToken(options, 60 * 60 * 24 * 365));
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw classifyGraphError(response.status, body, response.headers);
  }
  return await response.json() as T;
}

/** Build a Graph URL with `$select`/`$top` and only the defined parameters. */
export function graphUrl(path: string, params: Record<string, string | number | null | undefined>): string {
  const url = new URL(`${GRAPH_API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  return url.toString();
}
