/** BOM and declared charset win. Legacy fallback is explicit, not pretend autodetection. */
export function decodeText(bytes: Uint8Array, mime = ''): { text: string; encoding: string; fallback: boolean } {
  let encoding = /charset\s*=\s*["']?([^\s;"']+)/i.exec(mime)?.[1];
  if (bytes[0] === 255 && bytes[1] === 254) encoding = 'utf-16le';
  else if (bytes[0] === 254 && bytes[1] === 255) encoding = 'utf-16be';
  else if (bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191) encoding = 'utf-8';
  try { return { text: new TextDecoder(encoding || 'utf-8', { fatal: true }).decode(bytes), encoding: encoding || 'utf-8', fallback: false }; }
  catch { return { text: new TextDecoder('windows-1250').decode(bytes), encoding: 'windows-1250', fallback: true }; }
}
