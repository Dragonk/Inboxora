import { createContext, useContext } from 'react';
import { createPortal } from 'react-dom';

export const MobileHeaderHost = createContext(null);

// The active module owns its actions, including disabled/loading state. Rendering
// them in the shell avoids duplicate headers and imperative cross-module events.
export function MobileModuleHeader({ title, subtitle, children }) {
  const host = useContext(MobileHeaderHost);
  if (!host) return null;
  return createPortal(<>
    <div className="mobile-module-title"><h1>{title}</h1>{subtitle && <small title={subtitle}>{subtitle}</small>}</div>
    {children}
  </>, host);
}

export function HeaderAction({ icon, label, ...props }) {
  const paths = {
    add: <path d="M12 5v14M5 12h14" />,
    books: <><path d="M4 4h14a2 2 0 0 1 2 2v14H6a2 2 0 0 1-2-2V4Z"/><path d="M4 16h16M8 4v12M12 8h4M12 11h4"/></>,
    calendars: <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18M7 15h3M14 15h3"/></>,
    agenda: <><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></>,
  };
  return <button type="button" className="mobile-header-action" aria-label={label} title={label} {...props}>
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">{paths[icon]}</svg>
  </button>;
}
