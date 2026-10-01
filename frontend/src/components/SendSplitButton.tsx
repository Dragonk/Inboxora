import { useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

/** Keep the two menu actions reachable from the composer footer and mobile header. */
export default function SendSplitButton({ onSend, onSchedule, onMerge, sendLabel, scheduleLabel, mergeLabel,
  menuLabel, disabled, menuDisabled, children, mobile = false, title }: {
  onSend: () => void; onSchedule: () => void; onMerge: () => void;
  sendLabel: string; scheduleLabel: string; mergeLabel: string; menuLabel: string;
  disabled: boolean; menuDisabled: boolean; children?: ReactNode; mobile?: boolean; title?: string;
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const firstItem = useRef<HTMLButtonElement>(null);
  const secondItem = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    /** Close the popup when a pointer action leaves the split button. */
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) { setOpen(false); trigger.current?.focus(); }
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);
  useEffect(() => { if (menuDisabled) setOpen(false); }, [menuDisabled]);
  /** Focus the appropriate edge item when opening with an arrow key or pointer. */
  const openMenu = (last = false) => {
    if (menuDisabled) return;
    setOpen(true);
    requestAnimationFrame(() => (last ? secondItem : firstItem).current?.focus());
  };
  /** Restore a stable focus anchor before opening the next action's dialog. */
  const select = (action: () => void) => { setOpen(false); trigger.current?.focus(); action(); };
  const buttonStyle: CSSProperties = mobile
    ? { background: 'none', border: 'none', color: 'var(--accent)', padding: '4px 2px', fontSize: 16, fontWeight: 600 }
    : { padding: '8px 14px', background: 'var(--accent)', border: 'none', color: 'var(--accent-text)', fontSize: 13, fontWeight: 500 };
  return <div ref={root} style={{ position: 'relative', display: 'inline-flex', alignItems: 'stretch', flexShrink: 0 }}
    onKeyDown={event => {
      if (event.key === 'Escape' && open) { event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
    }}>
    <button type="button" data-testid="compose-send" onClick={() => { setOpen(false); onSend(); }} disabled={disabled} title={title}
      style={{ ...buttonStyle, borderRadius: mobile ? 0 : '7px 0 0 7px', opacity: disabled ? 0.6 : 1,
        cursor: disabled ? 'default' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>{children}{sendLabel}</button>
    <button ref={trigger} type="button" data-testid="compose-send-menu" aria-label={menuLabel}
      aria-haspopup="menu" aria-controls={menuId} aria-expanded={open} disabled={menuDisabled}
      onClick={() => open ? (setOpen(false), trigger.current?.focus()) : openMenu()}
      onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); openMenu(); }
        if (event.key === 'ArrowUp') { event.preventDefault(); openMenu(true); } }}
      style={{ ...buttonStyle, padding: mobile ? '4px 5px' : '8px 9px', borderInlineStart: mobile ? '1px solid var(--border)' : '1px solid color-mix(in srgb, var(--accent-text) 35%, transparent)',
        borderRadius: mobile ? 0 : '0 7px 7px 0', opacity: menuDisabled ? 0.6 : 1, cursor: menuDisabled ? 'default' : 'pointer' }}>
      <svg aria-hidden="true" width="13" height="13" viewBox="0 0 16 16" fill="none"><path d={mobile ? "m3 6 5 5 5-5" : "m3 10 5-5 5 5"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>
    {open && <div id={menuId} role="menu" aria-label={menuLabel} style={{ position: mobile ? 'fixed' : 'absolute',
      ...(mobile ? { top: 'calc(56px + env(safe-area-inset-top, 0px))', right: 'max(12px, env(safe-area-inset-right, 0px))' } : { bottom: 'calc(100% + 8px)', left: 0 }), zIndex: 13000,
      minWidth: 210, width: 'max-content', maxWidth: 'calc(100vw - 24px)', boxSizing: 'border-box', padding: 5, background: 'var(--bg-elevated)',
      border: '1px solid var(--border)', borderRadius: 8, boxShadow: 'var(--shadow-modal)' }}
      onKeyDown={event => {
        const items = [firstItem.current, secondItem.current];
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
        } else if (event.key === 'Home') { event.preventDefault(); firstItem.current?.focus(); }
        else if (event.key === 'End') { event.preventDefault(); secondItem.current?.focus(); }
        else if (event.key === 'Tab') setOpen(false);
      }}>
      <button ref={firstItem} type="button" role="menuitem" data-testid="compose-schedule" onClick={() => select(onSchedule)} style={itemStyle}>{scheduleLabel}</button>
      <button ref={secondItem} type="button" role="menuitem" data-testid="compose-mail-merge" onClick={() => select(onMerge)} style={itemStyle}>{mergeLabel}</button>
    </div>}
  </div>;
}

const itemStyle: CSSProperties = { display: 'block', width: '100%', boxSizing: 'border-box', padding: '9px 11px', textAlign: 'start', whiteSpace: 'normal', overflowWrap: 'anywhere',
  background: 'transparent', border: 0, borderRadius: 5, color: 'var(--text-primary)', cursor: 'pointer', fontSize: 13 };
