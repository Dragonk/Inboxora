import { markPreviewScanned, rememberSourceScan } from './safety.ts';
import { CSRF_HEADER, CSRF_VALUE } from '../api.ts';
import { getAuthEpoch, isCurrentAuthEpoch, onAuthEpochChange } from '../authEpoch.ts';
import { PREVIEW_LIMIT } from './types.ts';
type Progress = (loaded: number, total: number) => void;
interface Entry { listeners: Set<Progress>; progress?: [number, number]; controller: AbortController; promise: Promise<Blob>; blob?: Blob; users: number; touched: number }
const entries = new Map<string, Entry>();
const MAX_BYTES = 100 * 1024 * 1024;
/** Only application attachment paths, including immutable queue revisions. */
export function attachmentPath(path: string): string {
  if (!/^(?:\/api\/mail\/(?:messages|scheduled)\/[^/?#]+\/(?:attachments\/[^/?#]+(?:\?revision=\d+)?|attachments\.zip)|\/api\/mcp\/operations\/[0-9a-f-]+\/attachments\/\d+)$/.test(path)) throw new Error('Invalid attachment path');
  return path;
}
async function readBlob(path: string, signal: AbortSignal, progress?: (loaded: number, total: number) => void, preview = true): Promise<Blob> {
  const epoch = getAuthEpoch();
  const response = await fetch(attachmentPath(path) + (preview ? (path.includes('?') ? '&preview=1' : '?preview=1') : ''), { credentials: 'include', headers: { [CSRF_HEADER]: CSRF_VALUE }, signal, cache: 'no-store' });
  if (!response.ok) {
    const result: unknown = await response.json().catch(() => null);
    signal.throwIfAborted();
    const code = result && typeof result === 'object' && 'code' in result && typeof result.code === 'string' ? result.code : 'UNAVAILABLE';
    if (preview) rememberSourceScan(path, code, epoch);
    throw new Error(code);
  }
  const total = Number(response.headers.get('content-length')) || 0;
  if (total > PREVIEW_LIMIT) { await response.body?.cancel(); throw new Error('LIMIT'); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('UNAVAILABLE');
  const chunks: Uint8Array<ArrayBuffer>[] = []; let loaded = 0;
  try {
    while (true) {
      const result = await reader.read(); signal.throwIfAborted(); if (result.done) break;
      loaded += result.value.byteLength;
      if (loaded > PREVIEW_LIMIT) throw new Error('LIMIT');
      chunks.push(new Uint8Array(result.value)); progress?.(loaded, total);
    }
    signal.throwIfAborted();
    const blob = new Blob(chunks, { type: response.headers.get('content-type') || 'application/octet-stream' });
    if (preview && ['clean', 'disabled'].includes(response.headers.get('x-attachment-scan') || '')) markPreviewScanned(blob);
    if (preview) rememberSourceScan(path, response.headers.get('x-attachment-scan') || '', epoch);
    return blob;
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  finally { reader.releaseLock(); }
}
function reservedBytes(): number { return [...entries.values()].reduce((sum, entry) => sum + (entry.blob?.size ?? PREVIEW_LIMIT), 0); }
function evict(reservation = 0): void {
  const idle = [...entries.entries()].filter(([, entry]) => entry.users === 0).sort((a, b) => a[1].touched - b[1].touched);
  for (const [key, entry] of idle) {
    if (entries.size < 5 && reservedBytes() + reservation <= MAX_BYTES) break;
    entry.controller.abort(); entries.delete(key);
  }
}
export function acquireAttachment(path: string, epoch: number, progress?: (loaded: number, total: number) => void): { promise: Promise<Blob>; release: () => void } {
  attachmentPath(path);
  if (!isCurrentAuthEpoch(epoch)) throw new DOMException('Preview cancelled', 'AbortError');
  const key = `${epoch}:${path}`; let entry = entries.get(key);
  if (!entry) {
    evict(PREVIEW_LIMIT);
    if (reservedBytes() + PREVIEW_LIMIT > MAX_BYTES || entries.size >= 5) throw new Error('LIMIT');
    const controller = new AbortController();
    const next: Entry = { controller, promise: Promise.resolve(new Blob()), users: 0, touched: Date.now(), listeners: new Set() };
    next.promise = readBlob(path, controller.signal, (loaded, total) => {
      if (controller.signal.aborted || !isCurrentAuthEpoch(epoch)) return;
      next.progress = [loaded, total];
      for (const listener of next.listeners) listener(loaded, total);
    }).then(blob => {
      controller.signal.throwIfAborted();
      if (!isCurrentAuthEpoch(epoch)) throw new DOMException('Preview cancelled', 'AbortError');
      next.blob = blob; evict(); return blob;
    }).catch(error => { if (entries.get(key) === next) entries.delete(key); throw error; });
    entries.set(key, next); entry = next;
  }
  entry.users++; entry.touched = Date.now(); const held = entry; let released = false;
  // Each lease owns a separate listener, even when callers share a callback.
  const listener: Progress | undefined = progress ? (loaded, total) => progress(loaded, total) : undefined;
  if (listener) { held.listeners.add(listener); if (held.progress) listener(...held.progress); }
  return { promise: held.promise, release: () => {
    if (released) return; released = true; held.users--;
    if (listener) held.listeners.delete(listener);
    if (!held.users && !held.blob) { held.controller.abort(); if (entries.get(key) === held) entries.delete(key); }
    evict();
  } };
}
export function clearAttachmentCache(): void { for (const entry of entries.values()) { entry.listeners.clear(); entry.controller.abort(); } entries.clear(); }
export function clearIdleAttachments(): void { for (const [key, entry] of entries) if (!entry.users) { entry.controller.abort(); entries.delete(key); } }
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename.split('').map(c => c.charCodeAt(0) < 32 || c === '/' || c === '\\' ? '_' : c).join('') || 'attachment';
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Also clear resources for session transitions initiated outside the main store.
onAuthEpochChange(clearAttachmentCache);

const downloads = new Set<AbortController>();
/** Explicit original-byte downloads are never inserted into the preview cache. */
export async function fetchOriginalAttachment(path: string, epoch: number, signal: AbortSignal): Promise<Blob> {
  signal.throwIfAborted();
  if (!isCurrentAuthEpoch(epoch)) throw new DOMException('Cancelled', 'AbortError');
  if (downloads.size >= 2) throw new Error('LIMIT');
  const controller = new AbortController(); const abort = () => controller.abort();
  downloads.add(controller); signal.addEventListener('abort', abort, { once: true });
  try {
    const blob = await readBlob(path, controller.signal, undefined, false);
    controller.signal.throwIfAborted();
    if (!isCurrentAuthEpoch(epoch)) throw new DOMException('Cancelled', 'AbortError');
    return blob;
  } finally { signal.removeEventListener('abort', abort); downloads.delete(controller); }
}
onAuthEpochChange(() => { for (const controller of downloads) controller.abort(); });
