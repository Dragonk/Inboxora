import type { ScheduledSummary } from './scheduledMail.ts';

const terminal = new Set(['sent', 'cancelled', 'dismissed']);
/** Keep sent results for this visit even when another tab/device acknowledges them. */
export function mergeScheduledVisit(previous: readonly ScheduledSummary[], fresh: readonly ScheduledSummary[], cancelled: ReadonlySet<string> = new Set()): ScheduledSummary[] {
  const rows = new Map(previous.filter(row => row.state === 'sent' && !cancelled.has(row.id)).map(row => [row.id, row]));
  for (const row of fresh) {
    if (row.state === 'cancelled' || cancelled.has(row.id)) rows.delete(row.id);
    else rows.set(row.id, row);
  }
  return [...rows.values()].sort((a, b) => Number(terminal.has(a.state)) - Number(terminal.has(b.state))
    || Date.parse(b.scheduledAt) - Date.parse(a.scheduledAt) || b.id.localeCompare(a.id));
}
/** Observe the status itself, not a fetched row or an offscreen ancestor. */
export function observeSentStatus(element: HTMLElement, visible: () => void): () => void {
  let intersecting = false;
  let stopped = false;
  const check = () => {
    if (stopped || !intersecting || !element.isConnected || document.visibilityState !== 'visible') return;
    const box = element.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return;
    // A dialog, drawer or composer covering the badge is not an observed status.
    const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    if (top && element.contains(top)) visible();
  };
  const observer = new IntersectionObserver(entries => {
    intersecting = entries.some(entry => entry.target === element && entry.isIntersecting && entry.intersectionRatio >= 1);
    check();
  }, { threshold: 1 });
  observer.observe(element);
  document.addEventListener('visibilitychange', check);
  window.addEventListener('focus', check);
  // Retry failed acknowledgements and notice overlays closing without an intersection change.
  const timer = window.setInterval(check, 5000);
  return () => {
    stopped = true; observer.disconnect(); window.clearInterval(timer);
    document.removeEventListener('visibilitychange', check); window.removeEventListener('focus', check);
  };
}
