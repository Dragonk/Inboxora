import { useBackLayer } from '../hooks/useBackNavigation.js';
import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useUiScale } from '../hooks/useUiScale.js';

export const inputStyle = {
  width: '100%', minWidth: 0, boxSizing: 'border-box', padding: '7px 10px',
  border: '1px solid var(--border-subtle)', borderRadius: 6,
  background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 13,
};
export const buttonStyle = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7,
  padding: '7px 12px', borderRadius: 6, border: '1px solid var(--border)',
  background: 'var(--bg-elevated)', color: 'var(--text-primary)',
  fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
};

export function Button({ variant = 'default', className = '', children, ...props }) {
  return <button type="button" className={`ui-button ui-button-${variant} ${className}`} {...props}>{children}</button>;
}

// The one drag handle used by every resizable side panel (mail list, contact
// list, calendar rail, calendar day agenda). Keeping a single implementation is
// what makes the panels resize identically and share one persisted width.
export function PanelResizeHandle({ onMouseDown, testId, width = 1, zIndex = 10 }) {
  return (
    <div
      className="ui-resize-handle"
      data-testid={testId}
      role="separator"
      aria-orientation="vertical"
      onMouseDown={onMouseDown}
      style={{
        width, flexShrink: 0, cursor: 'col-resize',
        background: 'var(--border-subtle)',
        transition: 'background 0.15s',
        zIndex,
      }}
      onMouseEnter={e => { e.currentTarget.style.background = 'var(--accent)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'var(--border-subtle)'; }}
    />
  );
}

export function EmptyState({ title, children }) {
  return <div className="ui-empty"><strong>{title}</strong>{children && <span>{children}</span>}</div>;
}

// Portals keep dialogs outside transformed/scaled panes. Only the top dialog
// handles Escape/Back; focus returns to its trigger when it is dismissed.
const dialogs = [];
// A downward drag this far (or a shorter but clearly flicked one) dismisses a
// sheet. Kept in one place so the gesture feels the same in every sheet.
const SHEET_DISMISS_DISTANCE = 110;
const SHEET_FLICK_DISTANCE = 40;
const SHEET_FLICK_VELOCITY = 0.5;
const SHEET_EXIT_MS = 160;

export function Dialog({ title, closeLabel, onClose, children, footer, testId, className = '', busy = false }) {
  const titleId = useId();
  const scale = useUiScale();
  const panel = useRef(null);
  const trigger = useRef(document.activeElement);
  const close = useRef(onClose);
  const busyRef = useRef(busy);
  const drag = useRef(null);
  const exitTimer = useRef(null);
  close.current = onClose;
  busyRef.current = busy;
  const isSheet = className.split(/\s+/).includes('ui-sheet');
  useBackLayer(true, () => { if (!busyRef.current) close.current(); }, 4500);
  useEffect(() => {
    const element = panel.current;
    const previous = trigger.current;
    dialogs.push(element);
    const focusable = () => [...element.querySelectorAll('button, input, select, textarea, a[href], [tabindex="0"]')].filter(node => !node.disabled && node.getClientRects().length);
    if (!element.contains(document.activeElement)) (element.querySelector('[autofocus]') || focusable()[0] || element).focus();
    const keydown = event => {
      if (dialogs.at(-1) !== element) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); if (!busyRef.current) close.current(); }
      if (event.key === 'Tab') {
        const nodes = focusable();
        const first = nodes[0]; const last = nodes.at(-1);
        if (!first) { event.preventDefault(); element.focus(); }
        else if (event.shiftKey && (document.activeElement === first || document.activeElement === element)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', keydown, true);
    return () => {
      dialogs.splice(dialogs.indexOf(element), 1);
      document.removeEventListener('keydown', keydown, true);
      clearTimeout(exitTimer.current);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  // ── Sheet dismiss gesture ───────────────────────────────────────────────────
  // A sheet looks like it can be pushed back down the screen, so it must behave
  // that way: dragging the header (or its grabber) follows the pointer and
  // releasing past the threshold closes it. Pointer events cover touch, pen and
  // mouse with one code path; `touch-action: none` on the drag zone stops the
  // browser from scrolling instead of handing us the gesture.
  //
  // The move/up listeners live on `document` rather than on the header: a drag
  // routinely leaves the short header, and document-level listeners keep the
  // gesture alive there without depending on pointer capture being honoured.
  const stopSheetDrag = useRef(null);
  useEffect(() => () => {
    stopSheetDrag.current?.();
    clearTimeout(exitTimer.current);
  }, []);

  const finishSheetDrag = ({ dismiss }) => {
    stopSheetDrag.current?.();
    stopSheetDrag.current = null;
    const active = drag.current;
    drag.current = null;
    if (!active) return;
    const element = panel.current;
    const elapsed = Math.max(1, Date.now() - active.startedAt);
    const velocity = active.dy / elapsed;
    const shouldClose = !busyRef.current && dismiss !== false && (active.dy > SHEET_DISMISS_DISTANCE
      || (active.dy > SHEET_FLICK_DISTANCE && velocity > SHEET_FLICK_VELOCITY));
    if (!element) { if (shouldClose) close.current(); return; }
    if (!shouldClose) {
      // Snap back, then hand the element back to its normal (unanimated) state.
      // The entrance animation stays disabled: restoring it would replay the
      // slide-up (and its keyframes would override the inline transform mid-drag
      // if the user immediately grabbed the sheet again).
      element.style.transition = `transform var(--motion-fast) var(--ease-standard)`;
      element.style.transform = 'translateY(0)';
      exitTimer.current = setTimeout(() => {
        element.style.transition = '';
        element.style.transform = '';
      }, 200);
      return;
    }
    // Slide the sheet off the bottom before unmounting so the dismissal reads as
    // the reverse of the entrance animation.
    element.style.transition = `transform ${SHEET_EXIT_MS}ms var(--ease-standard)`;
    element.style.transform = 'translateY(100%)';
    exitTimer.current = setTimeout(() => close.current(), SHEET_EXIT_MS);
  };

  const sheetPointerDown = event => {
    if (!isSheet || busyRef.current) return;
    if (event.button > 0) return;
    // Controls inside the header (the × button) keep their own taps.
    if (event.target.closest?.('button, a, input, select, textarea, [role="button"]')) return;
    stopSheetDrag.current?.();
    // A brand-new gesture supersedes anything the previous one left pending: a
    // stale snap-back timer would otherwise rewrite the transform the user is
    // currently dragging.
    clearTimeout(exitTimer.current);
    exitTimer.current = null;
    drag.current = { pointerId: event.pointerId, startY: event.clientY, startedAt: Date.now(), dy: 0 };

    const onMove = move => {
      const active = drag.current;
      if (!active || active.pointerId !== move.pointerId) return;
      active.dy = Math.max(0, move.clientY - active.startY);
      const element = panel.current;
      if (!element) return;
      element.style.animation = 'none';
      element.style.transition = 'none';
      element.style.transform = `translateY(${active.dy}px)`;
    };
    const onUp = () => finishSheetDrag({ dismiss: true });
    const onCancel = () => finishSheetDrag({ dismiss: false });
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);
    stopSheetDrag.current = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onCancel);
    };
  };

  return createPortal(<div className="ui-overlay" style={{ zoom: scale }} onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid={testId} className={`ui-dialog ${className}`}>
      <header
        className="ui-dialog-header"
        data-testid={isSheet ? 'sheet-drag-header' : undefined}
        onPointerDown={isSheet ? sheetPointerDown : undefined}
      >
        {isSheet && <span className="ui-sheet-grabber" data-testid="sheet-grabber" aria-hidden="true" />}
        <h2 id={titleId}>{title}</h2><Button variant="ghost" aria-label={closeLabel || title} onClick={onClose} disabled={busy}>×</Button>
      </header>
      <div className="ui-dialog-body">{children}</div>
      {footer && <footer className="ui-dialog-footer">{footer}</footer>}
    </section>
  </div>, document.body);
}
