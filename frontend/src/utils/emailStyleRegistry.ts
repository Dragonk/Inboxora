// Manages per-email <style> tag injection into document.head and their cleanup.
// Each email's scoped CSS lives in its own <style> element, keyed by prefix,
// so switching messages removes the old email's styles without touching others.
const injected = new Map(); // prefix → <style> element

export function injectEmailStyles(prefix, styleBlocks) {
  removeEmailStyles(prefix); // clean up any stale block from a prior render of the same prefix
  if (!styleBlocks.length) return;
  const el = document.createElement('style');
  el.dataset.emailPrefix = prefix;
  el.textContent = styleBlocks.join('\n');
  document.head.appendChild(el);
  injected.set(prefix, el);
}

export function removeEmailStyles(prefix) {
  const el = injected.get(prefix);
  if (el) { el.remove(); injected.delete(prefix); }
}
