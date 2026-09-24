import crypto from 'node:crypto';
import { safeFetch, type SafeFetchOptions } from './safeFetch.js';

export interface DavHttpCredentials {
  username: string;
  password: string;
}

type DigestAlgorithm = 'MD5' | 'MD5-SESS' | 'SHA-256' | 'SHA-256-SESS' | 'SHA-512-256' | 'SHA-512-256-SESS';

export interface DigestChallenge {
  realm: string;
  nonce: string;
  opaque?: string;
  algorithm: DigestAlgorithm;
  qop: 'auth' | 'auth-int' | null;
  stale: boolean;
  userhash: boolean;
}

function splitParams(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  let escaped = false;
  for (const ch of value) {
    if (escaped) { current += ch; escaped = false; continue; }
    if (quoted && ch === '\\') { current += ch; escaped = true; continue; }
    if (ch === '"') { current += ch; quoted = !quoted; continue; }
    if (ch === ',' && !quoted) { if (current.trim()) parts.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\([\\"])/g, '$1');
  }
  return trimmed;
}

export function parseDigestChallenge(header: string | null): DigestChallenge | null {
  if (!header) return null;
  const match = /(?:^|,\s*)Digest\s+/i.exec(header);
  if (!match) return null;
  const tail = header.slice(match.index + match[0].length);
  const params = new Map<string, string>();
  for (const part of splitParams(tail)) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim().toLowerCase();
    if (!/^[a-z][a-z0-9_-]*$/i.test(key)) continue;
    params.set(key, unquote(part.slice(index + 1)));
  }
  const realm = params.get('realm') ?? '';
  const nonce = params.get('nonce') ?? '';
  if (!realm || !nonce) return null;
  const rawAlgorithm = (params.get('algorithm') || 'MD5').toUpperCase();
  const allowed = new Set<DigestAlgorithm>(['MD5', 'MD5-SESS', 'SHA-256', 'SHA-256-SESS', 'SHA-512-256', 'SHA-512-256-SESS']);
  if (!allowed.has(rawAlgorithm as DigestAlgorithm)) return null;
  const qops = (params.get('qop') || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  const qop = qops.includes('auth') ? 'auth' : qops.includes('auth-int') ? 'auth-int' : null;
  if (qops.length > 0 && qop === null) return null;
  return {
    realm,
    nonce,
    opaque: params.get('opaque') || undefined,
    algorithm: rawAlgorithm as DigestAlgorithm,
    qop,
    stale: (params.get('stale') || '').toLowerCase() === 'true',
    userhash: (params.get('userhash') || '').toLowerCase() === 'true',
  };
}

function hashName(algorithm: DigestAlgorithm): string {
  if (algorithm.startsWith('MD5')) return 'md5';
  if (algorithm.startsWith('SHA-256')) return 'sha256';
  return 'sha512-256';
}

function digestHash(algorithm: DigestAlgorithm, value: string | Buffer): string {
  return crypto.createHash(hashName(algorithm)).update(value).digest('hex');
}

function escapeQuoted(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function bodyBytes(body: RequestInit['body']): Buffer | null {
  if (body == null) return Buffer.alloc(0);
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  return null;
}

export function buildDigestAuthorization(input: {
  challenge: DigestChallenge;
  method: string;
  url: string;
  username: string;
  password: string;
  body?: RequestInit['body'];
  nonceCount?: number;
  cnonce?: string;
}): string | null {
  const { challenge } = input;
  const parsed = new URL(input.url);
  const uri = `${parsed.pathname || '/'}${parsed.search}`;
  const cnonce = input.cnonce || crypto.randomBytes(16).toString('hex');
  const nc = Math.max(1, input.nonceCount || 1).toString(16).padStart(8, '0');
  const algorithm = challenge.algorithm;
  let ha1 = digestHash(algorithm, `${input.username}:${challenge.realm}:${input.password}`);
  if (algorithm.endsWith('-SESS')) ha1 = digestHash(algorithm, `${ha1}:${challenge.nonce}:${cnonce}`);
  let a2 = `${input.method.toUpperCase()}:${uri}`;
  if (challenge.qop === 'auth-int') {
    const body = bodyBytes(input.body);
    if (!body) return null;
    a2 += `:${digestHash(algorithm, body)}`;
  }
  const ha2 = digestHash(algorithm, a2);
  const response = challenge.qop
    ? digestHash(algorithm, `${ha1}:${challenge.nonce}:${nc}:${cnonce}:${challenge.qop}:${ha2}`)
    : digestHash(algorithm, `${ha1}:${challenge.nonce}:${ha2}`);
  const responseUsername = challenge.userhash ? digestHash(algorithm, `${input.username}:${challenge.realm}`) : input.username;
  const parts = [
    `username="${escapeQuoted(responseUsername)}"`,
    `realm="${escapeQuoted(challenge.realm)}"`,
    `nonce="${escapeQuoted(challenge.nonce)}"`,
    `uri="${escapeQuoted(uri)}"`,
    `response="${response}"`,
    `algorithm=${algorithm}`,
  ];
  if (challenge.opaque) parts.push(`opaque="${escapeQuoted(challenge.opaque)}"`);
  if (challenge.userhash) parts.push('userhash=true');
  if (challenge.qop) parts.push(`qop=${challenge.qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  return `Digest ${parts.join(', ')}`;
}

export function basicAuthorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

function requestHeaders(input: RequestInit['headers'] | undefined): Headers {
  return new Headers(input || {});
}

/**
 * DAV HTTP authentication with a Basic fast path and RFC 7616 Digest challenge fallback.
 *
 * The first request keeps the current pre-emptive Basic behaviour. If the server returns a
 * Digest challenge, the response body is drained and the identical replayable request is sent
 * once with Digest credentials. One additional retry is allowed only for `stale=true`, using
 * the replacement nonce supplied by the server. Redirect targets are taken from Response.url
 * and pass through safeFetch again, preserving the existing SSRF/TLS policy on every hop.
 */
export async function davAuthenticatedFetch(
  url: string,
  init: RequestInit,
  credentials: DavHttpCredentials,
  safeOptions: SafeFetchOptions = {},
): Promise<Response> {
  const send = (target: string, authorization: string | null) => {
    const headers = requestHeaders(init.headers);
    if (authorization) headers.set('Authorization', authorization);
    else headers.delete('Authorization');
    return safeFetch(target, { ...init, headers }, safeOptions);
  };

  // Never put a Basic credential on plaintext HTTP before the server has challenged us.
  // Private HTTP is an explicit operator opt-in, but a Digest-only Baikal deployment uses
  // Digest specifically so the reusable password does not travel as base64 on that link.
  const plaintext = new URL(url).protocol === 'http:';
  const initialAuthorization = plaintext ? null : basicAuthorization(credentials.username, credentials.password);
  let response = await send(url, initialAuthorization);
  if (response.status !== 401) return response;

  const authenticate = response.headers.get('www-authenticate');
  let challenge = parseDigestChallenge(authenticate);
  if (!challenge) {
    if (plaintext && /(?:^|,\s*)Basic(?:\s|$)/i.test(authenticate || '')) {
      const target = response.url || url;
      await response.arrayBuffer().catch(() => undefined);
      return send(target, basicAuthorization(credentials.username, credentials.password));
    }
    return response;
  }
  let target = response.url || url;
  await response.arrayBuffer().catch(() => undefined);

  for (let attempt = 1; attempt <= 2; attempt++) {
    const authorization = buildDigestAuthorization({
      challenge,
      method: init.method || 'GET',
      url: target,
      username: credentials.username,
      password: credentials.password,
      body: init.body,
      nonceCount: 1,
    });
    if (!authorization) return response;
    response = await send(target, authorization);
    if (response.status !== 401) return response;
    const next = parseDigestChallenge(response.headers.get('www-authenticate'));
    if (!next || !next.stale || next.nonce === challenge.nonce || attempt === 2) return response;
    await response.arrayBuffer().catch(() => undefined);
    challenge = next;
    target = response.url || target;
  }
  return response;
}
