import { onAuthEpochChange, isCurrentAuthEpoch } from '../authEpoch.ts';
import { detectKind } from './attachmentKind.ts';
import { imageBlob } from './image.ts';
import type { PreviewFile } from './types.ts';
const opened = new Map<string, ReturnType<typeof setTimeout>>();
function dispose(url: string) { clearTimeout(opened.get(url)); URL.revokeObjectURL(url); opened.delete(url); }
onAuthEpochChange(() => { for (const url of opened.keys()) dispose(url); });
export async function nativePreviewBlob(file: PreviewFile, signal: AbortSignal): Promise<Blob | undefined> {
  const bytes = new Uint8Array(await file.blob.slice(0, 4096).arrayBuffer()); signal.throwIfAborted();
  const kind = detectKind(file.filename, file.type, bytes);
  if (kind === 'pdf') return new Blob([file.blob], { type: 'application/pdf' });
  if (!['image', 'svg', 'tiff'].includes(kind)) return undefined;
  const image = await imageBlob(file.blob, kind, signal);
  const ascii = new TextDecoder('latin1').decode(bytes.slice(0, 40));
  const type = kind === 'tiff' ? 'image/png' : kind === 'svg' ? 'image/svg+xml' : bytes[0] === 137 ? 'image/png' : bytes[0] === 255 ? 'image/jpeg' : ascii.startsWith('GIF') ? 'image/gif' : ascii.startsWith('BM') ? 'image/bmp' : ascii.startsWith('RIFF') ? 'image/webp' : 'image/avif';
  signal.throwIfAborted(); return new Blob([image], { type });
}
// Called synchronously from a click, only after the preview's safety gate.
export function openNativePreview(blob: Blob, epoch: number): void {
  if (!isCurrentAuthEpoch(epoch)) return;
  if (opened.size >= 4) dispose(opened.keys().next().value!);
  const url = URL.createObjectURL(blob); const link = document.createElement('a');
  link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
  document.body.append(link); link.click(); link.remove();
  opened.set(url, setTimeout(() => dispose(url), 10 * 60 * 1000));
}
