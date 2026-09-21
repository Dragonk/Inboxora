import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db.js';
import { decrypt } from '../encryption.js';
import { getConnectionPolicy } from '../connectionPolicy.js';
import { safeFetch } from '../safeFetch.js';
import { runProviderMutation } from '../providerMutationService.js';
import type { ProviderAdapterOutcome, ProviderMutationAdapter, ProviderMutationStatus } from '../providerMutationService.js';
import { toAppError } from '../../utils/errors.js';

/**
 * The shared half of the external CalDAV/CardDAV write-back (P10).
 *
 * Until this module a `PUT`/`DELETE` on an imported external collection was refused by the
 * capability model, because no client existed that could forward the mutation to the source.
 * This is that client's shared machinery: it resolves the collection's remote resource, forwards
 * the HTTP preconditions the DAV client sent, classifies the source's answer honestly, and runs
 * the whole thing through {@link runProviderMutation} so an ambiguous outcome can never be
 * retried as if it were safe.
 *
 * The protocol modules (`caldavWriteBack.ts` / `carddavWriteBack.ts`) supply the two parts that
 * differ: how a remote resource is found for a UID, and how the confirmed answer becomes a local
 * projection plus a remote link.
 *
 * Classification is deliberately conservative. `retryable` asserts the source did not apply the
 * change; a 5xx, a timeout and a dropped socket do not prove that, so they are `outcome_unknown`
 * and are parked rather than re-run. Only an error raised while no byte could have reached the
 * server (DNS failure, connection refused, blocked private address) is `retryable`.
 */

export type DavWriteKind = 'caldav' | 'carddav';
export type DavWriteMethod = 'PUT' | 'DELETE';
export type DavObjectType = 'calendar_event' | 'contact';

export const DAV_WRITE_TIMEOUT_MS = 30_000;

/** The credentials and URL one write to a source carries. Never persisted. */
export interface DavSource {
  kind: DavWriteKind;
  collectionUrl: string;
  username: string;
  password: string;
  allowPrivate: boolean;
}

/** A remote resource the source confirmed, addressed by its own href and entity-tag. */
export interface DavRemoteResource {
  href: string;
  version: string | null;
}

export interface DavWriteDispositionBase {
  code: string;
}
export type DavWriteDisposition =
  | { kind: 'committed' }
  | ({ kind: 'conflict' } & DavWriteDispositionBase)
  | ({ kind: 'retryable'; retryAfterSeconds?: number } & DavWriteDispositionBase)
  | ({ kind: 'permanent' } & DavWriteDispositionBase)
  | ({ kind: 'outcome_unknown' } & DavWriteDispositionBase);

export interface DavWriteResponseFacts {
  method: DavWriteMethod;
  status: number;
  retryAfterSeconds?: number;
}

/** What a caller (a DAV route) needs to answer the client. */
export interface DavWriteBackRouteResult {
  status: 'confirmed' | 'conflict' | 'retryable' | 'permanent' | 'outcome_unknown';
  created: boolean;
  etag?: string;
  remoteHref?: string;
  remoteVersion?: string | null;
  code?: string;
  retryAfterSeconds?: number;
}

/**
 * A usable entity-tag for `If-Match`, or `null` when there is none.
 *
 * RFC 9110 §13.1.1 requires strong comparison, so a weak validator cannot be used as a
 * precondition at all: pretending otherwise would either fail every write or silently drop the
 * guard. Anything that is not a strong, quoted tag is treated as "no version known".
 */
export function strongEntityTag(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('W/')) return null;
  const unquoted = /^".*"$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
  if (!unquoted || unquoted.includes('"')) return null;
  return `"${unquoted}"`;
}

