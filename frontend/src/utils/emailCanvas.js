// Reading an HTML message on the app's canvas.
//
// A mail body renders in its own document and cannot see the app's colour tokens. Two
// opposite mistakes are possible, and both hide text:
//
//   * the app paints its dark canvas, but the message hard-codes dark text for the light
//     page it was written for — dark on dark;
//   * the message paints its own light card, but the app's light default text lands on it
//     — light on light.
//
// The fix is NOT to repaint the document. Deciding the canvas from "does this message
// contain any colours of its own?" is far too blunt: practically every real message
// contains at least one dark colour somewhere (a footer, a legal line), so that rule made
// every message white in a dark theme. The canvas always follows the app theme instead,
// and only the individual declarations that would become unreadable are adapted.
//
// Adaptation keeps hue and saturation and mirrors lightness, so a muted grey footer stays
// muted and a near-black heading stays the most prominent text — the relationships the
// message's author chose survive, while the contrast flips to suit the canvas.
//
// Everything here is pure so it can be reasoned about and tested without a DOM; the walk
// that applies it to a message lives with the sanitiser.

// Enough of the CSS named colours to cover what mail actually uses. Anything absent is
// simply not recognised, which is the safe default (no adaptation).
const NAMED_COLORS = {
  white: [255, 255, 255], snow: [255, 250, 250], ivory: [255, 255, 240],
  whitesmoke: [245, 245, 245], gainsboro: [220, 220, 220], silver: [192, 192, 192],
  lightgrey: [211, 211, 211], lightgray: [211, 211, 211], grey: [128, 128, 128],
  gray: [128, 128, 128], dimgrey: [105, 105, 105], dimgray: [105, 105, 105],
  black: [0, 0, 0], navy: [0, 0, 128], midnightblue: [25, 25, 112],
  darkblue: [0, 0, 139], darkslategrey: [47, 79, 79], darkslategray: [47, 79, 79],
  red: [255, 0, 0], darkred: [139, 0, 0], maroon: [128, 0, 0],
  blue: [0, 0, 255], mediumblue: [0, 0, 205], royalblue: [65, 105, 225],
  teal: [0, 128, 128], green: [0, 128, 0], darkgreen: [0, 100, 0],
  transparent: null,
};

const HEX_RE = /^#([0-9a-f]{3,8})$/i;
const FUNCTIONAL_RE = /^rgba?\(\s*([^)]+)\)$/i;
// A colour token inside a shorthand such as `background: #fff url(...) no-repeat`.
// Functional notation is matched whole so its internal spaces never split it.
const COLOR_TOKEN_RE = /(#[0-9a-f]{3,8}|rgba?\([^)]*\))/gi;

function clampChannel(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function parseHex(value) {
  let hex = value.slice(1);
  if (hex.length === 3 || hex.length === 4) hex = [...hex].map(char => char + char).join('');
  if (hex.length !== 6 && hex.length !== 8) return null;
  return [0, 2, 4].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
}

function parseFunctional(value) {
  const match = value.match(FUNCTIONAL_RE);
  if (!match) return null;
  const parts = match[1].split(/[,\s/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const channels = parts.slice(0, 3).map(part => {
    const numeric = Number.parseFloat(part);
    if (!Number.isFinite(numeric)) return null;
    return part.endsWith('%') ? (numeric / 100) * 255 : numeric;
  });
  if (channels.some(channel => channel === null)) return null;
  return channels.map(clampChannel);
}

/** Parses a CSS colour to [r,g,b], or null when it is not one we recognise. */
export function parseColor(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return null;
  if (text in NAMED_COLORS) return NAMED_COLORS[text];
  if (HEX_RE.test(text)) return parseHex(text);
  return parseFunctional(text);
}

/** The first colour found in a declaration value, or null. */
export function findColorToken(value) {
  const text = String(value ?? '').trim();
  if (parseColor(text)) return text;
  for (const match of text.matchAll(COLOR_TOKEN_RE)) {
    if (parseColor(match[1])) return match[1];
  }
  for (const word of text.split(/[\s,]+/)) {
    if (parseColor(word)) return word;
  }
  return null;
}

export function rgbToHex([r, g, b]) {
  return `#${[r, g, b].map(channel => clampChannel(channel).toString(16).padStart(2, '0')).join('')}`;
}

/** HSL with h in degrees, s and l as fractions — the space adaptation works in. */
export function rgbToHsl([r, g, b]) {
  const [red, green, blue] = [r / 255, g / 255, b / 255];
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const delta = max - min;
  const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let h;
  if (max === red) h = ((green - blue) / delta) % 6;
  else if (max === green) h = (blue - red) / delta + 2;
  else h = (red - green) / delta + 4;
  return [(h * 60 + 360) % 360, s, l];
}

export function hslToRgb([h, s, l]) {
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const second = chroma * (1 - Math.abs((hp % 2) - 1));
  const base = l - chroma / 2;
  const [r, g, b] = hp < 1 ? [chroma, second, 0]
    : hp < 2 ? [second, chroma, 0]
      : hp < 3 ? [0, chroma, second]
        : hp < 4 ? [0, second, chroma]
          : hp < 5 ? [second, 0, chroma]
            : [chroma, 0, second];
  return [r, g, b].map(channel => clampChannel((channel + base) * 255));
}

/** Perceived lightness, 0 (black) to 1 (white). */
export function lightness(color) {
  return rgbToHsl(color)[2];
}

// A background at or above this is one a message painted for a light page; text inside it
// must be dark.
const LIGHT_BACKGROUND = 0.6;
// Text this light, inside a light region, would be illegible there: darken it.
const LIGHT_REGION_TEXT_ABOVE = 0.6;
// Text this dark, on the app's dark canvas, would be illegible there: lift it.
const DARK_REGION_TEXT_BELOW = 0.5;
// Mirroring lightness can land mid-grey, which reads as broken rather than muted. These
// bounds keep adapted text clearly dark or clearly light.
const ADAPTED_DARK_MAX = 0.35;
const ADAPTED_LIGHT_MIN = 0.6;
// Saturation is softened slightly: a fully saturated colour mirrored to a light lightness
// becomes garish, while the hue still reads as the author's choice.
const ADAPTED_SATURATION = 0.8;

export function isLightBackground(color) {
  return lightness(color) >= LIGHT_BACKGROUND;
}

/** True when text this light cannot be read on the given region. */
export function needsDarkening(textColor, onLightRegion) {
  return Boolean(onLightRegion && lightness(textColor) > LIGHT_REGION_TEXT_ABOVE);
}

/** True when text this dark cannot be read on the app's dark canvas. */
export function needsLifting(textColor, onLightRegion) {
  return Boolean(!onLightRegion && lightness(textColor) < DARK_REGION_TEXT_BELOW);
}

/** Mirrors a colour's lightness so it suits the canvas it will be read on. */
export function adaptTextForCanvas(color, onLightRegion) {
  const [h, s, l] = rgbToHsl(color);
  const mirrored = 1 - l;
  const target = onLightRegion
    ? Math.min(ADAPTED_DARK_MAX, mirrored)
    : Math.max(ADAPTED_LIGHT_MIN, mirrored);
  return hslToRgb([h, s * ADAPTED_SATURATION, target]);
}

/**
 * A dark text colour for an element that paints its own light background but declares no
 * text colour — the case where the app's light default used to land on a message's white
 * card and vanish.
 */
export function textForLightBackground(background) {
  const [h, s] = rgbToHsl(background);
  return hslToRgb([h, Math.min(s, 0.25), 0.14]);
}
