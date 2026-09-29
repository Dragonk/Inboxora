import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';
import { senderColor } from '../themes.ts';
import SenderAvatarImage from './SenderAvatarImage.tsx';

/** Geometry from the native inbox shell, shared with other mail collections. */
export function mailListPanelStyle(direction: 'row' | 'column', fullWidth = false): CSSProperties {
  return { flex: fullWidth ? 1 : direction === 'row' ? '0 0 var(--list-width)' : '1 1 50%',
    width: fullWidth || direction === 'column' ? '100%' : 'var(--list-width)',
    minWidth: 0, overflow: 'hidden', height: '100%' };
}
export const mailReaderPanelStyle: CSSProperties = { flex: 1, minWidth: 0, overflow: 'hidden', height: '100%', flexDirection: 'column' };
export function mailListSurfaceStyle(mobile: boolean, column: boolean): CSSProperties {
  return { width: '100%', minWidth: 0, flex: 1,
    borderRight: mobile || column ? 'none' : '1px solid var(--border-subtle)',
    borderBottom: !mobile && column ? '1px solid var(--border-subtle)' : 'none',
    display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg-primary)' };
}
export function MailListHeader({ children, scrolled = false }: { children: ReactNode; scrolled?: boolean }) {
  return <div style={{ padding: '14px 16px 10px', borderBottom: '1px solid var(--border-subtle)',
    boxShadow: scrolled ? '0 1px 10px rgba(0,0,0,0.2)' : 'none', transition: 'box-shadow 0.2s ease' }}>{children}</div>;
}
export function MailListTitle({ children }: { children: ReactNode }) {
  return <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', flex: 1, minWidth: 0,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center' }}>{children}</h2>;
}
export function MailRowHeading({ sender, children }: { sender: ReactNode; children: ReactNode }) {
  return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 3 }}>
    {sender}{children}
  </div>;
}
export function MailRowSubject({ unread = false, thread = false, children }: { unread?: boolean; thread?: boolean; children: ReactNode }) {
  return <div data-thread-row-subject={thread ? 'true' : undefined} style={{ fontSize: 13, fontWeight: unread ? 500 : 400,
    color: unread ? 'var(--text-primary)' : 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis',
    whiteSpace: 'nowrap', marginBottom: thread ? 2 : 3 }}>{children}</div>;
}
export function MailRowSender({ unread = false, children, style }: { unread?: boolean; children: ReactNode; style?: CSSProperties }) {
  return <span style={{ fontSize: 13, fontWeight: unread ? 600 : 400, color: unread ? 'var(--text-primary)' : 'var(--text-secondary)',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, ...style }}>{children}</span>;
}
export function MailRowDate({ children }: { children: ReactNode }) {
  return <span style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 10.5, color: 'var(--text-tertiary)' }}>{children}</span>;
}
export function MailRowAvatar({ email, name, checked = false, checkbox = false, interactive = false, hasContactPhoto, children, ...props }: {
  email?: string | null; name?: string | null; checked?: boolean; checkbox?: boolean; interactive?: boolean;
  hasContactPhoto?: boolean | null; children?: ReactNode;
} & HTMLAttributes<HTMLDivElement>) {
  const color = senderColor(email || name);
  return <div {...props} style={{ width: checkbox ? 30 : 36, height: checkbox ? 30 : 36, borderRadius: '50%', flexShrink: 0,
    position: 'relative', overflow: 'hidden', background: checkbox ? (checked ? 'var(--accent)' : 'var(--bg-tertiary)') : `${color}22`,
    border: checkbox && !checked ? '2px solid var(--border)' : `1.5px solid ${color}55`,
    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: checkbox ? 13 : 14, fontWeight: 600,
    color: checkbox ? (checked ? 'white' : 'var(--text-tertiary)') : color, marginTop: 1,
    cursor: interactive ? 'pointer' : 'default', transition: 'background 0.12s, border 0.12s', userSelect: 'none', boxSizing: 'border-box' }}>
    {children ?? <>{(name || email || '?')[0].toUpperCase()}<SenderAvatarImage email={email} hasContactPhoto={hasContactPhoto} /></>}
  </div>;
}
export function mailRowStyle(background: string, thread = false): CSSProperties {
  return { padding: thread ? '11px 14px' : 'var(--layout-row-py, 11px) var(--layout-row-px, 14px)', cursor: 'pointer', background,
    transition: 'background 0.1s', position: 'relative' };
}
export function MailRowSelection({ color }: { color?: string | null }) {
  return <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: color || 'var(--accent)', borderRadius: '0 2px 2px 0' }} />;
}
