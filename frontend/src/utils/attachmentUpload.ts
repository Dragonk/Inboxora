export interface AttachmentLimits { singleAttachmentBytes?: number | null; totalAttachmentBytes?: number | null }
export type AttachmentLimitIssue = { kind: 'single' | 'total'; name: string; actual: number; limit: number };
/** Reserve the complete batch before any asynchronous read can start. */
export function attachmentBatchIssue(files: readonly { name: string; size: number }[], existing: number, pending: number, limits: AttachmentLimits): AttachmentLimitIssue | null {
  const single = limits.singleAttachmentBytes;
  for (const file of files) {
    if (single != null && file.size > single) return { kind: 'single', name: file.name, actual: file.size, limit: single };
  }
  const actual = existing + pending + files.reduce((sum, file) => sum + file.size, 0);
  const total = limits.totalAttachmentBytes;
  return total != null && actual > total ? { kind: 'total', name: '', actual, limit: total } : null;
}
export function attachmentWarningMiB(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 150 ? value : 20;
}
