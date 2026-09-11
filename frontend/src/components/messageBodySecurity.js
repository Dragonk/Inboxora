import DOMPurifyModule from 'dompurify';
import postcss from 'postcss';
import {
  adaptTextForCanvas,
  findColorToken,
  isLightBackground,
  needsDarkening,
  needsLifting,
  parseColor,
  rgbToHex,
  textForLightBackground,
} from '../utils/emailCanvas.js';

function purifier() {
  if (typeof DOMPurifyModule?.sanitize === 'function') return DOMPurifyModule;
  if (typeof DOMPurifyModule === 'function' && typeof window !== 'undefined') return DOMPurifyModule(window);
  throw new Error('DOMPurify requires a browser document');
}


const SAFE_PROPERTIES = new Set(['background','background-color','background-image','background-position','background-repeat','background-size','border','border-top','border-right','border-bottom','border-left','border-radius','border-collapse','border-spacing','color','display','float','clear','font','font-family','font-size','font-style','font-weight','letter-spacing','line-height','height','min-height','max-height','width','min-width','max-width','margin','margin-top','margin-right','margin-bottom','margin-left','padding','padding-top','padding-right','padding-bottom','padding-left','text-align','text-decoration','text-transform','text-indent','vertical-align','white-space','word-break','overflow','overflow-x','overflow-y','opacity','table-layout','visibility','mso-line-height-rule','-webkit-text-size-adjust','direction','unicode-bidi']);
const BAD_CSS = /(?:expression\s*\(|behavior\s*:|-moz-binding\s*:|javascript\s*:|vbscript\s*:|@import\b)/i;
const URL_RE = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
function safeCssUrl(value) { let bad = false; const next = value.replace(URL_RE, (_all, _q, raw) => { const url = String(raw || '').trim(); if (/^(https?:|\/\/|cid:|data:image\/)/i.test(url)) return `url("${url.replace(/"/g, '%22')}")`; bad = true; return 'none'; }); return bad ? null : next; }
export function sanitizeInlineStyle(style = '') { const kept = []; for (const declaration of String(style).split(';')) { const i = declaration.indexOf(':'); if (i < 1) continue; const property = declaration.slice(0, i).trim().toLowerCase(); let value = declaration.slice(i + 1).trim(); if (!SAFE_PROPERTIES.has(property) || !value || BAD_CSS.test(value)) continue; value = safeCssUrl(value); if (value != null) kept.push(`${property}:${value}`); } return kept.join(';'); }
export function sanitizeEmailCss(css = '') { let root; try { root = postcss.parse(String(css)); } catch { return ''; } root.walkAtRules(rule => { if (!['media','supports'].includes(rule.name.toLowerCase()) || BAD_CSS.test(rule.params)) rule.remove(); }); root.walkDecls(declaration => { const property = declaration.prop.toLowerCase(); const value = safeCssUrl(declaration.value); if (!SAFE_PROPERTIES.has(property) || BAD_CSS.test(declaration.value) || value == null) declaration.remove(); else declaration.value = value; }); return root.toString(); }

// Shared email HTML security policy. This is a leaf module so browser tests and
// both React renderers exercise the exact same sanitizer/CSP/srcDoc implementation.
export const EMAIL_SANITIZE_POLICY = {
  ADD_ATTR: ['target'],
  ADD_TAGS: ['style'],
  FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'video', 'audio', 'source', 'track'],
  FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover'],
};

