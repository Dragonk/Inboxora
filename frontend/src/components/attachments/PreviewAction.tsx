import type { ButtonHTMLAttributes, ReactNode } from 'react';
const paths = {
  folder: 'M3 7V4h6l3 3h9v13H3z',
  file: 'M14 2H5v20h14V7zM14 2v5h5M8 12h8M8 16h8',
  image: 'M3 3h18v18H3zM3 17l6-6 4 4 3-3 5 5M8 7h1',
  download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  downloadAll: 'M8 3v10m-4-4 4 4 4-4m4-6v10m-4-4 4 4 4-4M3 17v4h18v-4',
  detached: 'M9 3H3v18h18v-6M13 3h8v8m0-8L11 13',
  external: 'M8 8H3v13h13v-5M9 3h12v12H9z',
  fullscreen: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5',
  close: 'm6 6 12 12M18 6 6 18', minimize: 'M5 17h14',
  fitWidth: 'M3 3v18m18-18v18M5 12h14M8 9l-3 3 3 3m8-6 3 3-3 3',
  fitPage: 'M6 3h12v18H6zM9 7h6v10H9z',
  rotateLeft: 'M3 10a9 9 0 1 1 2 9M3 4v6h6',
  rotateRight: 'M21 10a9 9 0 1 0-2 9m2-15v6h-6',
  thumbnails: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  outline: 'M3 5h2m3 0h13M3 12h2m3 0h13M3 19h2m3 0h13',
  print: 'M6 9V3h12v6M6 17H3V9h18v8h-3M6 14h12v7H6zM17 11h1',
  copy: 'M8 8h13v13H8zM16 5V3H3v13h2',
  search: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14m5 12 6 6',
  signatures: 'M12 2l8 4v6c0 5-8 10-8 10S4 17 4 12V6zM8 12l3 3 5-6',
  previous: 'm14 5-7 7 7 7', next: 'm10 5 7 7-7 7',
  zoomIn: 'M12 4v16M4 12h16', zoomOut: 'M4 12h16',
} as const;
export type PreviewIcon = keyof typeof paths;
export function PreviewSymbol({ icon }: { icon: PreviewIcon }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[icon]} /></svg>;
}
export default function PreviewAction({ icon, label, tooltip = label, badge, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: PreviewIcon; label: string; tooltip?: string; badge?: ReactNode }) {
  return <button {...props} type="button" className={`attachment-icon-action ${className}`} title={tooltip} aria-label={label}><PreviewSymbol icon={icon} />{badge}</button>;
}
