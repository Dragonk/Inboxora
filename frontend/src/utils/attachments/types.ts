export type AttachmentKind = 'image' | 'tiff' | 'svg' | 'pdf' | 'docx' | 'sheet' | 'office' | 'markdown' | 'json' | 'xml' | 'csv' | 'text' | 'zip' | 'audio' | 'video' | 'html' | 'eml' | 'ics' | 'vcf' | 'unsupported';
export interface PreviewAttachment { filename: string; type: string; size?: number; path: string }
export interface AttachmentSelection {
  attachments: PreviewAttachment[];
  index: number;
  authEpoch: number;
  downloadAllPath?: string;
  downloadAllDangerous?: boolean;
}
export interface AttachmentWindow {
  id: string;
  selection: AttachmentSelection;
  x: number; y: number; w: number; h: number;
  z: number;
  minimized: boolean;
}
export interface PreviewFile {
  filename: string;
  type: string;
  blob: Blob;
  budget: { expanded: number };
  depth: number;
}
export const PREVIEW_LIMIT = 50 * 1024 * 1024;
export const EXPANSION_LIMIT = 150 * 1024 * 1024;
export const TEXT_LIMIT = 2 * 1024 * 1024;
export const IMAGE_PIXEL_LIMIT = 24 * 1024 * 1024;
