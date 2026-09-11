// Shared side-panel width for every module that shows a list beside its content:
// the mail message list, the contact list, the calendar rail and the calendar
// day agenda. Keeping one persisted width (the `--list-width` CSS variable) means
// dragging any of these handles resizes all of them, so the workspace keeps a
// single, predictable column width across Mail, Contacts and Calendar.

export const PANEL_WIDTH_MIN = 180;
export const PANEL_WIDTH_MAX = 700;
export const PANEL_WIDTH_DEFAULT = 360;
// Pre-existing key: saved widths from earlier releases stay valid.
export const PANEL_WIDTH_STORAGE_KEY = 'mailflow_list_width';

export function clampPanelWidth(value) {
  const width = Number(value);
  if (!Number.isFinite(width) || width <= 0) return null;
  return Math.round(Math.min(PANEL_WIDTH_MAX, Math.max(PANEL_WIDTH_MIN, width)));
}

// The saved override, or undefined when the user never dragged a handle.
export function savedPanelWidth() {
  try {
    return clampPanelWidth(localStorage.getItem(PANEL_WIDTH_STORAGE_KEY)) ?? undefined;
  } catch {
    return undefined;
  }
}

// The width currently in effect, resolved from the live CSS variable first so a
// drag that has not been persisted yet is still honoured. The variable is only
// ever written inline on <html>, so the inline value is authoritative and the
// computed style is just a fallback for a stylesheet-provided default.
export function readPanelWidth() {
  let applied = null;
  if (typeof document !== 'undefined') {
    applied = clampPanelWidth(parseFloat(document.documentElement.style.getPropertyValue('--list-width')));
    if (applied == null && typeof getComputedStyle === 'function') {
      applied = clampPanelWidth(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--list-width')));
    }
  }
  return applied ?? savedPanelWidth() ?? PANEL_WIDTH_DEFAULT;
}

export function applyPanelWidth(width) {
  const clamped = clampPanelWidth(width);
  if (clamped == null) return readPanelWidth();
  document.documentElement.style.setProperty('--list-width', `${clamped}px`);
  return clamped;
}

export function persistPanelWidth(width) {
  const clamped = clampPanelWidth(width);
  if (clamped == null) return readPanelWidth();
  try {
    localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, String(clamped));
  } catch { /* a blocked storage must not break resizing */ }
  return clamped;
}

// Drag helper shared by every panel handle. `edge` names the side of the panel
// the handle sits on, so a handle on the right of a left-hand panel widens it
// while a handle on the left of a right-hand panel widens it in the opposite
// direction. Returns a cleanup function suitable for an effect teardown.
export function beginPanelResize(event, { edge = 'right', onResize, onEnd } = {}) {
  event?.preventDefault?.();
  const startX = event?.clientX ?? 0;
  const startWidth = readPanelWidth();
  const direction = edge === 'left' ? -1 : 1;
  const previousCursor = document.body.style.cursor;
  const previousUserSelect = document.body.style.userSelect;
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';

  const onMouseMove = move => {
    const width = applyPanelWidth(startWidth + direction * (move.clientX - startX));
    onResize?.(width);
  };

  const onMouseUp = () => {
    document.body.style.cursor = previousCursor;
    document.body.style.userSelect = previousUserSelect;
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    onEnd?.(persistPanelWidth(readPanelWidth()));
  };

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);

  return () => {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    document.body.style.cursor = previousCursor;
    document.body.style.userSelect = previousUserSelect;
  };
}
