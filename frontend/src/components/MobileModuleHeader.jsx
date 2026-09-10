import { createContext, useContext } from 'react';
import { createPortal } from 'react-dom';

export const MobileHeaderHost = createContext(null);

// The active module owns its actions, including disabled/loading state. Rendering
// them in the shell avoids duplicate headers and imperative cross-module events.
export function MobileModuleHeader({ title, subtitle, children }) {
  const host = useContext(MobileHeaderHost);
  if (!host) return null;
  return createPortal(<>
    <div className="mobile-module-title"><h1 title={title}>{title}</h1>{subtitle && <small title={subtitle}>{subtitle}</small>}</div>
    {children}
  </>, host);
}

export function HeaderAction({ icon, label, ...props }) {
  const paths = {
    unread: <><rect x="3" y="6" width="18" height="14" rx="2"/><path d="m3 7 9 7 9-7"/><circle cx="19" cy="5" r="3" fill="currentColor" stroke="var(--bg-secondary)"/></>,
    sync: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.6 7a8 8 0 0 1 13.2-1L20 8M4 16l1.2 2A8 8 0 0 0 18.4 17"/></>,
    select: <><rect x="3" y="3" width="18" height="18" rx="2"/><path d="m8 12 3 3 6-7"/></>,
    close: <path d="m6 6 12 12M6 18 18 6"/>,
    compose: <><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z"/></>,
    add: <path d="M12 5v14M5 12h14" />,
    books: <><path d="M4 4h14a2 2 0 0 1 2 2v14H6a2 2 0 0 1-2-2V4Z"/><path d="M4 16h16M8 4v12M12 8h4M12 11h4"/></>,
    calendars: <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18M7 15h3M14 15h3"/></>,
    agenda: <><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></>,
  };
  return <button type="button" className="mobile-header-action" aria-label={label} title={label} {...props}>
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">{paths[icon]}</svg>
  </button>;
}