/** Store an entity-tag the way the read clients do: without surrounding quotes. */
export function unquotedEntityTag(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return /^".*"$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

/**
 * The condition to place on the source request.
 *
 * A create asks the source for `If-None-Match: *` so two clients creating the same href cannot
 * clobber each other; an update requires the entity-tag the read side last saw. `usable: false`
 * means the caller must not write: without a version there is no precondition to honour, and a
 * lost update is worse than a refusal.
 */
export function davPreconditionHeaders(input: { create: boolean; remoteVersion: string | null }): {
  headers: Record<string, string>;
  usable: boolean;
} {
  if (input.create) return { headers: { 'If-None-Match': '*' }, usable: true };
  const tag = strongEntityTag(input.remoteVersion);
  if (!tag) return { headers: {}, usable: false };
  return { headers: { 'If-Match': tag }, usable: true };
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

/**
 * Classify the source's HTTP status.
 *
 * `412`/`409` mean the local copy is stale — the caller turns that into a `412` so the DAV client
 * re-reads. `404` on a delete means the end state already holds, while on a PUT it means the
 * resource vanished underneath us, which is the same stale-copy conflict. A `5xx` reached the
 * server and its answer does not say whether the change was applied, so it is `outcome_unknown`.
 */
export function classifyDavWriteResponse(facts: DavWriteResponseFacts): DavWriteDisposition {
  const { status } = facts;
  if (status >= 200 && status < 300) return { kind: 'committed' };
  if (status === 412 || status === 409) return { kind: 'conflict', code: 'VERSION_CONFLICT' };
  if (status === 404) {
    return facts.method === 'DELETE'
      ? { kind: 'committed' }
      : { kind: 'conflict', code: 'VERSION_CONFLICT' };
  }
  if (status === 401) return { kind: 'permanent', code: 'PROVIDER_AUTH_REQUIRED' };
  if (status === 403) return { kind: 'permanent', code: 'OPERATION_FORBIDDEN' };
  // Locked / too many requests: the source refused before applying anything.
  if (status === 423) return { kind: 'retryable', code: 'UPSTREAM_UNAVAILABLE' };
  if (status === 429) return { kind: 'retryable', code: 'RATE_LIMITED', retryAfterSeconds: facts.retryAfterSeconds };
  if (status === 507) return { kind: 'permanent', code: 'STORAGE_QUOTA_EXCEEDED' };
  // 501/505 are definitive refusals, not ambiguous failures.
  if (status === 501 || status === 505) return { kind: 'permanent', code: 'OPERATION_FORBIDDEN' };
  if (status >= 400 && status < 500) return { kind: 'permanent', code: 'VALIDATION_ERROR' };
  return { kind: 'outcome_unknown', code: 'MUTATION_OUTCOME_UNKNOWN' };
}

/**
 * Transport error codes raised before any byte could have reached the server. Only these license
 * a retry: the request provably did not land.
 */
const PROVABLY_UNSENT_CODES: ReadonlySet<string> = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ERR_BLOCKED_PRIVATE_IP',
  'ERR_INSECURE_TRANSPORT', 'ERR_UNSUPPORTED_SCHEME', 'ERR_INVALID_URL',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'SELF_SIGNED_CERT_IN_CHAIN',
]);

function errorCodes(error: unknown, depth = 0): string[] {
  if (depth > 4 || error === null || typeof error !== 'object') return [];
  const record = error as { code?: unknown; name?: unknown; cause?: unknown };
  const codes: string[] = [];
  if (typeof record.code === 'string') codes.push(record.code);
  if (typeof record.name === 'string') codes.push(record.name);
  return [...codes, ...errorCodes(record.cause, depth + 1)];
}

/** True only when the failure happened before the request could have been delivered. */
export function isProvablyUnsent(error: unknown): boolean {
  return errorCodes(error).some(code => PROVABLY_UNSENT_CODES.has(code));
}

export function classifyDavTransportError(error: unknown): DavWriteDisposition {
  const failure = toAppError(error);
  const text = `${failure.code ?? ''} ${failure.message ?? ''}`;
  // An abort or timeout may have happened after the source applied the change.
  if (/abort|timeout|timed out/i.test(text)) return { kind: 'outcome_unknown', code: 'MUTATION_OUTCOME_UNKNOWN' };
  if (isProvablyUnsent(error)) return { kind: 'retryable', code: 'UPSTREAM_UNAVAILABLE' };
  return { kind: 'outcome_unknown', code: 'MUTATION_OUTCOME_UNKNOWN' };
}

/**
 * A read used only to resolve a remote href/version. Unlike a write, retrying a read cannot
 * duplicate anything, so a failure here is classified as retryable rather than unknown.
 */
