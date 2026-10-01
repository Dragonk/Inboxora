/** Print only a dedicated, fully prepared image document, not the virtualized application view. */
export async function printImages(blobs: Blob[], signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const frame = document.createElement('iframe'); frame.className = 'attachment-print-frame'; frame.setAttribute('aria-hidden', 'true');
  frame.setAttribute('sandbox', 'allow-same-origin allow-modals');
  frame.srcdoc = '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src blob:; style-src \'unsafe-inline\'"><style>@page{margin:0}body{margin:0}img{display:block;width:100%;height:100vh;object-fit:contain;break-after:page}img:last-child{break-after:auto}</style></head><body></body></html>';
  const urls: string[] = []; const previous = document.activeElement;
  let cleaned = false; let lifetime: ReturnType<typeof setTimeout> | undefined;
  const clean = () => { if (cleaned) return; cleaned = true; clearTimeout(lifetime); signal.removeEventListener('abort', clean); frame.remove(); urls.forEach(url => URL.revokeObjectURL(url)); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  signal.addEventListener('abort', clean, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error | DOMException) => { clearTimeout(timer); signal.removeEventListener('abort', abort); frame.onload = null; if (error) reject(error); else resolve(); };
      const abort = () => finish(new DOMException('Preview cancelled', 'AbortError'));
      const timer = setTimeout(() => finish(new Error('UNSUPPORTED')), 15000);
      signal.addEventListener('abort', abort, { once: true });
      frame.onload = () => finish(); document.body.append(frame);
    }); signal.throwIfAborted();
    const doc = frame.contentDocument; if (!doc || !frame.contentWindow) throw new Error('UNSUPPORTED');
    for (const blob of blobs) {
      const image = doc.createElement('img'); const url = URL.createObjectURL(blob); urls.push(url);
      image.src = url; doc.body.append(image); await image.decode(); signal.throwIfAborted();
    }
    frame.contentWindow.addEventListener('afterprint', clean, { once: true });
    frame.contentWindow.focus(); frame.contentWindow.print();
    // Some WebViews never emit afterprint. Bound the lifetime even in that case.
    if (!cleaned) lifetime = setTimeout(clean, 120000);
  } catch (error) { clean(); throw error; }
}
