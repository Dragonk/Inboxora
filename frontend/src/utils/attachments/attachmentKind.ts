import type { AttachmentKind } from './types.ts';
const groups: Partial<Record<AttachmentKind, string>> = {
  image: 'png jpg jpeg gif webp avif bmp', tiff: 'tif tiff', svg: 'svg', pdf: 'pdf',
  docx: 'docx', sheet: 'xlsx xls ods', markdown: 'md markdown', json: 'json jsonc',
  xml: 'xml xsd xsl xslt rss atom', csv: 'csv tsv',
  text: 'txt text log ini conf cfg yaml yml toml js jsx ts tsx css scss py rb go rs c h cpp hpp java sh sql diff patch properties env',
  archive: '7z 7zip rar tar tgz tbz tbz2 txz gz gzip bz2 xz zst zstd', zip: 'zip', audio: 'mp3 wav ogg oga flac m4a aac', video: 'mp4 webm ogv mov',
  html: 'html htm', eml: 'eml', ics: 'ics ical', vcf: 'vcf vcard',
};
export function extension(name: string): string {
  return name.split('.').at(-1)?.toLowerCase() || '';
}
export function isCompound(bytes: Uint8Array): boolean {
  return [208, 207, 17, 224, 161, 177, 26, 225].every((b, i) => bytes[i] === b);
}
export function isZip(bytes: Uint8Array): boolean {
  return bytes[0] === 80 && bytes[1] === 75 && ((bytes[2] === 3 && bytes[3] === 4) || (bytes[2] === 5 && bytes[3] === 6) || (bytes[2] === 7 && bytes[3] === 8));
}
/** Magic wins over unreliable MIME. Executables and download-only formats stay inert. */
export function detectKind(filename: string, mime = '', bytes?: Uint8Array): AttachmentKind {
  const ext = extension(filename);
  if (['doc', 'ppt', 'pptx', 'odt', 'odp', 'docm', 'xlsm', 'pptm', 'exe', 'com', 'bat', 'cmd', 'msi', 'scr', 'dll', 'jar', 'apk'].includes(ext)) return 'unsupported';
  const byExtension = Object.entries(groups).find(([, list]) => list?.split(' ').includes(ext))?.[0] as AttachmentKind | undefined;
  const type = mime.split(';')[0].trim().toLowerCase();
  const mimeKinds: Partial<Record<string, AttachmentKind>> = {
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'sheet',
    'application/vnd.ms-excel': 'sheet', 'application/vnd.oasis.opendocument.spreadsheet': 'sheet',
    'application/x-7z-compressed': 'archive', 'application/vnd.rar': 'archive', 'application/x-rar-compressed': 'archive', 'application/x-tar': 'archive', 'application/gzip': 'archive',
    'application/pdf': 'pdf', 'application/zip': 'zip', 'text/html': 'html',
    'text/markdown': 'markdown', 'text/csv': 'csv', 'text/tab-separated-values': 'csv',
    'image/svg+xml': 'svg', 'image/tiff': 'tiff',
  };
  const declared = byExtension || mimeKinds[type] || (type.startsWith('image/') ? 'image' : type.startsWith('audio/') ? 'audio' : type.startsWith('video/') ? 'video' : undefined);

  if (bytes?.length) {
    const ascii = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
    if (ascii.includes('%PDF-')) return 'pdf';
    if ((ascii.startsWith('7z') && bytes[2] === 188 && bytes[3] === 175 && bytes[4] === 39 && bytes[5] === 28)
      || (ascii.startsWith('Rar!') && bytes[4] === 26 && bytes[5] === 7)
      || (bytes[0] === 31 && bytes[1] === 139) || ascii.startsWith('BZh')
      || (bytes[0] === 253 && ascii.slice(1, 5) === '7zXZ' && bytes[5] === 0)
      || (bytes[0] === 40 && bytes[1] === 181 && bytes[2] === 47 && bytes[3] === 253)
      || ascii.slice(257, 262) === 'ustar') return 'archive';
    if (isCompound(bytes)) return declared === 'docx' || declared === 'sheet' ? 'office' : 'unsupported';
    if (isZip(bytes)) return declared === 'docx' || declared === 'sheet' ? declared : 'zip';
    if ((bytes[0] === 137 && ascii.slice(1, 4) === 'PNG') || (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) || /^GIF8[79]a/.test(ascii) || ascii.startsWith('BM') || (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') || (ascii.slice(4, 8) === 'ftyp' && /avif|avis/.test(ascii.slice(8, 40)))) return 'image';
    if (bytes[0] === 73 && bytes[1] === 73 && bytes[2] === 42 && bytes[3] === 0 || bytes[0] === 77 && bytes[1] === 77 && bytes[2] === 0 && bytes[3] === 42) return 'tiff';
    if ((ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WAVE') || ascii.startsWith('ID3') || ascii.startsWith('fLaC')) return 'audio';
    if (/^(?:\s*<\?xml[^>]*>\s*)?\s*<svg\b/i.test(ascii)) return 'svg';
    if (['image', 'tiff', 'pdf', 'docx', 'zip'].includes(declared || '')) return 'unsupported';
    if (bytes.subarray(0, 4096).includes(0) && !(bytes[0] === 255 && bytes[1] === 254 || bytes[0] === 254 && bytes[1] === 255) && !['audio', 'video', 'sheet', 'archive'].includes(declared || '')) return 'unsupported';
  }
  if (declared) return declared;
  if (type === 'application/pdf') return 'pdf';
  if (type === 'text/calendar') return 'ics';
  if (type === 'text/vcard' || type === 'text/x-vcard') return 'vcf';
  if (type === 'message/rfc822') return 'eml';
  if (type === 'application/json') return 'json';
  if (type === 'application/xml' || type === 'text/xml') return 'xml';
  if (type.startsWith('text/')) return 'text';
  return 'unsupported';
}
export function isImageKind(kind: AttachmentKind): boolean { return kind === 'image' || kind === 'svg' || kind === 'tiff'; }
