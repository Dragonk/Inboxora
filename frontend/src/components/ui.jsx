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

export function EmptyState({ title, children }) {
  return <div className="ui-empty"><strong>{title}</strong>{children && <span>{children}</span>}</div>;
}

// Portals keep dialogs outside transformed/scaled panes. Only the top dialog
// handles Escape/Back; focus returns to its trigger when it is dismissed.
const dialogs = [];
export function Dialog({ title, closeLabel, onClose, children, footer, testId, className = '', busy = false }) {
  const titleId = useId();
  const scale = useUiScale();
  const panel = useRef(null);
  const trigger = useRef(document.activeElement);
  const close = useRef(onClose);
  const busyRef = useRef(busy);
  close.current = onClose;
  busyRef.current = busy;
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
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return createPortal(<div className="ui-overlay" style={{ zoom: scale }} onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid={testId} className={`ui-dialog ${className}`}>
      <header className="ui-dialog-header"><h2 id={titleId}>{title}</h2><Button variant="ghost" aria-label={closeLabel || title} onClick={onClose} disabled={busy}>×</Button></header>
      <div className="ui-dialog-body">{children}</div>
      {footer && <footer className="ui-dialog-footer">{footer}</footer>}
    </section>
  </div>, document.body);
}
