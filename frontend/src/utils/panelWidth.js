// Side-panel widths for the workspace.
//
// Mail, Contacts and the calendar rail all show a list beside their content, so
// they share ONE persisted width (`--list-width`): dragging any of those handles
// resizes all of them and the workspace keeps a single, predictable column.
//
// The calendar day agenda is deliberately NOT part of that group. It is a
// supplementary right-hand column, not a list of records, so it keeps its own
// independently persisted width (`--agenda-width`): widening the agenda must not
// narrow the mail list, and widening the mail list must not stretch the agenda.

export const PANEL_WIDTH_MIN = 180;
export const PANEL_WIDTH_MAX = 700;
export const PANEL_WIDTH_DEFAULT = 360;
// Pre-existing key: saved widths from earlier releases stay valid.
export const PANEL_WIDTH_STORAGE_KEY = 'mailflow_list_width';

export const AGENDA_WIDTH_DEFAULT = 296;
export const AGENDA_WIDTH_MIN = 200;
export const AGENDA_WIDTH_MAX = 560;
export const AGENDA_WIDTH_STORAGE_KEY = 'mailflow_agenda_width';

export function clampPanelWidth(value, { min = PANEL_WIDTH_MIN, max = PANEL_WIDTH_MAX } = {}) {
  const width = Number(value);
  if (!Number.isFinite(width) || width <= 0) return null;
  return Math.round(Math.min(max, Math.max(min, width)));
}

// One independently persisted, CSS-variable-backed width.
function createWidthChannel({ variable, storageKey, fallback, min = PANEL_WIDTH_MIN, max = PANEL_WIDTH_MAX }) {
  const clamp = value => clampPanelWidth(value, { min, max });

  const readVariable = () => {
    if (typeof document === 'undefined') return null;
    // The variable is only ever written inline on <html>, so the inline value is
    // authoritative; the computed style is a fallback for a stylesheet default.
    const inline = clamp(parseFloat(document.documentElement.style.getPropertyValue(variable)));
    if (inline != null) return inline;
    if (typeof getComputedStyle !== 'function') return null;
    return clamp(parseFloat(getComputedStyle(document.documentElement).getPropertyValue(variable)));
  };

  const saved = () => {
    try {
      return clamp(localStorage.getItem(storageKey)) ?? undefined;
    } catch {
      return undefined;
    }
  };

  const read = () => readVariable() ?? saved() ?? fallback;

  const apply = value => {
    const clamped = clamp(value);
    if (clamped == null) return read();
    if (typeof document !== 'undefined') document.documentElement.style.setProperty(variable, `${clamped}px`);
    return clamped;
  };

  const persist = value => {
    const clamped = clamp(value);
    if (clamped == null) return read();
    try {
      localStorage.setItem(storageKey, String(clamped));
    } catch { /* a blocked storage must not break resizing */ }
    return clamped;
  };

  // Drag helper for this channel's handle. `edge` names the side of the panel the
  // handle sits on, so a handle on the right of a left-hand panel widens it while
  // a handle on the left of a right-hand panel widens it in the opposite
  // direction. Returns a cleanup function suitable for an effect teardown.
  const beginResize = (event, { edge = 'right', onResize, onEnd } = {}) => {
    event?.preventDefault?.();
    const startX = event?.clientX ?? 0;
    const startWidth = read();
    const direction = edge === 'left' ? -1 : 1;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = move => {
      // Apply first, then notify. Writing the width must never depend on an
      // observer being registered — `onResize?.(apply(...))` would short-circuit
      // the whole argument list and silently drop every drag.
      const width = apply(startWidth + direction * (move.clientX - startX));
      onResize?.(width);
    };

    const onMouseUp = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      // Persist BEFORE notifying. `onEnd?.(persist(...))` would short-circuit the
      // whole argument list when no listener is registered — which is the case for
      // every caller — so the width was applied but never written to storage, and
      // every reload snapped back to the default.
      const width = persist(read());
      onEnd?.(width);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
  };

  return { variable, storageKey, fallback, clamp, read, apply, persist, saved, beginResize };
}

// Shared width for the mail list, the contact list and the calendar rail.
export const listPanelWidth = createWidthChannel({
  variable: '--list-width',
  storageKey: PANEL_WIDTH_STORAGE_KEY,
  fallback: PANEL_WIDTH_DEFAULT,
});

// Dedicated width for the calendar day agenda.
export const agendaPanelWidth = createWidthChannel({
  variable: '--agenda-width',
  storageKey: AGENDA_WIDTH_STORAGE_KEY,
  fallback: AGENDA_WIDTH_DEFAULT,
  min: AGENDA_WIDTH_MIN,
  max: AGENDA_WIDTH_MAX,
});

// ── List-panel width (the historical API: one shared list column) ────────────

export const savedPanelWidth = () => listPanelWidth.saved();
export const readPanelWidth = () => listPanelWidth.read();
export const applyPanelWidth = width => listPanelWidth.apply(width);
export const persistPanelWidth = width => listPanelWidth.persist(width);
export const beginPanelResize = (event, options) => listPanelWidth.beginResize(event, options);

// ── Day-agenda width (independent of the shared list column) ─────────────────

export const savedAgendaWidth = () => agendaPanelWidth.saved();
export const readAgendaWidth = () => agendaPanelWidth.read();
export const applyAgendaWidth = width => agendaPanelWidth.apply(width);
export const persistAgendaWidth = width => agendaPanelWidth.persist(width);
export const beginAgendaResize = (event, options) => agendaPanelWidth.beginResize(event, options);
