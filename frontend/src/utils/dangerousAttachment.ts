export interface AttachmentRiskInput {
  filename?: string | null;
  type?: string | null;
}

const DANGEROUS_EXTENSIONS = new Set([
  'app', 'bat', 'cmd', 'com', 'cpl', 'dll', 'exe', 'hta', 'jar', 'jse', 'js',
  'lnk', 'msi', 'msp', 'pif', 'ps1', 'scr', 'sh', 'vbe', 'vbs', 'wsf', 'wsh',
]);

const DANGEROUS_MEDIA_TYPES = new Set([
  'application/java-archive',
  'application/vnd.microsoft.portable-executable',
  'application/x-bat',
  'application/x-dosexec',
  'application/x-java-archive',
  'application/x-msdownload',
  'application/x-ms-installer',
  'application/x-msdos-program',
  'application/x-msi',
  'application/x-sh',
  'text/x-shellscript',
]);

function extensionOf(filename: string | null | undefined): string {
  const normalized = filename?.trim().replace(/[.\s]+$/g, '').toLowerCase() || '';
  const separator = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  const basename = normalized.slice(separator + 1);
  const dot = basename.lastIndexOf('.');
  return dot > 0 ? basename.slice(dot + 1) : '';
}

function mediaTypeOf(type: string | null | undefined): string {
  return type?.split(';', 1)[0]?.trim().toLowerCase() || '';
}

/** Identifies attachments that can execute code when opened by the operating system. */
export function isDangerousAttachment({ filename, type }: AttachmentRiskInput): boolean {
  return DANGEROUS_EXTENSIONS.has(extensionOf(filename)) || DANGEROUS_MEDIA_TYPES.has(mediaTypeOf(type));
}
