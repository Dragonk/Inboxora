import type { ArchiveIndex } from './zip.ts';
import type { PreviewFile } from './types.ts';
import { EXPANSION_LIMIT, PREVIEW_LIMIT } from './types.ts';
import { attachmentWork } from './workerClient.ts';
import { processAttachment } from './processing.ts';
import { ensurePreviewSafe } from './safety.ts';
import { onAuthEpochChange } from '../authEpoch.ts';
export type ArchiveEntry = ArchiveIndex['entries'][number];
let view: 'list' | 'grid' = 'grid';
onAuthEpochChange(() => { view = 'grid'; });
export const archiveView = () => view;
export function saveArchiveView(next: 'list' | 'grid'): void { view = next; }

export function archiveFolder(entries: ArchiveEntry[], folder: string): ArchiveEntry[] {
  const children = new Map<string, ArchiveEntry>();
  for (const entry of entries) {
    if (!entry.name.startsWith(folder)) continue;
    const relative = entry.name.slice(folder.length); if (!relative) continue;
    const slash = relative.indexOf('/');
    const directory = slash >= 0 || entry.directory;
    let name = folder + (slash >= 0 ? relative.slice(0, slash + 1) : relative);
    if (directory && !name.endsWith('/')) name += '/';
    if (!children.has(name)) children.set(name, directory ? { name, size: 0, directory: true, encrypted: false } : entry);
  }
  return [...children.values()].sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** Serial, memory-bounded reads shared by thumbnails and the selected file. */
export class ArchiveSession {
  private controller = new AbortController();
  private tail: Promise<void> = Promise.resolve();
  private cache = new Map<string, Blob>();
  private cachedBytes = 0;
  private thumbnailBytes = 0;
  constructor(private file: PreviewFile, private server: boolean) {}
  dispose(): void { this.controller.abort(); this.cache.clear(); this.cachedBytes = 0; }
  read(entry: ArchiveEntry, signal: AbortSignal, thumbnail = false): Promise<Blob> {
    const combined = AbortSignal.any([signal, this.controller.signal]);
    const operation = this.tail.then(async () => {
      combined.throwIfAborted();
      const cached = this.cache.get(entry.name);
      if (thumbnail && cached && cached.size > 2 * 1024 * 1024) throw new Error('LIMIT');
      if (cached) { if (thumbnail) await ensurePreviewSafe(cached, combined); return cached; }
      if (this.file.depth >= 3 || entry.encrypted || entry.directory) throw new Error(entry.encrypted ? 'ENCRYPTED_ZIP' : 'LIMIT');
      if (thumbnail && (entry.size > 2 * 1024 * 1024 || this.thumbnailBytes + entry.size > 20 * 1024 * 1024)) throw new Error('LIMIT');
      const remaining = Math.min(EXPANSION_LIMIT - this.file.budget.expanded, thumbnail ? Math.min(2 * 1024 * 1024, 20 * 1024 * 1024 - this.thumbnailBytes) : PREVIEW_LIMIT);
      const bytes = this.server ? await (await processAttachment(this.file.blob, 'archive-extract', { entry: entry.name, filename: this.file.filename, remaining: String(remaining) }, combined)).blob()
        : await attachmentWork('extract', { blob: this.file.blob, name: entry.name, remaining }, combined);
      combined.throwIfAborted();
      if (bytes.size > remaining || bytes.size > PREVIEW_LIMIT) throw new Error('LIMIT');
      this.file.budget.expanded += bytes.size;
      if (thumbnail) this.thumbnailBytes += bytes.size;
      if (thumbnail) await ensurePreviewSafe(bytes, combined); combined.throwIfAborted();
      if (bytes.size <= 16 * 1024 * 1024) {
        while (this.cache.size && (this.cache.size >= 12 || this.cachedBytes + bytes.size > 16 * 1024 * 1024)) {
          const key = this.cache.keys().next().value!;
          this.cachedBytes -= this.cache.get(key)!.size; this.cache.delete(key);
        }
        this.cache.set(entry.name, bytes); this.cachedBytes += bytes.size;
      }
      return bytes;
    });
    // Callers receive errors; rejection must not poison the next queued read.
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }
}

// Include browser decoding in the global thumbnail queue: a tiny compressed
// image can still decode to tens of megabytes, even when extraction is serial.
let thumbnailQueue: Promise<void> = Promise.resolve();
export function withArchiveThumbnail<T>(signal: AbortSignal, load: () => Promise<T>): Promise<T> {
  const work = thumbnailQueue.then(() => { signal.throwIfAborted(); return load(); });
  thumbnailQueue = work.then(() => undefined, () => undefined);
  return work;
}
