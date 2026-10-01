import { PREVIEW_LIMIT } from './types.ts';
export interface DraftPreviewSource { filename: string; type: string; size?: number; path?: string; content?: string }
/** Decode a copy of draft bytes. Do not upload, rewrite or persist the draft. */
export function draftPreviewBlob(content: string, type: string): Blob {
  if (content.length > Math.ceil(PREVIEW_LIMIT / 3) * 4) throw new Error('LIMIT');
  let raw: string;
  try { raw = atob(content); } catch { throw new Error('CORRUPT'); }
  if (raw.length > PREVIEW_LIMIT) throw new Error('LIMIT');
  const bytes = Uint8Array.from(raw, character => character.charCodeAt(0));
  return new Blob([bytes], { type: type || 'application/octet-stream' });
}
