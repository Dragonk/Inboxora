import { BRAND_ENVELOPE, BRAND_FOLD } from '../brandMark.js';

export default function LogoMark({ size = 32 }) {
  return <span className="inboxora-logo-mark" style={{ width: size, height: size }}>
    <svg width={size} height={size} viewBox="0 0 32 32" role="img" aria-label="Inboxora" style={{ display: 'block' }}>
      <rect width="32" height="32" rx="7.5" style={{ fill: 'var(--accent)' }} />
      <path d={BRAND_ENVELOPE} fill="none" stroke="#fff" strokeWidth="1.8" strokeLinejoin="round" />
      <path d={BRAND_FOLD} fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  </span>;
}
