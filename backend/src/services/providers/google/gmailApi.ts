import { googleApiJson, googleApiRequest, googleApiVoid, googleUrl } from './googleApiClient.js';
import type { GoogleApiOptions } from './googleApiClient.js';

/**
 * Authenticated Gmail REST access for the Gmail adapter (P08).
 *
 * This is deliberately a thin layer over {@link ./googleApiClient.js}: the token
 * grant, the single-flight refresh, the one controlled 401 retry and the closed
 * error classification are the same ones the Calendar and People adapters use, and
 * a second client would be a second set of those behaviours. What it adds is only
 * what Gmail itself needs — the `gmail/v1` base, the `users/me` paths, the
 * base64url encoding its `raw` representations use, and the fact that several of
 * its successful answers carry no body at all.
 *
 * The Gmail API addresses every resource through `users/{userId}`, and `me` is the
 * authenticated user. The adapter always uses `me`: a grant is bound to one
 * mailbox, and addressing it by any other id would be addressing a mailbox the
 * connection does not own.
 */

export const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1';
export const GMAIL_USER = 'me';

/** Gmail's own limits, kept in the provider's terms rather than invented. */
export const GMAIL_MAX_RAW_MESSAGE_BYTES = 25 * 1024 * 1024;
export const GMAIL_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Build a Gmail URL with only the defined query parameters. */
export function gmailUrl(
  path: string,
  params: Record<string, string | number | boolean | readonly string[] | null | undefined> = {},
): string {
  // The base carries no trailing slash, so a path is always joined with exactly one.
  return googleUrl(GMAIL_API_BASE, path.startsWith('/') ? path : `/${path}`, params);
}

/** `POST` JSON to Gmail and decode the answer (or `null` for an empty success). */
export async function gmailPost<T>(options: GoogleApiOptions, path: string, body: unknown): Promise<T | null> {
  return googleApiJson<T>(options, gmailUrl(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** `PUT` JSON to Gmail and decode the answer. */
export async function gmailPut<T>(options: GoogleApiOptions, path: string, body: unknown): Promise<T | null> {
  return googleApiJson<T>(options, gmailUrl(path), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** `PATCH` JSON to Gmail and decode the answer. */
export async function gmailPatch<T>(options: GoogleApiOptions, path: string, body: unknown): Promise<T | null> {
  return googleApiJson<T>(options, gmailUrl(path), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** `GET` from Gmail and decode the answer. */
export async function gmailGet<T>(options: GoogleApiOptions, path: string, params: Record<string, string | number | boolean | readonly string[] | null | undefined> = {}): Promise<T> {
  const result = await googleApiJson<T>(options, gmailUrl(path, params), { method: 'GET' });
  if (result === null) {
    // A `GET` that succeeds with no body is not a shape this adapter can use, and
    // returning an empty object would push the failure into the caller's field
    // reads. Gmail does not do this for the resources read here, so it is a
    // provider contract violation rather than a normal answer.
    throw new Error('Gmail returned an empty body for a read');
  }
  return result;
}

/** `DELETE` a Gmail resource. Gmail answers `204` on success. */
export async function gmailDelete(options: GoogleApiOptions, path: string): Promise<void> {
  await googleApiVoid(options, gmailUrl(path), { method: 'DELETE' });
}

/** `POST` with no request body, for Gmail's action endpoints. */
export async function gmailAction(options: GoogleApiOptions, path: string, body: unknown = {}): Promise<void> {
  await googleApiVoid(options, gmailUrl(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Encode a buffer the way Gmail's `raw` fields expect: **base64url**, no padding.
 *
 * Standard base64 is accepted by some Google endpoints but not by `raw` in a
 * create/send body, where `+` and `/` would be misread as part of the URL-safe
 * alphabet — encoding it correctly here is what keeps a message whose bytes happen
 * to produce those characters from being rejected.
 */
export function toBase64Url(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode a base64url (or base64) field Gmail returned. */
export function fromBase64Url(value: string): Buffer {
  const normalised = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalised.length % 4 === 0 ? normalised : normalised + '='.repeat(4 - (normalised.length % 4));
  return Buffer.from(padded, 'base64');
}

/**
 * The raw response of a Gmail request, for a caller that must decide for itself
 * whether an answer is a refusal or an unknown outcome (the send path).
 */
export async function gmailRaw(options: GoogleApiOptions, path: string, init: RequestInit): Promise<Response> {
  return googleApiRequest(options, gmailUrl(path), init);
}
