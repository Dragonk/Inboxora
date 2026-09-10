// One vector master for app chrome, favicons and generated installation assets.
export const BRAND_ACCENT = '#35558a';
export const BRAND_ENVELOPE = 'M7 12.5 16 6.5 25 12.5V23a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2Z';
export const BRAND_FOLD = 'm7 12.5 9 6 9-6M7.5 24l6.5-6M24.5 24 18 18';
export function brandSvg(accent = BRAND_ACCENT, { maskable = false, badge = false } = {}) {
  // Accent can originate from custom CSS. Escape XML attribute delimiters.
  const color = String(accent).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
  const symbol = `<path d="${BRAND_ENVELOPE}" fill="none" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/><path d="${BRAND_FOLD}" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${badge ? '' : `<rect width="32" height="32" rx="${maskable ? 0 : 7.5}" fill="${color}"/>`}<g${maskable ? ' transform="translate(4 4) scale(.75)"' : ''}>${symbol}</g></svg>`;
}
