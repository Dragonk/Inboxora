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
/**
 * The preview contract.
 *
 * Used by exactly one read — the calendar's per-calendar event delta, whose documented home is beta (GRAPH-02) —
 * and never by a write. Exported so that single use is explicit and greppable rather than a literal buried in a
 * URL builder.
 */
export const GRAPH_BETA_API_BASE = 'https://graph.microsoft.com/beta';
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
    // Graph uses 403 for a missing scope, for a policy/tenant restriction **and** for a refusal to act as a
    // chosen identity. Flattening all of them into "insufficient scopes" tells a user to reconnect an account
    // that is already authorized and hides what the provider actually refused — the live case was a send-as
    // alias denial (`ErrorSendAsDenied`) reported as a missing permission. The provider's own reason is kept
    // as the domain code whenever Graph names one, and the scope code is the fallback for an unnamed 403.
    // `ErrorSendAsDenied` is Graph's own name for "this mailbox may not send as that address", and it has its
    // own domain code so the interface can say that instead of asking for a permission the account already has.
    if (reason === 'ErrorSendAsDenied') {
      return new GraphApiError({ code: 'SEND_AS_DENIED', message, status, providerReason: reason });
    }
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
  /**
   * Ask for **immutable** message ids on every request this client makes (GRAPH-04).
   *
   * The preference is per request, and it may only be used for a mailbox whose stored ids have already been
   * translated to that form — asking for it earlier would make every stored id unrecognisable. Callers set it from
   * the connection's recorded translation, never from a default.
   */
  immutableIds?: boolean;
}

/** The preference that makes Graph answer with immutable ids rather than the default, mutable ones. */
export const IMMUTABLE_ID_PREFERENCE = 'IdType="ImmutableId"';

/** Split a Prefer header without treating a comma inside a quoted value as a separator. */
function graphPreferTokens(value: string): string[] {
  const tokens: string[] = [];
  let quoted = false;
  let token = '';
  for (const char of value) {
    if (char === '"') quoted = !quoted;
    if (char === ',' && !quoted) {
      if (token.trim()) tokens.push(token.trim());
      token = '';
    } else token += char;
  }
  if (quoted) throw new GraphApiError({ code: 'VALIDATION_ERROR', status: 400, message: 'Graph Prefer header contains an unclosed quote' });
  if (token.trim()) tokens.push(token.trim());
  return tokens;
}

/** The directive name is case-insensitive and ends before its optional value. */
function graphPreferDirective(token: string): string {
  return token.split('=', 1)[0]!.trim().toLowerCase();
}

/**
 * Merge Graph Prefer values without losing mailbox-wide immutable-id mode.
 *
 * Repeating the exact same directive is harmless; two values for one directive are ambiguous, so reject the
 * request instead of silently selecting whichever header happened to be enumerated first.
 */
export function mergeGraphPrefer(...values: Array<string | undefined>): string | undefined {
  const tokens: string[] = [];
  const byDirective = new Map<string, string>();
  for (const value of values) {
    if (!value) continue;
    for (const token of graphPreferTokens(value)) {
      const directive = graphPreferDirective(token);
      const existing = byDirective.get(directive);
      if (existing !== undefined) {
        if (existing.toLowerCase() !== token.toLowerCase()) {
          throw new GraphApiError({ code: 'VALIDATION_ERROR', status: 400, message: `Conflicting Graph Prefer directive: ${directive}` });
        }
        continue;
      }
      byDirective.set(directive, token);
      tokens.push(token);
    }
  }
  return tokens.length ? tokens.join(', ') : undefined;
}

