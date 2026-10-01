import { IMAGE_PIXEL_LIMIT } from './types.ts';
/** Read raster headers before asking the browser to allocate a decoded image. */
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  let width = 0; let height = 0;
  if (bytes.length >= 24 && bytes[0] === 137 && ascii(1, 3) === 'PNG') { width = view.getUint32(16); height = view.getUint32(20); }
  else if (bytes.length >= 10 && /^GIF8[79]a/.test(ascii(0, 6))) { width = view.getUint16(6, true); height = view.getUint16(8, true); }
  else if (bytes.length >= 26 && ascii(0, 2) === 'BM') {
    if (view.getUint32(14, true) === 12) { width = view.getUint16(18, true); height = view.getUint16(20, true); }
    else { width = view.getInt32(18, true); height = Math.abs(view.getInt32(22, true)); }
  } else if (bytes.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const type = ascii(12, 4);
    if (type === 'VP8X') { width = 1 + bytes[24] + bytes[25] * 256 + bytes[26] * 65536; height = 1 + bytes[27] + bytes[28] * 256 + bytes[29] * 65536; }
    else if (type === 'VP8 ') { width = view.getUint16(26, true) & 16383; height = view.getUint16(28, true) & 16383; }
    else if (type === 'VP8L') { const packed = view.getUint32(21, true); width = 1 + (packed & 16383); height = 1 + (packed >>> 14 & 16383); }
  } else if (bytes[0] === 255 && bytes[1] === 216) {
    for (let offset = 2; offset + 9 < bytes.length;) {
      if (bytes[offset] !== 255) break;
      const marker = bytes[offset + 1]; if (marker === 255) { offset++; continue; }
      if (marker === 218 || marker === 217) break;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) { height = view.getUint16(offset + 5); width = view.getUint16(offset + 7); break; }
      if (marker === 1 || marker >= 208 && marker <= 215) { offset += 2; continue; }
      const length = view.getUint16(offset + 2); if (length < 2) break; offset += length + 2;
    }
  } else if (bytes.length > 24 && ascii(4, 4) === 'ftyp') {
    // AVIF's ImageSpatialExtents property is a full box inside meta/iprp/ipco.
    const walk = (start: number, end: number, depth: number): void => {
      if (depth > 8) throw new Error('LIMIT');
      for (let offset = start; offset + 8 <= end;) {
        const length = view.getUint32(offset); const type = ascii(offset + 4, 4);
        if (length < 8 || offset + length > end) break;
        if (type === 'ispe' && length >= 20) { width = Math.max(width, view.getUint32(offset + 12)); height = Math.max(height, view.getUint32(offset + 16)); }
        else if (['meta', 'iprp', 'ipco'].includes(type)) walk(offset + (type === 'meta' ? 12 : 8), offset + length, depth + 1);
        offset += length;
      }
    };
    walk(0, bytes.length, 0);
  }
  if (!width || !height) return null;
  if (!Number.isSafeInteger(width * height) || width < 1 || height < 1 || width * height > IMAGE_PIXEL_LIMIT || width > 32768 || height > 32768) throw new Error('LIMIT');
  return { width, height };
}
