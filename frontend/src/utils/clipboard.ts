import { getAuthEpoch, isCurrentAuthEpoch } from './authEpoch.ts';
/** Write from the top-level user gesture, not from a sandboxed mail document. */
export async function writeClipboardText(text: string): Promise<void> {
  const epoch = getAuthEpoch();
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return; }
    catch { /* Fall back for local HTTP and restricted WebViews. */ }
  }
  if (!isCurrentAuthEpoch(epoch)) throw new DOMException('Cancelled', 'AbortError');
  const previous = document.activeElement;
  const selection = document.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
  const textarea = document.createElement('textarea'); textarea.value = text;
  textarea.readOnly = true;
  textarea.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0';
  const host = document.querySelector('.ui-overlay:last-of-type .ui-dialog') || document.body;
  host.append(textarea);
  try {
    textarea.focus(); textarea.select();
    if (!document.execCommand('copy')) throw new Error('COPY_UNAVAILABLE');
  } finally {
    textarea.remove();
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    selection?.removeAllRanges(); for (const range of ranges) selection?.addRange(range);
  }
}
