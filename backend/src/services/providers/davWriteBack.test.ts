import { describe, expect, it } from 'vitest';
import {
  classifyDavReadError,
  classifyDavTransportError,
  classifyDavWriteResponse,
  davPreconditionHeaders,
  davWriteBackHttpStatus,
  isProvablyUnsent,
  joinDavUrl,
  strongEntityTag,
  unquotedEntityTag,
} from './davWriteBack.js';
import type { DavWriteBackRouteResult } from './davWriteBack.js';

/**
 * The classification is the part of the write-back that decides whether a retry is allowed, so it
 * is asserted directly rather than only through a route: `retryable` means "the source did not
 * apply this", and a wrong answer there is a duplicated mutation.
 */
describe('classifyDavWriteResponse', () => {
  const facts = (status: number, method: 'PUT' | 'DELETE' = 'PUT', retryAfterSeconds?: number) => (
    retryAfterSeconds === undefined ? { method, status } : { method, status, retryAfterSeconds }
  );

  it('treats every 2xx as applied', () => {
    for (const status of [200, 201, 204]) {
      expect(classifyDavWriteResponse(facts(status))).toEqual({ kind: 'committed' });
    }
  });

  it('reads 412 and 409 as a stale local copy', () => {
    expect(classifyDavWriteResponse(facts(412))).toEqual({ kind: 'conflict', code: 'VERSION_CONFLICT' });
    expect(classifyDavWriteResponse(facts(409))).toEqual({ kind: 'conflict', code: 'VERSION_CONFLICT' });
  });

  it('reads a vanished resource differently for a delete and a put', () => {
    // A delete's intent is "the resource is gone", so an already-gone resource is the end state;
    // a put whose target disappeared means the local copy is stale.
    expect(classifyDavWriteResponse(facts(404, 'DELETE'))).toEqual({ kind: 'committed' });
    expect(classifyDavWriteResponse(facts(404, 'PUT'))).toEqual({ kind: 'conflict', code: 'VERSION_CONFLICT' });
  });

  it('separates permanent refusals from retryable ones', () => {
    expect(classifyDavWriteResponse(facts(401))).toEqual({ kind: 'permanent', code: 'PROVIDER_AUTH_REQUIRED' });
    expect(classifyDavWriteResponse(facts(403))).toEqual({ kind: 'permanent', code: 'OPERATION_FORBIDDEN' });
    expect(classifyDavWriteResponse(facts(400))).toEqual({ kind: 'permanent', code: 'VALIDATION_ERROR' });
    expect(classifyDavWriteResponse(facts(507))).toEqual({ kind: 'permanent', code: 'STORAGE_QUOTA_EXCEEDED' });
    // Locked and rate-limited are refusals *before* the change, so a retry is safe.
    expect(classifyDavWriteResponse(facts(423))).toEqual({ kind: 'retryable', code: 'UPSTREAM_UNAVAILABLE' });
    expect(classifyDavWriteResponse(facts(429, 'PUT', 30))).toEqual({ kind: 'retryable', code: 'RATE_LIMITED', retryAfterSeconds: 30 });
  });

  it('never calls a 5xx retryable: it reached the server and may have been applied', () => {
    for (const status of [500, 502, 503, 504, 599]) {
      expect(classifyDavWriteResponse(facts(status))).toEqual({ kind: 'outcome_unknown', code: 'MUTATION_OUTCOME_UNKNOWN' });
    }
    // 501/505 are definitive refusals rather than ambiguous failures.
    expect(classifyDavWriteResponse(facts(501))).toEqual({ kind: 'permanent', code: 'OPERATION_FORBIDDEN' });
    expect(classifyDavWriteResponse(facts(505))).toEqual({ kind: 'permanent', code: 'OPERATION_FORBIDDEN' });
  });
});

describe('classifyDavTransportError', () => {
  const withCause = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect'), { code }) });

  it('marks a failure that provably never reached the server as retryable', () => {
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_BLOCKED_PRIVATE_IP']) {
      expect(isProvablyUnsent(withCause(code))).toBe(true);
      expect(classifyDavTransportError(withCause(code))).toEqual({ kind: 'retryable', code: 'UPSTREAM_UNAVAILABLE' });
    }
  });

  it('treats a dropped connection, abort or timeout as ambiguous', () => {
    for (const code of ['ECONNRESET', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT']) {
      expect(isProvablyUnsent(withCause(code))).toBe(false);
      expect(classifyDavTransportError(withCause(code))).toEqual({ kind: 'outcome_unknown', code: 'MUTATION_OUTCOME_UNKNOWN' });
    }
    const abort = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    expect(classifyDavTransportError(abort)).toEqual({ kind: 'outcome_unknown', code: 'MUTATION_OUTCOME_UNKNOWN' });
    expect(classifyDavTransportError(new Error('CardDAV server did not respond (timed out)'))).toEqual({ kind: 'outcome_unknown', code: 'MUTATION_OUTCOME_UNKNOWN' });
  });
});

