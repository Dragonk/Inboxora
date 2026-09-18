/**
 * Helpers for the Electron desktop shell.
 *
 * The web/PWA build must never gain desktop-only chrome, so every call site asks
 * `isElectronShell()` instead of guessing from the presence of the native bridge
 * (Capacitor Android exposes the same `window.inboxoraNative` object).
 */

/** Window Controls Overlay height; mirrors TITLEBAR_HEIGHT in desktop-settings.cjs. */
export const DEFAULT_DESKTOP_TITLEBAR_HEIGHT = 48;

/** Whether the page runs inside the Inboxora Electron shell. */
export function isElectronShell(): boolean {
  if (typeof window === 'undefined') return false;
  return window.inboxoraNative?.shell === 'electron';
}

/** Strip for the custom title bar, from the preload when available. */
export function desktopTitlebarHeight(): number {
  if (typeof window === 'undefined') return DEFAULT_DESKTOP_TITLEBAR_HEIGHT;
  const height = window.inboxoraNative?.titlebar?.height;
  return typeof height === 'number' && Number.isFinite(height) && height > 0
    ? height
    : DEFAULT_DESKTOP_TITLEBAR_HEIGHT;
}

/** Whether the platform draws the traffic lights on the left (macOS). */
export function isMacDesktopShell(): boolean {
  if (typeof window === 'undefined') return false;
  return isElectronShell() && window.inboxoraNative?.platform === 'darwin';
}

export interface RgbColor { r: number; g: number; b: number }
export interface TitlebarTheme { color: string; symbolColor: string }

function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function toHex({ r, g, b }: RgbColor): string {
  return `#${[r, g, b].map((channel) => clampChannel(channel).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Parse the CSS color formats a theme variable can resolve to: `#rgb`,
 * `#rrggbb`, `rgb()` and `rgba()`. Anything else (named colors, `color-mix()`,
 * gradients, `var()` that failed to resolve) is rejected rather than guessed at.
 */
export function parseCssColor(value: unknown): RgbColor | null {
  const input = String(value ?? '').trim().toLowerCase();
  if (!input) return null;

  const hex = input.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (hex) {
    const digits = hex[1];
    const expanded = digits.length === 3 ? digits.split('').map((d) => d + d).join('') : digits;
    return {
      r: Number.parseInt(expanded.slice(0, 2), 16),
      g: Number.parseInt(expanded.slice(2, 4), 16),
      b: Number.parseInt(expanded.slice(4, 6), 16),
    };
  }

  const rgb = input.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  if (rgb) {
    const channels = [rgb[1], rgb[2], rgb[3]].map(Number);
    if (channels.some((channel) => !Number.isFinite(channel))) return null;
    return { r: clampChannel(channels[0]), g: clampChannel(channels[1]), b: clampChannel(channels[2]) };
  }

  return null;
}

// WCAG relative luminance. The window-control symbols need enough contrast
// against the bar, and the Inboxora themes range from #f6f5f1 to #000000.
export function relativeLuminance(color: RgbColor): number {
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/**
 * Native overlay theme for a title bar background. Returns null when the color
 * cannot be parsed, so the renderer leaves the last good overlay in place.
 */
export function titlebarThemeForBackground(background: unknown): TitlebarTheme | null {
  const color = parseCssColor(background);
  if (!color) return null;
  const symbolColor = relativeLuminance(color) > 0.4 ? '#000000' : '#ffffff';
  return { color: toHex(color), symbolColor };
}

// The last theme pushed to main. The main process persists it to the Electron
// config file, so re-sending an unchanged theme would mean pointless IPC and disk
// writes on every observed style mutation.
let lastSyncedTheme = '';

/** Read the resolved `--bg-primary` and push the matching overlay theme to main. */
export function syncDesktopTitlebarTheme(): void {
  if (typeof window === 'undefined' || !isElectronShell()) return;
  let background: string;
  try {
    background = getComputedStyle(document.documentElement).getPropertyValue('--bg-primary');
  } catch {
    return;
  }
  const theme = titlebarThemeForBackground(background);
  if (!theme) return;
  const key = `${theme.color}|${theme.symbolColor}`;
  if (key === lastSyncedTheme) return;
  lastSyncedTheme = key;
  window.inboxoraNative?.titlebar?.setTheme?.(theme)?.catch?.(() => {});
}
