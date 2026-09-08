import { useId } from 'react';

// Inline "IO" monogram — I/O stands for input/output (the unified inbox) and
// the ring for the integration orbit around it (mail + calendar + contacts).
// The tile inherits the effective accent through var(--accent), so theme
// switches and custom-CSS accent overrides update the mark without JS. The
// legacy __light/__dark classes stay as hook classes on the shine/tonal
// overlay layers (see the brand-audit contract in brandAudit.test.js).
export default function LogoMark({ size = 32 }) {
  // Gradient ids must be unique per instance — the mark renders several times
  // on screen (sidebar, login, floating windows) and duplicated SVG ids would
  // make every instance resolve its gradients against the first definition.
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const tonalId = `inboxora-tonal-${uid}`;
  const shineId = `inboxora-shine-${uid}`;
  return (
    <span className="inboxora-logo-mark" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox="0 0 32 32" role="img" aria-label="Inboxora" style={{ display: 'block' }}>
        <defs>
          <linearGradient id={tonalId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="rgba(255,255,255,0.22)" />
            <stop offset="100%" stopColor="rgba(0,0,0,0.28)" />
          </linearGradient>
          <linearGradient id={shineId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(255,255,255,0.14)" />
            <stop offset="100%" stopColor="rgba(255,255,255,0)" />
          </linearGradient>
        </defs>
        {/* tło */}
        <rect width="32" height="32" rx="7.5" style={{ fill: 'var(--accent)' }} />
        <rect width="32" height="32" rx="7.5" fill={`url(#${tonalId})`} className="inboxora-logo-mark__dark" />
        <rect width="32" height="16" rx="7.5" fill={`url(#${shineId})`} className="inboxora-logo-mark__light" />

        {/* I z szeryfami */}
        <rect x="5.5" y="9" width="6.4" height="2.9" rx="1.2" fill="#fff" />
        <rect x="5.5" y="20.1" width="6.4" height="2.9" rx="1.2" fill="#fff" />
        <rect x="7.4" y="9" width="2.6" height="14" fill="#fff" />

        {/* O */}
        <circle cx="20.6" cy="16" r="5.6" fill="none" stroke="#fff" strokeWidth="3" />
      </svg>
    </span>
  );
}
