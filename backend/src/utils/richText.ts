import { Parser } from 'htmlparser2';
import { sanitizeComposeBody } from '../services/emailSanitizer.js';

// A calendar description may hold either plain text (typed by hand, or the
// RFC 5545 text alternative a mail client sends alongside HTML) or HTML (our
// WYSIWYG editor, or the X-ALT-DESC part produced by Outlook/Exchange).
//
// iCalendar has no way to say "this DESCRIPTION is HTML", so anything that
// writes a description back out must keep the plain-text alternative in
// DESCRIPTION and put the markup in X-ALT-DESC;FMTTYPE=text/html (RFC 5545
// section 3.8.8.2). Plain calendar clients then keep reading a usable
// DESCRIPTION while HTML-capable ones render the formatting.
//
// Only real markup counts as HTML: a bare "<" or "a > b" in hand-typed text
// must not be treated as a tag.
const TAG_NAMES = 'a|abbr|address|article|aside|b|big|blockquote|body|br|center|cite|code|dd|del|dfn|div|dl|dt|em|figcaption|figure|font|footer|h[1-6]|head|header|hr|html|i|img|ins|kbd|li|main|mark|meta|nav|ol|o:p|p|pre|q|s|samp|section|small|span|strike|strong|style|sub|sup|table|tbody|td|tfoot|th|thead|tr|tt|u|ul|var';
const HTML_MARKUP = new RegExp(`<\\s*(?:${TAG_NAMES})(?:\\s[^<>]*)?/?>|<\\s*/\\s*(?:${TAG_NAMES})\\s*>`, 'i');
const HTML_ENTITY = /&(?:nbsp|amp|lt|gt|quot|#\d{2,5}|#x[0-9a-f]{2,5});/i;

export function isHtmlDescription(value) {
  if (typeof value !== 'string' || !value) return false;
  return HTML_MARKUP.test(value) || HTML_ENTITY.test(value);
}

// Stored descriptions are rendered by the same sanitized HTML pipeline as a mail
// body, but they also leave the app again (iCalendar feeds, invitations), so the
// markup is cleaned once on the way in with the compose policy.
export function sanitizeDescriptionHtml(value) {
  if (typeof value !== 'string' || !isHtmlDescription(value)) return value;
  return sanitizeComposeBody(value);
}

// Normalise an incoming description: empty means "no description", markup is
// sanitized, and plain text (including multi-line notes) is stored verbatim.
export function normalizeDescription(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return sanitizeDescriptionHtml(trimmed);
}

// Flatten HTML to the text alternative used for DESCRIPTION. Structure-aware so
// paragraphs, list items and <br> stay on their own lines instead of collapsing
// into one run-on sentence, and script/style bodies never leak into the text.
export function htmlToPlainText(html) {
  if (typeof html !== 'string' || !html) return '';
  let suppressed = 0;
  let text = '';
  const parser = new Parser({
    onopentag(name) {
      if (name === 'script' || name === 'style') suppressed++;
      if (!suppressed && name === 'br') text += '\n';
    },
    ontext(value) { if (!suppressed) text += value; },
    onclosetag(name) {
      if (name === 'script' || name === 'style') suppressed = Math.max(0, suppressed - 1);
      if (!suppressed && ['p', 'div', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre'].includes(name)) text += '\n';
    },
  }, { decodeEntities: true });
  parser.end(html);
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// The iCalendar content lines for a description: a plain-text DESCRIPTION plus,
// when the description carries markup, the HTML alternative. `escapeText` is the
// caller's iCalendar text escaper (each writer already owns one).
export function descriptionContentLines(description, escapeText) {
  if (!description) return [];
  if (!isHtmlDescription(description)) return [`DESCRIPTION:${escapeText(description)}`];
  const plain = htmlToPlainText(description);
  const lines = [`DESCRIPTION:${escapeText(plain)}`];
  lines.push(`X-ALT-DESC;FMTTYPE=text/html:${escapeText(description)}`);
  return lines;
}
