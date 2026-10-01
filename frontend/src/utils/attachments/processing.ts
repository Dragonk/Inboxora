import { getAuthEpoch, isCurrentAuthEpoch } from '../authEpoch.ts';
import { CSRF_HEADER, CSRF_VALUE } from '../api.ts';
import { PREVIEW_LIMIT } from './types.ts';
export type ProcessingAction = 'probe' | 'unlock' | 'eml-parse' | 'eml-part' | 'cards' | 'scan' | 'signatures' | 'archive-index' | 'archive-extract';
/** The server processes only these supplied bytes; it never fetches a client-supplied URL. */
export async function processAttachment(blob: Blob, action: ProcessingAction, fields: Record<string, string>, signal: AbortSignal): Promise<Response> {
  const epoch = getAuthEpoch();
  signal.throwIfAborted(); if (blob.size > PREVIEW_LIMIT) throw new Error('LIMIT');
  const body = new FormData(); body.append('file', blob, 'attachment');
  for (const [name, value] of Object.entries(fields)) body.append(name, value);
  const response = await fetch(`/api/mail/attachments/process/${action}`, { method: 'POST', credentials: 'include', cache: 'no-store', headers: { [CSRF_HEADER]: CSRF_VALUE }, body, signal });
  if (!isCurrentAuthEpoch(epoch)) throw new DOMException('Preview cancelled', 'AbortError');
  if (!response.ok) {
    const result: unknown = await response.json().catch(() => null);
    const code = result && typeof result === 'object' && 'code' in result && typeof result.code === 'string' ? result.code : 'UNAVAILABLE';
    throw new Error(code);
  }
  signal.throwIfAborted(); return response;
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CORRUPT');
  return value as Record<string, unknown>;
}
export function textValue(value: unknown): string { return typeof value === 'string' ? value : ''; }
