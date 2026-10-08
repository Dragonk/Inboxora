import { BlobReader, ZipReader, ERR_UNSAFE_FILENAME, type Entry, type FileEntry } from '@zip.js/zip.js/index-native.js';
import { EXPANSION_LIMIT, PREVIEW_LIMIT } from './types.ts';

export interface ArchiveItem { name: string; size: number; encrypted: boolean; directory: boolean }
export interface ArchiveIndex { entries: ArchiveItem[]; total: number }
/** No filesystem paths are used, but reject ambiguous names before offering downloads. */
export function safeArchiveName(name: string): boolean {
  return name.length > 0 && name.length <= 1024 && !Array.from(name).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || character.charCodeAt(0) === 92)
    && !name.startsWith('/') && !/^[a-z]:/i.test(name)
    && !name.split('/').some(part => part === '..' || part === '.');
}
export async function openArchive(blob: Blob, maxEntries = 500): Promise<{ reader: ZipReader<Blob>; entries: Entry[]; total: number }> {
  if (blob.size > PREVIEW_LIMIT) throw new Error('LIMIT');
  const reader = new ZipReader(new BlobReader(blob), {
    useWebWorkers: false, useCompressionStream: true, strictness: 'strict', checkCrc32: true,
  });
  const entries: Entry[] = []; const names = new Set<string>(); let total = 0;
  try {
    for await (const entry of reader.getEntriesGenerator()) {
      if (entries.length >= maxEntries || !safeArchiveName(entry.filename) || entry.symlink || names.has(entry.filename)) throw new Error('LIMIT');
      names.add(entry.filename);
      if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || entry.uncompressedSize > PREVIEW_LIMIT) throw new Error('LIMIT');
      total += entry.uncompressedSize;
      if (total > EXPANSION_LIMIT) throw new Error('LIMIT');
      entries.push(entry);
    }
    return { reader, entries, total };
  } catch (error) { await reader.close(); if (error instanceof Error && error.message === ERR_UNSAFE_FILENAME) throw new Error('LIMIT', { cause: error }); throw error; }
}
/** Count actual output before retaining each chunk; declared lengths are not a resource boundary. */
export async function extractEntry(entry: FileEntry, remaining = PREVIEW_LIMIT): Promise<Blob> {
  if (entry.encrypted) throw new Error('ENCRYPTED_ZIP');
  const chunks: Uint8Array<ArrayBuffer>[] = []; let bytes = 0; let limited = false;
  try {
    await entry.getData(new WritableStream<Uint8Array>({
      write(chunk) {
        bytes += chunk.byteLength;
        if (bytes > Math.min(PREVIEW_LIMIT, remaining)) { limited = true; throw new Error('LIMIT'); }
        chunks.push(new Uint8Array(chunk));
      },
    }), { checkCrc32: true, strictness: 'strict', useWebWorkers: false, useCompressionStream: true });
  } catch (error) {
    // zip.js closes the writable after a failed write; on newer runtimes (Node >= 24,
    // modern browsers) that close itself throws ERR_INVALID_STATE and would otherwise
    // swallow the limit error. Re-surface the original limit violation.
    if (limited) throw new Error('LIMIT', { cause: error });
    throw error;
  }
  if (bytes !== entry.uncompressedSize) throw new Error('CORRUPT');
  return new Blob(chunks);
}
export async function archiveIndex(blob: Blob, maxEntries = 500): Promise<ArchiveIndex> {
  const archive = await openArchive(blob, maxEntries);
  try { return { entries: archive.entries.map(entry => ({ name: entry.filename, size: entry.uncompressedSize, encrypted: entry.encrypted, directory: entry.directory })), total: archive.total }; }
  finally { await archive.reader.close(); }
}
export async function archiveExtract(blob: Blob, name: string, remaining: number): Promise<Blob> {
  const archive = await openArchive(blob);
  try {
    const entry = archive.entries.find(entry => entry.filename === name);
    if (!entry || entry.directory) throw new Error('CORRUPT');
    return await extractEntry(entry, remaining);
  } finally { await archive.reader.close(); }
}
/** Office containers get the same streamed ZIP checks, before a renderer can decompress them. */
export async function officeEntries(blob: Blob): Promise<Array<{ name: string; blob: Blob }>> {
  const archive = await openArchive(blob, 3000);
  try {
    const output: Array<{ name: string; blob: Blob }> = []; let bytes = 0;
    for (const entry of archive.entries) {
      if (entry.directory) continue;
      const value = await extractEntry(entry, PREVIEW_LIMIT - bytes); bytes += value.size;
      output.push({ name: entry.filename, blob: value });
    }
    return output;
  } finally { await archive.reader.close(); }
}
