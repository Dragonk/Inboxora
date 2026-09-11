// Which canvas an HTML message was authored for.
//
// A mail body renders in its own document. When Inboxora paints that document with the
// app's dark surface, a message that brings its own design breaks: a newsletter that sets
// `background-color:#FFFFFF` on its tables but never sets a text colour would inherit our
// light default text and become white-on-white, and one that hard-codes `color:#000`
// against a transparent background becomes black-on-dark.
//
// Both are the same mistake in opposite directions: the app overrode a canvas the message
// had already assumed. So instead of forcing one surface on every message, the message is
// inspected first. One that carries its own colours is authored for a light canvas and is
// given one; one that carries none is genuinely unstyled and can safely follow the theme.
//
// This is deliberately a heuristic over *declared* colours, not a layout query: it has to
// be decided before the frame is written, or the wrong surface would paint first and flash.
// Only colours we can actually parse count, so an unrecognised value never triggers a
// decision on its own.

// Enough of the CSS named colours to cover what mail actually uses for a canvas. Anything
// absent is simply not recognised, which is the safe default (no decision).
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

function clampChannel(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

// '#abc' → [170,187,204]; '#aabbcc' and '#aabbccdd' (alpha dropped, it does not affect
// which canvas the colour implies) → the first three pairs.
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

// WCAG relative luminance, 0 (black) to 1 (white).
export function luminance([r, g, b]) {
  const channel = value => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

// A background at or above this reads as "light" to the eye; a text colour at or below
// the second threshold reads as "dark". The gap between them keeps mid-greys, which suit
// either canvas, from deciding on their own.
const LIGHT_BACKGROUND = 0.5;
const DARK_TEXT = 0.4;

// Declaration text of every inline style attribute and <style> block in the message.
function declaredStyleText(html) {
  const source = String(html ?? '');
  const chunks = [];
  for (const match of source.matchAll(/style\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
    chunks.push(match[2] ?? match[3] ?? '');
  }
  for (const match of source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    chunks.push(match[1]);
  }
  // Legacy HTML paints with the bgcolor attribute rather than CSS, and mail still uses it.
  for (const match of source.matchAll(/bgcolor\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
    chunks.push(`background-color:${match[2] ?? match[3] ?? ''}`);
  }
  return chunks;
}

// The colour token of a declaration, ignoring any other components of a shorthand such
// as `background: #fff url(...) no-repeat`. Functional notation is matched as a whole so
// its internal spaces (`rgb(13, 13, 13)`) never split it apart.
const COLOR_TOKEN_RE = /(#[0-9a-f]{3,8}|rgba?\([^)]*\))/gi;

function colorToken(value) {
  const text = String(value).trim();
  if (parseColor(text)) return text;
  for (const match of text.matchAll(COLOR_TOKEN_RE)) {
    if (parseColor(match[1])) return match[1];
  }
  for (const word of text.split(/[\s,]+/)) {
    if (parseColor(word)) return word;
  }
  return null;
}

function declaredColors(styleText) {
  const colors = [];
  for (const match of styleText.matchAll(/(?:^|[;{\s])(background(?:-color)?|color)\s*:\s*([^;}]+)/gi)) {
    const token = colorToken(match[2]);
    if (token) colors.push({ property: match[1].toLowerCase(), color: parseColor(token) });
  }
  return colors;
}

/**
 * True when the message declares colours of its own that only make sense on a light
 * canvas — a light background, or dark text that would sit on one. Such a message keeps
 * the canvas it was authored for, so its own styling stays readable whatever theme the
 * app is in.
 *
 * A message that declares nothing (or only dark backgrounds) returns false and is free to
 * follow the app theme.
 */
export function emailAssumesLightCanvas(html) {
  for (const chunk of declaredStyleText(html)) {
    for (const { property, color } of declaredColors(chunk)) {
      if (!color) continue;
      const value = luminance(color);
      if (property === 'color') {
        if (value <= DARK_TEXT) return true;
      } else if (value >= LIGHT_BACKGROUND) {
        return true;
      }
    }
  }
  // Only dark backgrounds, or none at all: the theme surface suits it.
  return false;
}
