import type { ArchiveIndex } from './zip.ts';
export interface SheetData { names: string[]; rows: string[][]; limited: boolean; sheet: string }
export interface TextData { text: string; raw: string; encoding: string; failed: boolean; rows?: string[][]; limited?: boolean }
export interface AttachmentOperations {
  index: { input: { blob: Blob }; output: ArchiveIndex };
  extract: { input: { blob: Blob; name: string; remaining: number }; output: Blob };
  package: { input: { blob: Blob }; output: Array<{ name: string; blob: Blob }> };
  sheet: { input: { blob: Blob; sheet?: string }; output: SheetData };
  text: { input: { blob: Blob; type: string; kind: string; encoding?: string }; output: TextData };
  tiff: { input: { blob: Blob }; output: { rgba: Uint8Array<ArrayBuffer>; width: number; height: number } };
}
/** A disposable same-origin worker. Termination is the cancellation and CPU-time boundary. */
export function attachmentWork<K extends keyof AttachmentOperations>(kind: K, input: AttachmentOperations[K]['input'], signal: AbortSignal): Promise<AttachmentOperations[K]['output']> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./attachment.worker.ts', import.meta.url), { type: 'module' });
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); worker.terminate(); };
    const abort = () => { finish(); reject(new DOMException('Preview cancelled', 'AbortError')); };
    const timer = setTimeout(() => { finish(); reject(new Error('LIMIT')); }, 15000);
    signal.addEventListener('abort', abort, { once: true });
    worker.onerror = () => { finish(); reject(new Error('CORRUPT')); };
    worker.onmessage = (event: MessageEvent<{ result?: AttachmentOperations[K]['output']; error?: string }>) => {
      finish();
      if (event.data.error) reject(new Error(event.data.error));
      else if (event.data.result !== undefined) resolve(event.data.result);
      else reject(new Error('CORRUPT'));
    };
    worker.postMessage({ kind, input });
  });
}
