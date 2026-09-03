import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export default function CalendarContextMenu({ x, y, event, isMobile = false, onEdit, onDelete, onClose, triggerRef, t }) {
  const menuRef = useRef(null);
  const [position, setPosition] = useState({ x, y });
  const writable = event.source === 'local' && !event.read_only;

  useLayoutEffect(() => {
    if (isMobile || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    setPosition({
      x: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)),
    });
  }, [x, y, isMobile]);

  useEffect(() => {
    const handleKeyDown = keyboardEvent => {
      if (keyboardEvent.key !== 'Escape') return;
      keyboardEvent.preventDefault();
      onClose();
      triggerRef?.current?.focus();
    };
    document.addEventListener('keydown', handleKeyDown);
    menuRef.current?.querySelector('button')?.focus();
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose, triggerRef]);

  const run = action => {
    action();
    onClose();
  };
  return <>
    <button type="button" aria-label={t('calendar.closeMenu', 'Close calendar menu')} onClick={() => { onClose(); triggerRef?.current?.focus(); }} style={scrim} />
    <div ref={menuRef} role="menu" aria-label={t('calendar.eventActions', 'Event actions')} data-testid="calendar-context-menu" style={{ ...menu, ...(isMobile ? mobileMenu : { left: position.x, top: position.y }) }}>
      <strong style={menuTitle}>{event.summary || t('calendar.untitled')}</strong>
      {writable && <>
        <button type="button" role="menuitem" onClick={() => run(onEdit)}>{t('calendar.edit')}</button>
        <button type="button" role="menuitem" data-testid="calendar-context-delete" onClick={() => run(onDelete)}>{t('calendar.delete')}</button>
      </>}
      {!writable && <span data-testid="calendar-context-read-only" style={readOnly}>{t('calendar.readOnly')}</span>}
    </div>
  </>;
}

const scrim = { position: 'fixed', inset: 0, zIndex: 3999, border: 0, background: 'transparent', padding: 0, cursor: 'default' };
const menu = { position: 'fixed', zIndex: 4000, display: 'grid', gap: 2, width: 220, maxWidth: 'calc(100vw - 16px)', padding: 6, boxSizing: 'border-box', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10, boxShadow: 'var(--shadow-modal)' };
const mobileMenu = { position: 'fixed', left: 12, right: 12, bottom: 'calc(var(--mobile-nav-height) + var(--sab) + 12px)', width: 'auto' };
const menuTitle = { padding: '7px 9px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-primary)', fontSize: 13 };
const readOnly = { padding: '7px 9px', color: 'var(--text-tertiary)', fontSize: 12 };
