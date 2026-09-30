import { imageDimensions } from './imageDimensions.ts';
import DOMPurify from 'dompurify';
import { IMAGE_PIXEL_LIMIT } from './types.ts';
import { attachmentWork } from './workerClient.ts';
/** Images never get an active SVG document or external resource references. */
export function sanitizeSvg(source: string): string {
  const safe = DOMPurify.sanitize(source, { USE_PROFILES: { svg: true, svgFilters: false, html: false },
    FORBID_TAGS: ['foreignObject', 'script', 'style', 'image', 'feImage', 'a', 'animate', 'animateTransform', 'set'],
    FORBID_ATTR: ['style', 'onload', 'onerror', 'onclick'] });
  const parsed = new DOMParser().parseFromString(safe, 'image/svg+xml');
  if (parsed.querySelector('parsererror') || parsed.documentElement.localName !== 'svg') throw new Error('CORRUPT');
  for (const element of parsed.querySelectorAll('*')) for (const attribute of [...element.attributes]) {
    const value = attribute.value.trim();
    if (attribute.localName === 'href' && !value.startsWith('#') || /url\s*\(/i.test(value) && !/^url\(\s*['"]?#[\w:.-]+['"]?\s*\)$/i.test(value)) element.removeAttributeNode(attribute);
  }
  const root = parsed.documentElement;
  const width = parseFloat(root.getAttribute('width') || '0'); const height = parseFloat(root.getAttribute('height') || '0');
  if (width * height > IMAGE_PIXEL_LIMIT || width > 32768 || height > 32768) throw new Error('LIMIT');
  return new XMLSerializer().serializeToString(root);
}
export async function imageBlob(blob: Blob, kind: string, signal: AbortSignal): Promise<Blob> {
  if (kind === 'svg') {
    if (blob.size > 2 * 1024 * 1024) throw new Error('LIMIT');
    const result = new Blob([sanitizeSvg(await blob.text())], { type: 'image/svg+xml' }); signal.throwIfAborted(); return result;
  }
  if (kind === 'tiff') {
    const { rgba, width, height } = await attachmentWork('tiff', { blob }, signal);
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d'); if (!context) throw new Error('UNSUPPORTED');
    context.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
    const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('CORRUPT')), 'image/png'));
    canvas.width = 0; canvas.height = 0; signal.throwIfAborted(); return png;
  }
  if (!imageDimensions(new Uint8Array(await blob.slice(0, 1024 * 1024).arrayBuffer()))) throw new Error('UNSUPPORTED');
  signal.throwIfAborted(); return blob;
}
export async function loadImage(blob: Blob, signal: AbortSignal): Promise<HTMLImageElement> {
  signal.throwIfAborted(); const url = URL.createObjectURL(blob); const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      const abort = () => { image.src = ''; reject(new DOMException('Preview cancelled', 'AbortError')); };
      const finish = () => signal.removeEventListener('abort', abort);
      signal.addEventListener('abort', abort, { once: true });
      image.onload = () => { finish(); resolve(); }; image.onerror = () => { finish(); reject(new Error('CORRUPT')); }; image.src = url;
    });
    if (image.naturalWidth * image.naturalHeight > IMAGE_PIXEL_LIMIT) throw new Error('LIMIT');
    return image;
  } finally { URL.revokeObjectURL(url); }
}
export async function imagePng(blob: Blob, signal: AbortSignal, thumbnail = false): Promise<Blob> {
  const image = await loadImage(blob, signal); const canvas = document.createElement('canvas');
  const factor = thumbnail ? Math.min(1, 48 / Math.max(image.naturalWidth, image.naturalHeight)) : 1;
  canvas.width = Math.max(1, Math.round(image.naturalWidth * factor)); canvas.height = Math.max(1, Math.round(image.naturalHeight * factor));
  const context = canvas.getContext('2d'); if (!context) throw new Error('UNSUPPORTED'); context.drawImage(image, 0, 0, canvas.width, canvas.height);
  try { const result = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('CORRUPT')), 'image/png')); signal.throwIfAborted(); return result; }
  finally { canvas.width = 0; canvas.height = 0; image.src = ''; }
}
