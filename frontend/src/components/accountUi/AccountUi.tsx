import { useEffect, useLayoutEffect, useRef } from 'react';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, Button } from '../ui.tsx';
import { useMobile } from '../../hooks/useMobile.ts';
import { useUiScale } from '../../hooks/useUiScale.ts';
import { providerLabel } from './model.ts';
import './accountUi.css';

const paths: Record<string, ReactNode> = {
  chevron: <path d="m9 5 7 7-7 7"/>, down: <path d="m5 9 7 7 7-7"/>, back: <path d="m14 5-7 7 7 7"/>,
  close: <path d="m6 6 12 12M6 18 18 6"/>, plus: <path d="M12 5v14M5 12h14"/>,
  search: <><circle cx="10.5" cy="10.5" r="7"/><path d="m16 16 5 5"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="m10 3-.6 2.5-2 .9L5 5.7 3 9l1.8 1.8v2.4L3 15l2 3.3 2.4-.7 2 .9L10 21h4l.6-2.5 2-.9 2.4.7 2-3.3-1.8-1.8v-2.4L21 9l-2-3.3-2.4.7-2-.9L14 3z"/></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4m8-4v4M3 11h18"/></>,
  books: <><path d="M5 4h15v17H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm-2 13h17M8 4v8l3-2 3 2V4"/></>,
  lock: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>,
  more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
  cloud: <path d="M6 18a5 5 0 0 1-.7-10 7 7 0 0 1 13.4 1A4.5 4.5 0 0 1 19 18Z"/>,
  sync: <><path d="M20 8a8 8 0 0 0-14-3L3 8m0-5v5h5M4 16a8 8 0 0 0 14 3l3-3m0 5v-5h-5"/></>,
  link: <><path d="m10 14 4-4m-7 7-1 1a4 4 0 0 1-5-6l4-4a4 4 0 0 1 6 0m2 8a4 4 0 0 0 6 0l4-4a4 4 0 0 0-6-5l-1 1"/></>,
  trash: <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/></>,
  check: <path d="m5 12 4 4L19 6"/>, info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/></>,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/></>,
};
export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.info}</svg>;
}
export function ProviderMark({ kind }: { kind: string }) {
  if (kind === 'microsoft') return <svg width="18" height="18" viewBox="0 0 21 21" aria-hidden="true"><path fill="#f25022" d="M1 1h9v9H1z"/><path fill="#7fba00" d="M11 1h9v9h-9z"/><path fill="#00a4ef" d="M1 11h9v9H1z"/><path fill="#ffb900" d="M11 11h9v9h-9z"/></svg>;
  if (kind === 'google') return <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285f4" d="M22.6 12.2c0-.7-.1-1.5-.2-2.2H12v4.2h6a5.1 5.1 0 0 1-2.2 3.4v2.8h3.6c2.1-2 3.2-4.8 3.2-8.2Z"/><path fill="#34a853" d="M12 23c3 0 5.5-1 7.4-2.6l-3.6-2.8a6.5 6.5 0 0 1-9.5-3.4H2.6V17A11.2 11.2 0 0 0 12 23Z"/><path fill="#fbbc05" d="M6.3 14.2a6.7 6.7 0 0 1 0-4.4V7H2.6a11.2 11.2 0 0 0 0 10Z"/><path fill="#ea4335" d="M12 5.2c1.6 0 3 .6 4.1 1.6l3.1-3.1A10.5 10.5 0 0 0 12 1a11.2 11.2 0 0 0-9.4 6l3.7 2.8A6.3 6.3 0 0 1 12 5.2Z"/></svg>;
  return <Icon name={kind === 'local' ? 'mail' : kind === 'system' ? 'calendar' : 'cloud'} size={18}/>;
}
export function Check({ mixed = false, className = '', ...props }: InputHTMLAttributes<HTMLInputElement> & { mixed?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = mixed; }, [mixed]);
  return <input {...props} ref={ref} type="checkbox" aria-checked={mixed ? 'mixed' : Boolean(props.checked)} className={`au-check ${className}`}/>;
}
export function Switch({ checked, label, onChange, disabled = false }: { checked: boolean; label: string; onChange: (checked: boolean) => void; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className="au-switch" disabled={disabled} onClick={() => onChange(!checked)}><span/></button>;
}
export function IconButton({ label, icon, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; icon: string }) {
  return <button {...props} type="button" className={`au-icon-button ${props.className ?? ''}`} title={label} aria-label={label}><Icon name={icon}/></button>;
}
export function Header({ title, description, children }: { title: ReactNode; description?: ReactNode; children?: ReactNode }) {
  return <header className="au-page-head"><div><h2>{title}</h2>{description && <p>{description}</p>}</div>{children}</header>;
}
export function Back({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return <button type="button" className="au-back" onClick={onClick}><Icon name="back" size={14}/>{children}</button>;
}
export function Card({ name, identity, kind, color, status, metadata, onManage }: {
  name: string; identity?: string | null; kind: string; color?: string | null; status: ReactNode; metadata?: ReactNode; onManage: () => void;
}) {
  const { t } = useTranslation();
  return <article className="au-account-card"><div className="au-account-main"><div className="au-account-avatar" style={{ background: color || 'var(--accent)', color: 'var(--accent-text, #fff)' }}>{kind === 'google' || kind === 'microsoft' ? name.slice(0, 1).toLocaleUpperCase() : <ProviderMark kind={kind}/>}</div><div className="au-grow"><div className="au-account-name">{name}<span> · {providerLabel(kind, t)}</span></div>{identity && <div className="au-account-identity" title={identity}>{identity}</div>}<div className="au-account-status">{status}</div></div><Button onClick={onManage}><Icon name="chevron" size={12}/>{t('accountUi.manage')}</Button></div><div className="au-account-footer">{metadata}</div></article>;
}
export function Notice({ children, danger = false }: { children: ReactNode; danger?: boolean }) {
  return <div className={`au-notice${danger ? ' au-error' : ''}`} role={danger ? 'alert' : 'status'}><Icon name="info"/><div>{children}</div></div>;
}
export function Status({ state }: { state: 'unknown' | 'off' | 'authorization' | 'failed' | 'pending' | 'ready' }) {
  const { t } = useTranslation();
  const labels = { unknown: t('accountUi.statusUnknown'), off: t('accountUi.statusOff'), authorization: t('accountUi.statusAuthorization'), failed: t('accountUi.statusFailed'), pending: t('accountUi.statusPending'), ready: t('accountUi.statusReady') };
  return <span className={`au-status au-status-${state}`}><i/>{labels[state]}</span>;
}
/** Anchored on desktop; the app's Dialog owns stacking, Escape and focus on both layouts. */
export function Popover({ title, anchor, onClose, children, footer, className = '', busy = false }: {
  title: string; anchor: HTMLElement | null; onClose: () => void; children: ReactNode; footer?: ReactNode; className?: string; busy?: boolean;
}) {
  const mobile = useMobile(); const { t } = useTranslation(); const scale = useUiScale();
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const panel = content.current?.closest<HTMLElement>('.ui-dialog');
    if (!panel) return;
    if (mobile) {
      for (const property of ['left','top','max-height','visibility']) panel.style.removeProperty(property);
      return;
    }
    const place = () => {
      const trigger = anchor?.getBoundingClientRect(); const rect = panel.getBoundingClientRect();
      const x = Math.max(8, Math.min(trigger?.left ?? 12, window.innerWidth - rect.width - 8));
      const below = (trigger?.bottom ?? 0) + 6;
      const y = below + rect.height < window.innerHeight - 8 ? below : Math.max(8, (trigger?.top ?? 12) - rect.height - 6);
      Object.assign(panel.style, { left: `${x / scale}px`, top: `${y / scale}px`, maxHeight: `${(window.innerHeight - 16) / scale}px`, visibility: 'visible' });
    };
    place(); const observer = new ResizeObserver(place); observer.observe(panel);
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [anchor, mobile, scale]);
  return <Dialog title={title} closeLabel={t('common.close')} onClose={onClose} busy={busy} className={`${mobile ? 'ui-sheet au-sheet' : 'au-popover-dialog'} ${className}`} footer={footer}><div ref={content}>{children}</div></Dialog>;
}
