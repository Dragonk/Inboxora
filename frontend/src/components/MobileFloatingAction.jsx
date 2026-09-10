import { useMobile } from '../hooks/useMobile.js';
import { useStore } from '../store/index.js';

export default function MobileFloatingAction({ label, onClick, icon = 'add', disabled = false, visible = true, inline = false }) {
  const mobile = useMobile();
  const position = useStore(state => state.mobileNavigationPosition);
  if (!mobile || position === 'bottom') return null;
  return <button type="button" data-testid="mobile-floating-action" aria-label={label} title={label} onClick={onClick} disabled={disabled} style={{
    ...(inline ? {} : { position: 'fixed', bottom: 'calc(var(--sab) + 20px)', right: 20, zIndex: 200 }),
    width: 44, height: 44, minHeight: 44, borderRadius: '50%', background: 'var(--accent)', border: 'none', color: 'var(--accent-text)',
    boxShadow: 'var(--shadow-popover)', cursor: disabled ? 'default' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
    pointerEvents: visible ? 'auto' : 'none', opacity: visible ? (disabled ? .5 : 1) : 0, transform: visible ? 'scale(1)' : 'scale(.8)', transition: 'opacity .2s ease, transform .2s ease',
  }}>
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
      {icon === 'compose' ? <><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z"/></> : <path d="M12 5v14M5 12h14"/>}
    </svg>
  </button>;
}