export function classifyDavReadError(error: unknown): DavWriteDisposition {
  const failure = toAppError(error);
  const status = (error as { status?: unknown } | null)?.status;
  if (status === 401 || status === 403) return { kind: 'permanent', code: 'PROVIDER_AUTH_REQUIRED' };
  if (status === 404) return { kind: 'conflict', code: 'VERSION_CONFLICT' };
  const text = `${failure.code ?? ''} ${failure.message ?? ''}`;
  if (/authentication failed|invalid credentials|unauthori[sz]ed|forbidden/i.test(text)) {
    return { kind: 'permanent', code: 'PROVIDER_AUTH_REQUIRED' };
  }
  return { kind: 'retryable', code: 'UPSTREAM_UNAVAILABLE' };
}

export function dispositionToOutcome(disposition: DavWriteDisposition): ProviderAdapterOutcome<never> {
  switch (disposition.kind) {
    case 'committed': return { status: 'committed' };
    case 'conflict': return { status: 'conflict', code: disposition.code };
    case 'retryable': return { status: 'retryable', code: disposition.code, retryAfterSeconds: disposition.retryAfterSeconds };
    case 'permanent': return { status: 'permanent', code: disposition.code };
    case 'outcome_unknown': return { status: 'outcome_unknown', code: disposition.code };
  }
}

function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

/** Join a collection URL and one resource filename without losing the collection's own suffix. */
export function joinDavUrl(collectionUrl: string, filename: string): string {
  const base = collectionUrl.endsWith('/') ? collectionUrl.slice(0, -1) : collectionUrl;
  return `${base}/${encodeURIComponent(filename)}`;
}

export interface DavWriteHttpRequest {
  method: DavWriteMethod;
  href: string;
  source: DavSource;
  headers: Record<string, string>;
  body?: string;
  contentType?: string;
  signal?: AbortSignal;
}

export interface DavWriteAttempt {
  disposition: DavWriteDisposition;
  status?: number;
  /** The source's entity-tag after the write, unquoted. */
  etag: string | null;
}

/** Send the mutation to the source and classify whatever came back — or failed to. */
export async function sendDavWrite(request: DavWriteHttpRequest): Promise<DavWriteAttempt> {
  const headers: Record<string, string> = { Authorization: basicAuth(request.source.username, request.source.password), ...request.headers };
  if (request.contentType) headers['Content-Type'] = request.contentType;
  let response: Response;
  try {
    response = await safeFetch(request.href, {
      method: request.method,
      headers,
      body: request.method === 'PUT' ? request.body : undefined,
      redirect: 'follow',
      signal: request.signal ?? AbortSignal.timeout(DAV_WRITE_TIMEOUT_MS),
    }, { allowPrivate: request.source.allowPrivate });
  } catch (error) {
    return { disposition: classifyDavTransportError(error), etag: null };
  }
  const retryAfterSeconds = parseRetryAfter(response.headers.get('retry-after'));
  // Drain the body so the connection can be reused; the payload is not the contract.
  await response.arrayBuffer().catch(() => undefined);
  return {
    disposition: classifyDavWriteResponse({ method: request.method, status: response.status, retryAfterSeconds }),
    status: response.status,
    etag: unquotedEntityTag(response.headers.get('etag')),
  };
}

/** The remote identity a link row holds, joined through the collection. */
export interface RemoteObjectLink {
  id: string;
  collectionId: string;
  collectionRemoteId: string;
  objectRemoteId: string;
  remoteHref: string | null;
  remoteVersion: string | null;
}