/** Collect every casing of Prefer so a caller cannot bypass the immutable-id merge accidentally. */
function graphPreferValues(headers: Record<string, string>): string[] {
  return Object.entries(headers)
    .filter(([name]) => name.toLowerCase() === 'prefer')
    .map(([, value]) => value);
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
 * Perform an authenticated Graph request, with the one controlled refresh a 401
 * earns. The raw response is returned so the caller decides how to read the body:
 * a successful mutation may answer `204` with none.
 *
 * `url` may be a path (`/me/...`) or a full URL, because Graph hands back absolute
 * `@odata.nextLink` values.
 */
async function graphSend(options: GraphApiOptions, pathOrUrl: string, init: { method: string; body?: unknown }): Promise<Response> {
  return graphSendWithHeaders(options, pathOrUrl, init, {});
}

async function graphSendWithHeaders(
  options: GraphApiOptions,
  pathOrUrl: string,
  init: { method: string; body?: unknown },
  extraHeaders: Record<string, string>,
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${GRAPH_API_BASE}${pathOrUrl}`;
  const prefer = mergeGraphPrefer(
    ...graphPreferValues(extraHeaders),
    options.immutableIds ? IMMUTABLE_ID_PREFERENCE : undefined,
  );
  const send = async (token: string): Promise<Response> => fetchImpl(url, {
    method: init.method,
    headers: {
      ...Object.fromEntries(Object.entries(extraHeaders).filter(([name]) => name.toLowerCase() !== 'prefer')),
      ...(prefer ? { Prefer: prefer } : {}),
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
  });

  let response = await send(await accessToken(options));
  if (response.status === 401) {
    // At most one controlled refresh and retry: the cached token may have been
    // revoked between the validity check and the call.
    response = await send(await accessToken(options, 60 * 60 * 24 * 365));
  }
  return response;
}

async function throwForStatus(response: Response): Promise<never> {
  const body = await response.json().catch(() => null);
  throw classifyGraphError(response.status, body, response.headers);
}

export async function graphGet<T>(options: GraphApiOptions, pathOrUrl: string): Promise<T> {
  const response = await graphSend(options, pathOrUrl, { method: 'GET' });
  if (!response.ok) await throwForStatus(response);
  return await response.json() as T;
}

/**
 * A GET that needs a header Graph only honours per request.
 *
 * The one that matters here is `Prefer: outlook.timezone="UTC"`: without it Graph returns an event's
 * start/end in the mailbox's own zone, and an occurrence's identity could then be compared in the wrong
 * frame. The ordinary client sends no `Prefer` header, so this is a separate entry point rather than a
 * change to every Graph call.
 */
export async function graphGetWithHeaders<T>(options: GraphApiOptions, pathOrUrl: string, headers: Record<string, string>): Promise<T> {
  const response = await graphSendWithHeaders(options, pathOrUrl, { method: 'GET' }, headers);
  if (!response.ok) await throwForStatus(response);
  return await response.json() as T;
}

/**
 * PATCH a Graph resource. Graph answers `200` with the updated object or `204`
 * with nothing, so a missing body is part of the contract rather than an error.
 */
export async function graphPatch<T>(options: GraphApiOptions, pathOrUrl: string, body: unknown): Promise<T | null> {
  const response = await graphSend(options, pathOrUrl, { method: 'PATCH', body });
  if (!response.ok) await throwForStatus(response);
  if (response.status === 204) return null;
  return await response.json().catch(() => null) as T | null;
}

/** POST to a Graph action. `202 Accepted` with an empty body is a success. */
export async function graphPost<T>(options: GraphApiOptions, pathOrUrl: string, body: unknown): Promise<T | null> {
  const response = await graphSend(options, pathOrUrl, { method: 'POST', body });
  if (!response.ok) await throwForStatus(response);
  if (response.status === 204 || response.status === 202) return null;
  return await response.json().catch(() => null) as T | null;
}

export async function graphDelete(options: GraphApiOptions, pathOrUrl: string): Promise<void> {
  const response = await graphSend(options, pathOrUrl, { method: 'DELETE' });
  if (!response.ok) await throwForStatus(response);
}

/** Build a Graph URL with `$select`/`$top` and only the defined parameters. */
export function graphUrl(path: string, params: Record<string, string | number | null | undefined>): string {
  const url = new URL(`${GRAPH_API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  return url.toString();
}