function preserveCid(html) {
  return html.replace(/(src|href)=("|')cid:/gi, '$1=$2cid:');
}

// ── Adapting a message to the app's dark canvas ───────────────────────────────
//
// Applied only in the dark appearance. The canvas stays dark — the message is not
// repainted — and the individual declarations that would become unreadable are adjusted:
//
//   * an element painting its own light background keeps it, and gains a dark text colour
//     when it declares none, so the app's light default cannot land on the message's card;
//   * text that is dark, and not inside any light region the message painted, is lifted to
//     a light colour, so it stays readable on the dark canvas;
//   * the mirror case — light text inside a light region — is darkened.
//
// Only inline styles are adapted. A <style> block cannot be reasoned about element by
// element, and rewriting its colours blind would break the rules targeting content inside
// a message's own light cards. Real messages carry the colours that matter inline.

function readDeclarations(styleText) {
  const found = new Map();
  for (const declaration of String(styleText || '').split(';')) {
    const separator = declaration.indexOf(':');
    if (separator < 1) continue;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).trim();
    if (property && value) found.set(property, value);
  }
  return found;
}

function writeDeclarations(element, declarations) {
  if (!declarations.size) { element.removeAttribute('style'); return; }
  element.setAttribute('style', [...declarations].map(([property, value]) => `${property}:${value}`).join(';'));
}

// The colour an element paints behind its content: the inline background, else the legacy
// bgcolor attribute that table-based mail still uses.
function elementBackground(element, declarations) {
  const declared = declarations.get('background-color') || declarations.get('background');
  const fromStyle = declared ? parseColor(findColorToken(declared)) : null;
  if (fromStyle) return fromStyle;
  return parseColor(element.getAttribute('bgcolor'));
}

function elementForeground(declarations) {
  const declared = declarations.get('color');
  return declared ? parseColor(findColorToken(declared)) : null;
}

// The surface a piece of text is actually read on: the nearest element that paints a
// background, starting with the element itself. Walking all the way up and asking "is any
// ancestor light?" is wrong — a dark band nested inside a light wrapper would be judged by
// the wrapper, and its white text would be darkened into the band.
function nearestPaintedBackground(element) {
  for (let node = element; node; node = node.parentElement) {
    const declarations = readDeclarations(node.getAttribute('style'));
    const background = elementBackground(node, declarations);
    if (background) return background;
  }
  return null;
}

function setColorDeclaration(declarations, color) {
  declarations.delete('color');
  declarations.set('color', rgbToHex(color));
}

/**
 * Adapts an already-sanitised message to a dark canvas. Mutates the nodes in place.
 * Exported so the contract can be exercised directly in a browser test.
 */
export function adaptMessageForDarkCanvas(root) {
  if (!root) return;
  for (const element of root.querySelectorAll('[style], [bgcolor]')) {
    const declarations = readDeclarations(element.getAttribute('style'));
    const ownBackground = elementBackground(element, declarations);
    const foreground = elementForeground(declarations);
    // The region the text is read in is decided by the nearest painted background, falling
    // back to the app's canvas when the message paints none above it.
    const region = ownBackground || nearestPaintedBackground(element.parentElement);
    const lightRegion = Boolean(region && isLightBackground(region));
    const paintsLight = Boolean(ownBackground && isLightBackground(ownBackground));
    // Tracked explicitly rather than by comparing the attribute before and after: only the
    // parsed map is mutated here, so the attribute is still unchanged at the comparison.
    let changed = false;

    if (foreground) {
      if (needsDarkening(foreground, lightRegion)) { setColorDeclaration(declarations, adaptTextForCanvas(foreground, true)); changed = true; }
      else if (needsLifting(foreground, lightRegion)) { setColorDeclaration(declarations, adaptTextForCanvas(foreground, false)); changed = true; }
    } else if (paintsLight) {
      // The message's own light card carries content with no colour of its own.
      setColorDeclaration(declarations, textForLightBackground(ownBackground));
      changed = true;
    }

    if (changed) writeDeclarations(element, declarations);
  }
}

export function sanitizeMessageHtml(html = '', { remoteImages = false, tone = null } = {}) {
  const purify = purifier();
  const sanitized = purify.sanitize(preserveCid(String(html)), {
    ...EMAIL_SANITIZE_POLICY,
    ADD_ATTR: [...EMAIL_SANITIZE_POLICY.ADD_ATTR, 'data-mailflow-remote-src', 'data-mailflow-remote-blocked'],
    ALLOW_UNKNOWN_PROTOCOLS: false,
  });
  const template = document.createElement('template');
  template.innerHTML = sanitized;
  for (const element of template.content.querySelectorAll('[style]')) {
    const safe = sanitizeInlineStyle(element.getAttribute('style'));
    if (safe) element.setAttribute('style', safe); else element.removeAttribute('style');
  }
  // After sanitising, so adaptation can never reintroduce a property the sanitizer stripped.
  if (tone === 'dark') adaptMessageForDarkCanvas(template.content);
  for (const style of template.content.querySelectorAll('style')) {
    const safe = sanitizeEmailCss(style.textContent);
    if (safe) style.textContent = safe; else style.remove();
  }
  for (const image of template.content.querySelectorAll('img')) {
    const currentSrc = image.getAttribute('src') || '';
    const preservedSrc = image.getAttribute('data-mailflow-remote-src') || '';
    const remoteSrc = /^(?:https?:)?\/\//i.test(currentSrc) ? currentSrc : preservedSrc;
    if (!remoteSrc) continue;
    const normalizedSrc = remoteSrc.startsWith('//') ? `https:${remoteSrc}` : remoteSrc;
    if (remoteImages) {
      image.setAttribute('src', normalizedSrc);
      image.removeAttribute('data-mailflow-remote-blocked');
    } else {
      image.setAttribute('data-mailflow-remote-src', normalizedSrc);
      image.setAttribute('data-mailflow-remote-blocked', 'true');
      if (/^(?:https?:)?\/\//i.test(currentSrc)) image.removeAttribute('src');
      image.removeAttribute('srcset');
    }
  }
  return template.innerHTML;
}


export function escapeMessageText(text = '') {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function emailCsp({ remoteImages = false } = {}) {
  return remoteImages
    ? "default-src 'none'; img-src 'self' data: cid: https:; style-src 'unsafe-inline'; media-src 'self' data:"
    : "default-src 'none'; img-src 'self' data: cid:; style-src 'unsafe-inline'; media-src 'self' data:";
}

export const EMAIL_BASE_TAG = '<base target="_blank" rel="noopener noreferrer">';

// A mail body's own document cannot inherit the app's custom properties, and its
// user-agent defaults (black text in a light colour scheme) follow the operating
// system rather than the app theme. Without an explicit surface an unstyled message
// therefore renders black-on-dark whenever the app is in a dark appearance. The
// caller passes the surface in (see getEmailSurface) and this turns it into the
// frame's defaults.
//
// The values are re-checked here rather than trusted, so the exported helper stays
// safe for any caller: only a plain CSS colour can reach the frame's stylesheet.
const CSS_COLOR_RE = /^(?:#[0-9a-f]{3,8}|rgba?\(\s*[\d.%,\s/]+\)|hsla?\(\s*[\d.%,\s/deg]+\)|[a-z]{3,20})$/i;
function safeCssColor(value) {
  const candidate = String(value ?? '').trim();
  return CSS_COLOR_RE.test(candidate) ? candidate : null;
}

// Resolves the surface painted into the frame.
//
// The canvas always follows the app theme. Deciding it from the message instead — "this
// one carries colours of its own, so paint it white" — was far too blunt: virtually every
// real message contains at least one dark colour (a footer, a legal line), so a dark theme
// rendered every message white. Conflicts are resolved per declaration by
// adaptMessageForDarkCanvas instead.
function resolveEmailSurface(surface) {
  if (!surface || (surface.tone !== 'light' && surface.tone !== 'dark')) return null;
  // The light appearance already inherits the panel behind the frame, which paints the
  // theme surface. Adding a background here would only switch text from grayscale to
  // subpixel antialiasing and churn every light-mode capture for no visible gain.
  if (surface.tone === 'light') return { tone: 'light' };
  return surface;
}

function emailSurfaceCss(surface) {
  if (!surface || (surface.tone !== 'light' && surface.tone !== 'dark')) return '';
  const tone = surface.tone;
  const background = safeCssColor(surface.background);
  const foreground = safeCssColor(surface.foreground);
  // The colour scheme always follows the canvas being painted. This is the declaration the
  // backend relies on when it strips an email's own `color-scheme`: it is what stops the
  // frame's user-agent defaults — default text colour, form controls, scrollbars,
  // prefers-color-scheme — from following the operating system instead of Inboxora.
  const rules = [`  html { color-scheme: ${tone}; }`];
  const declarations = [];
  if (background) declarations.push(`background-color: ${background};`);
  // A dark canvas must state its text colour: leaving it to the user agent is exactly what
  // followed the operating system. A light canvas keeps the user agent's dark default,
  // which is the text the light appearance has always rendered.
  if (tone === 'dark' && foreground) declarations.push(`color: ${foreground};`);
  if (declarations.length) rules.push(`  html, body { ${declarations.join(' ')} }`);
  return `\n  /* Mail body surface, declared from the app theme. Scoped to this document only. */\n${rules.join('\n')}`;
}

export function buildSrcDoc(html, { remoteImages = false, surface = null } = {}) {
  const csp = emailCsp({ remoteImages });
  const resolved = resolveEmailSurface(surface);
  const surfaceCss = emailSurfaceCss(resolved);
  // The colour-scheme meta is the documented counterpart of the backend stripping an
  // email's own `color-scheme` declarations: a message must not choose the frame's
  // scheme, the app does. It also drives form controls, scrollbars and the
  // prefers-color-scheme media query inside the frame.
  const colorSchemeMeta = surfaceCss
    ? `<meta name="color-scheme" content="${resolved.tone === 'dark' ? 'dark' : 'light'}">\n`
    : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${colorSchemeMeta}<meta http-equiv="Content-Security-Policy" content="${csp}">
${EMAIL_BASE_TAG}
<style>
  /* Shared MessagePane/ConversationReader mobile fit contract. Never hide overflow:
     an oversized legacy newsletter must reflow or remain horizontally accessible. */
  html { margin: 0; padding: 0; max-width: 100%; overflow-x: auto; box-sizing: border-box; }
  body { margin: 0; padding: 8px; max-width: 100%; box-sizing: border-box; word-wrap: break-word; overflow-wrap: anywhere; }
  @media (max-width: 767px) { table { width: 100% !important; max-width: 100% !important; } }
  img, svg, video, canvas { max-width: 100%; height: auto; }
  pre, code { max-width: 100%; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
  a { overflow-wrap: anywhere; word-break: break-word; }
  blockquote { max-width: 100%; margin-left: 1em; border-left: 3px solid var(--border, #ddd); padding-left: 1em; color: inherit; opacity: 0.8; }
  pre[data-mailflow-plain-text] { white-space: pre-wrap; margin: 0; font: inherit; }
  .mailflow-quote-collapsed { display: none !important; }
  .mailflow-quote-toggle { display: inline-flex; align-items: center; justify-content: center; min-width: 34px; margin: 8px 0; padding: 2px 9px; border: 1px solid #c7c7c7; border-radius: 999px; background: #f3f3f3; color: #555; font: 12px/1.5 system-ui, sans-serif; cursor: pointer; }
  .mailflow-quote-toggle:hover { background: #e8e8e8; }
  .mailflow-quote-toggle:focus-visible { outline: 2px solid #4c8bf5; outline-offset: 2px; }
${surfaceCss}
</style>
</head><body>${html}</body></html>`;
}
