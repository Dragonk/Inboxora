/**
 * Cross-component arbitration between the mobile drawer gesture and the
 * per-row swipe gesture (`useSwipeRow`).
 *
 * Both handlers observe the same touch sequence: the drawer coordinator listens
 * in the capture phase on the content surface, while a row listens on itself.
 * Whoever claims the sequence first must keep it. The row therefore consults
 * this flag on every move and end; the drawer sets it as soon as it owns the
 * gesture and leaves it set until the next sequence begins, so the row's own
 * `touchend` cannot fire an action after the drawer took over.
 *
 * Only one drawer coordinator exists at a time, so a module-level flag — rather
 * than React context — keeps the hot path allocation-free.
 */

let rowSuppressed = false;

/** True while another mechanism owns the current pointer sequence. */
export function isRowGestureSuppressed(): boolean {
  return rowSuppressed;
}

/** Called by the drawer coordinator when it claims or releases the sequence. */
export function setRowGestureSuppressed(value: boolean): void {
  rowSuppressed = value;
}

/** Defensive reset for teardown paths (unmount, logout, layout change). */
export function resetGestureArbitration(): void {
  rowSuppressed = false;
}