describe('classifyDavReadError', () => {
  it('keeps a failed resolution retryable because a read cannot duplicate anything', () => {
    expect(classifyDavReadError(new Error('DAV server returned an invalid multistatus response'))).toEqual({ kind: 'retryable', code: 'UPSTREAM_UNAVAILABLE' });
  });

  it('does not retry bad credentials or a collection that is gone', () => {
    expect(classifyDavReadError(Object.assign(new Error('nope'), { status: 401 }))).toEqual({ kind: 'permanent', code: 'PROVIDER_AUTH_REQUIRED' });
    expect(classifyDavReadError(new Error('Authentication failed — check the username and app password'))).toEqual({ kind: 'permanent', code: 'PROVIDER_AUTH_REQUIRED' });
    expect(classifyDavReadError(Object.assign(new Error('gone'), { status: 404 }))).toEqual({ kind: 'conflict', code: 'VERSION_CONFLICT' });
  });
});

describe('entity tags and preconditions', () => {
  it('accepts only a strong, exact tag as a precondition', () => {
    expect(strongEntityTag('"abc"')).toBe('"abc"');
    expect(strongEntityTag('abc')).toBe('"abc"');
    expect(strongEntityTag('W/"abc"')).toBeNull();
    expect(strongEntityTag('  ')).toBeNull();
    expect(strongEntityTag(null)).toBeNull();
    expect(strongEntityTag('""')).toBeNull();
  });

  it('stores the version without quotes, the way the read clients do', () => {
    expect(unquotedEntityTag('"abc"')).toBe('abc');
    expect(unquotedEntityTag('abc')).toBe('abc');
    expect(unquotedEntityTag(null)).toBeNull();
  });

  it('asks for create-only with If-None-Match: *', () => {
    expect(davPreconditionHeaders({ create: true, remoteVersion: null })).toEqual({
      headers: { 'If-None-Match': '*' },
      usable: true,
    });
  });

  it('guards an update with the stored strong version', () => {
    expect(davPreconditionHeaders({ create: false, remoteVersion: 'etag-9' })).toEqual({
      headers: { 'If-Match': '"etag-9"' },
      usable: true,
    });
  });

  it('refuses to claim a precondition it cannot honour', () => {
    expect(davPreconditionHeaders({ create: false, remoteVersion: null }).usable).toBe(false);
    expect(davPreconditionHeaders({ create: false, remoteVersion: 'W/"weak"' })).toEqual({ headers: {}, usable: false });
  });
});

describe('joinDavUrl', () => {
  it('keeps the collection URL intact and encodes the filename', () => {
    expect(joinDavUrl('https://dav.example/calendars/user/work', 'a b.ics')).toBe('https://dav.example/calendars/user/work/a%20b.ics');
    expect(joinDavUrl('https://dav.example/books/user/1/', 'c1.vcf')).toBe('https://dav.example/books/user/1/c1.vcf');
  });
});

describe('davWriteBackHttpStatus', () => {
  const result = (value: Partial<DavWriteBackRouteResult> & Pick<DavWriteBackRouteResult, 'status'>): DavWriteBackRouteResult => ({ created: false, ...value });

  it('answers a create with 201, an update with 204 and a stale copy with 412', () => {
    expect(davWriteBackHttpStatus(result({ status: 'confirmed', created: true }))).toBe(201);
    expect(davWriteBackHttpStatus(result({ status: 'confirmed', created: false }))).toBe(204);
    expect(davWriteBackHttpStatus(result({ status: 'conflict', code: 'VERSION_CONFLICT' }))).toBe(412);
    expect(davWriteBackHttpStatus(result({ status: 'conflict', code: 'IDEMPOTENCY_KEY_REUSED' }))).toBe(409);
  });

  it('never answers a success for a retryable, permanent or unknown outcome', () => {
    expect(davWriteBackHttpStatus(result({ status: 'retryable' }))).toBe(503);
    expect(davWriteBackHttpStatus(result({ status: 'permanent', code: 'PROVIDER_AUTH_REQUIRED' }))).toBe(502);
    expect(davWriteBackHttpStatus(result({ status: 'permanent', code: 'RESOURCE_NOT_FOUND' }))).toBe(404);
    expect(davWriteBackHttpStatus(result({ status: 'outcome_unknown' }))).toBe(502);
  });
});
