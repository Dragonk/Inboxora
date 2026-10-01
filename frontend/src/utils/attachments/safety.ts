import { getAuthEpoch, isCurrentAuthEpoch, onAuthEpochChange } from '../authEpoch.ts';
import { processAttachment } from './processing.ts';
let verified = new WeakMap<Blob, { epoch: number; expires: number }>();
onAuthEpochChange(() => { verified = new WeakMap(); });
export function markPreviewScanned(blob: Blob): void {
  verified.set(blob, { epoch: getAuthEpoch(), expires: Date.now() + 30000 });
}
export async function ensurePreviewSafe(blob: Blob, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  const epoch = getAuthEpoch(); const known = verified.get(blob);
  if (known?.epoch === epoch && known.expires > Date.now()) return true;
  const response = await processAttachment(blob, 'scan', {}, signal);
  const result: unknown = await response.json(); signal.throwIfAborted();
  if (!isCurrentAuthEpoch(epoch)) throw new DOMException('Cancelled', 'AbortError');
  if (!result || typeof result !== 'object' || !('scan' in result) || !['clean', 'disabled'].includes(String(result.scan))) throw new Error('SCAN_UNAVAILABLE');
  markPreviewScanned(blob); return true;
}
export function scanBlocked(error?: string): boolean {
  return error === 'INFECTED' || error === 'SCAN_UNAVAILABLE' || error === 'SCAN_LIMIT';
}

// Remember scan failures for the separate chip/download actions, without retaining files.
const sourceWarnings = new Map<string, string>();
onAuthEpochChange(() => sourceWarnings.clear());
export function sourceScanWarning(path: string | undefined): string | undefined {
  return path ? sourceWarnings.get(path) : undefined;
}
export function rememberSourceScan(path: string, result: string, epoch: number): void {
  if (!isCurrentAuthEpoch(epoch)) return;
  if (scanBlocked(result)) {
    if (sourceWarnings.size >= 512) sourceWarnings.delete(sourceWarnings.keys().next().value!);
    sourceWarnings.set(path, result);
  } else if (result === 'clean') sourceWarnings.delete(path);
}