export async function findRemoteLink(input: {
  userId: string;
  objectType: DavObjectType;
  localId: string;
}): Promise<RemoteObjectLink | null> {
  const result = await query<{
    id: string; collection_id: string; collection_remote_id: string; object_remote_id: string;
    remote_href: string | null; remote_version: string | null;
  }>(
    `SELECT id, collection_id, collection_remote_id, object_remote_id, remote_href, remote_version
       FROM remote_object_links
      WHERE user_id = $1 AND object_type = $2 AND local_id = $3 AND status = 'active'
      ORDER BY updated_at DESC
      LIMIT 1`,
    [input.userId, input.objectType, input.localId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    collectionId: row.collection_id,
    collectionRemoteId: row.collection_remote_id,
    objectRemoteId: row.object_remote_id,
    remoteHref: row.remote_href,
    remoteVersion: row.remote_version,
  };
}

/** Persist the version the source reported, and clear the identity when the resource is gone. */
export async function recordRemoteLink(client: PoolClient, linkId: string, input: {
  remoteHref: string | null;
  remoteVersion: string | null;
  status: 'active' | 'deleted';
}): Promise<void> {
  await client.query(
    `UPDATE remote_object_links
        SET remote_href = $2, remote_version = $3, status = $4::text,
            local_id = CASE WHEN $4::text = 'deleted' THEN NULL ELSE local_id END,
            updated_at = NOW()
      WHERE id = $1`,
    [linkId, input.remoteHref, input.remoteVersion, input.status],
  );
}

interface CalendarImportSourceRow {
  id: string;
  kind?: string | null;
  url?: string | null;
  username?: string | null;
  password?: string | null;
}

/**
 * Resolve the collection's stored credentials and remote collection URL.
 *
 * CalDAV collections keep only `source:<id>` in `calendars.external_url`, so the URL and the
 * credentials come from `calendar_import_sources`; a CardDAV book's `external_url` already *is*
 * the remote collection URL and its credentials live in the per-user integration config. Both are
 * the same values the read sync used, so a write reaches the server the user connected.
 */
export async function resolveDavSource(input: {
  kind: DavWriteKind;
  userId: string;
  externalUrl: string | null | undefined;
}): Promise<DavSource | null> {
  const policy = await getConnectionPolicy();
  const allowPrivate = policy.allowPrivateHosts === true;

  if (input.kind === 'caldav') {
    const marker = input.externalUrl ?? '';
    if (!marker.startsWith('source:')) return null;
    const sourceId = marker.slice('source:'.length);
    if (!sourceId) return null;
    const result = await query<CalendarImportSourceRow>(
      'SELECT id, kind, url, username, password FROM calendar_import_sources WHERE id = $1 AND user_id = $2',
      [sourceId, input.userId],
    );
    const row = result.rows[0];
    if (!row || row.kind !== 'caldav') return null;
    const collectionUrl = decrypt(row.url ?? '');
    const password = decrypt(row.password ?? '');
    if (!collectionUrl || !password) return null;
    return { kind: 'caldav', collectionUrl, username: row.username ?? '', password, allowPrivate };
  }

  const collectionUrl = input.externalUrl ?? '';
  if (!collectionUrl) return null;
  const result = await query<{ config?: { username?: unknown; password?: unknown } | null }>(
    "SELECT config FROM user_integrations WHERE user_id = $1 AND provider = 'carddav'",
    [input.userId],
  );
  const config = result.rows[0]?.config;
  const username = typeof config?.username === 'string' ? config.username : '';
  const password = decrypt(config?.password);
  if (!username || !password) return null;
  return { kind: 'carddav', collectionUrl, username, password, allowPrivate };
}

/** Everything the shared layer needs to know about the object being written. */
export interface DavWriteBackSpec {
  method: DavWriteMethod;
  kind: DavWriteKind;
  objectType: DavObjectType;
  userId: string;
  localCollectionId: string;
  externalUrl: string | null | undefined;
  /** `calendar_events.id` / `contacts.id` when the local row exists. */
  localObjectId: string | null;
  uid: string;
  filename: string;
  exists: boolean;
  /** The local entity-tag the client's precondition was checked against. */
  localRevision: string | null;
  body: string;
  contentType: string;
  credentialId?: string | null;
}

export interface DavProjectionCommit {
  remoteHref: string;
  remoteVersion: string | null;
  created: boolean;
  /** True when the source was told to delete and confirmed it. */
  deleted: boolean;
  link: RemoteObjectLink | null;
}

export interface DavWriteBackDeps {
  /** Find the remote resource for this UID. `null` means a successful read that did not list it. */
  resolveRemote(source: DavSource, spec: DavWriteBackSpec): Promise<DavRemoteResource | null>;
  /** The href a create should target. */
  remoteHrefForCreate(source: DavSource, spec: DavWriteBackSpec): string;
  /** Apply the confirmed answer locally and return the new local entity-tag. */
  commit(client: PoolClient, spec: DavWriteBackSpec, input: DavProjectionCommit): Promise<string>;
}

/** Thrown by a protocol commit when the local row changed under the write. */
export class DavProjectionGuardError extends Error {
  constructor(message = 'The local resource changed while the source write was in flight') {
    super(message);
    this.name = 'DavProjectionGuardError';
  }
}

interface DavWriteValue {
  etag: string;
  remoteHref: string;
  remoteVersion: string | null;
  created: boolean;
}

function isDavWriteValue(value: unknown): value is DavWriteValue {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as { etag?: unknown; remoteHref?: unknown };
  return typeof candidate.etag === 'string' && typeof candidate.remoteHref === 'string';
}

function routeResultFromDisposition(disposition: DavWriteDisposition, created: boolean): DavWriteBackRouteResult {
  switch (disposition.kind) {
    case 'conflict': return { status: 'conflict', created: false, code: disposition.code };
    case 'retryable': return { status: 'retryable', created: false, code: disposition.code, retryAfterSeconds: disposition.retryAfterSeconds };
    case 'permanent': return { status: 'permanent', created: false, code: disposition.code };
    case 'outcome_unknown': return { status: 'outcome_unknown', created: false, code: disposition.code };
    case 'committed': return { status: 'confirmed', created };
  }
}

const MUTATION_STATUS_RESULT: Readonly<Record<ProviderMutationStatus, DavWriteBackRouteResult['status']>> = Object.freeze({
  confirmed: 'confirmed',
  accepted: 'outcome_unknown',
  pending: 'retryable',
  retryable: 'retryable',
  conflict: 'conflict',
  permanent: 'permanent',
  outcome_unknown: 'outcome_unknown',
});

/**
 * Run one DAV write against its source through the shared mutation layer.
 *
 * The ordering matters and is the whole point: the journal claim is committed before the source
 * is touched, the local projection is written only after the source confirms, and an ambiguous
 * answer leaves both the local row and the link untouched.
 */
export async function executeDavWriteBack(spec: DavWriteBackSpec, deps: DavWriteBackDeps): Promise<DavWriteBackRouteResult> {
  const source = await resolveDavSource({ kind: spec.kind, userId: spec.userId, externalUrl: spec.externalUrl });
  if (!source) return { status: 'permanent', created: false, code: 'ADMIN_CONFIGURATION_REQUIRED' };

  const link = spec.localObjectId
    ? await findRemoteLink({ userId: spec.userId, objectType: spec.objectType, localId: spec.localObjectId })
    : null;

  let remote: DavRemoteResource | null = link?.remoteHref ? { href: link.remoteHref, version: link.remoteVersion } : null;
  if (spec.exists && (!remote || strongEntityTag(remote.version) === null)) {
    try {
      const resolved = await deps.resolveRemote(source, spec);
      if (resolved) remote = resolved;
    } catch (error) {
      return routeResultFromDisposition(classifyDavReadError(error), false);
    }
  }

  const create = !spec.exists;
  if (spec.method === 'PUT' && !create && !remote) {
    // The local copy exists but the source no longer lists it: this row is stale.
    return { status: 'conflict', created: false, code: 'VERSION_CONFLICT' };
  }

  const precondition = create
    ? davPreconditionHeaders({ create: true, remoteVersion: null })
    : davPreconditionHeaders({ create: false, remoteVersion: remote?.version ?? null });
  if (spec.method === 'PUT' && !precondition.usable) {
    // No version to guard the update with. Refusing is the only honest answer.
    return { status: 'conflict', created: false, code: 'VERSION_CONFLICT' };
  }

  const alreadyGone = spec.method === 'DELETE' && !remote;
  const href = remote?.href ?? (create ? deps.remoteHrefForCreate(source, spec) : '');
  if (!alreadyGone && !href) return { status: 'conflict', created: false, code: 'VERSION_CONFLICT' };

  const payloadHash = crypto.createHash('sha256')
    .update(`${spec.method}\n${spec.localCollectionId}\n${spec.filename}\n${spec.body}`)
    .digest('hex');
  const idempotencyKey = `dav:${spec.kind}:${spec.method}:${spec.localCollectionId}:${spec.filename}:${payloadHash}`;

  const adapter: ProviderMutationAdapter<{ body: string; contentType: string; href: string; alreadyGone: boolean }, DavWriteValue> = {
    resourceType: spec.objectType,
    // A PUT of a complete resource converges on the same state; a DELETE is not
    // distinguishable from "already gone", so a recovered claim must be parked.
    idempotent: spec.method === 'PUT',
    async perform(payload, context) {
      if (payload.alreadyGone) {
        const etag = await commitLocal(null);
        return { status: 'committed', value: { etag, remoteHref: payload.href, remoteVersion: null, created: false } };
      }
      const attempt = await sendDavWrite({
        method: spec.method,
        href: payload.href,
        source,
        headers: precondition.headers,
        body: spec.method === 'PUT' ? payload.body : undefined,
        contentType: spec.method === 'PUT' ? payload.contentType : undefined,
        signal: context.signal,
      });
      if (attempt.disposition.kind !== 'committed') return dispositionToOutcome(attempt.disposition);
      try {
        const etag = await commitLocal(attempt.etag);
        return { status: 'committed', value: { etag, remoteHref: payload.href, remoteVersion: attempt.etag, created: create } };
      } catch (error) {
        if (error instanceof DavProjectionGuardError) return { status: 'conflict', code: 'VERSION_CONFLICT' };
        throw error;
      }
    },
  };

  /** One transaction: the local projection and the remote link's new version commit together. */
  async function commitLocal(remoteVersion: string | null): Promise<string> {
    return withTransaction(async client => {
      const etag = await deps.commit(client, spec, {
        remoteHref: href,
        remoteVersion,
        created: create,
        deleted: spec.method === 'DELETE',
        link,
      });
      if (link) {
        await recordRemoteLink(client, link.id, {
          remoteHref: spec.method === 'DELETE' ? null : href,
          remoteVersion,
          status: spec.method === 'DELETE' ? 'deleted' : 'active',
        });
      }
      return etag;
    });
  }

  const result = await runProviderMutation({
    userId: spec.userId,
    channel: 'dav',
    operation: spec.method === 'DELETE' ? 'delete' : create ? 'create' : 'update',
    collectionId: null,
    resourceId: spec.localObjectId,
    idempotencyKey,
    payloadHash,
    payload: { href, contentType: spec.contentType, body: spec.body, alreadyGone },
    expectedVersions: { remoteVersion: remote?.version ?? null },
    timeoutMs: DAV_WRITE_TIMEOUT_MS,
  }, adapter);

  const status = MUTATION_STATUS_RESULT[result.status];
  if (status === 'confirmed') {
    const value = isDavWriteValue(result.value) ? result.value : undefined;
    return {
      status: 'confirmed',
      created: value?.created ?? create,
      etag: value?.etag,
      remoteHref: value?.remoteHref ?? href,
      remoteVersion: value?.remoteVersion ?? null,
    };
  }
  if (result.code === 'OPERATION_FORBIDDEN') {
    // The source itself refused this write — `403`, or a `501`/`505` that means the verb is not supported. That is
    // the provider telling us the collection's origin does not accept writes, which is exactly the fact DAV-02
    // says was assumed instead of discovered: recording it here means the capability model refuses the next attempt
    // with `COLLECTION_READ_ONLY` and the interface stops offering a write the server will reject. It is a fact
    // learned from the origin's own answer, not a downgrade of the user's own setting, and it leaves the local
    // source label untouched.
    // `localCollectionId` is the caller's name for the collection it is writing through, which is a local calendar
    // or address book id on some paths — so the row is matched by whichever of the three identifies it, rather than
    // by an assumption about which one that is.
    await withTransaction(client => client.query(
      `UPDATE integration_collections
          SET source_access = 'read_only', updated_at = NOW()
        WHERE source_access IS DISTINCT FROM 'read_only'
          AND (id = $1 OR local_calendar_id = $1 OR local_address_book_id = $1)`,
      [spec.localCollectionId],
    )).catch(error => console.warn(
      'Could not record the source refusing writes:',
      error instanceof Error ? error.message : error,
    ));
  }
  return { status, created: false, code: result.code, retryAfterSeconds: result.retryAfterSeconds };
}

/**
 * The status a DAV client is answered with.
 *
 * A stale copy is `412` (re-read and retry); an ambiguous outcome is `502` and never a success.
 */
export function davWriteBackHttpStatus(result: DavWriteBackRouteResult): number {
  switch (result.status) {
    case 'confirmed': return result.created ? 201 : 204;
    case 'conflict': return result.code === 'IDEMPOTENCY_KEY_REUSED' ? 409 : 412;
    case 'retryable': return 503;
    case 'permanent': return result.code === 'RESOURCE_NOT_FOUND' ? 404 : 502;
    case 'outcome_unknown': return 502;
  }
}
