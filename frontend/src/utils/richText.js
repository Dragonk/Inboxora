// Calendar descriptions are rendered by the same sanitized HTML pipeline as a
// mail body (MessageBodyRenderer) and edited with a WYSIWYG editor, so the value
// may be rich text (our editor), markup that arrived inside an invitation
// (X-ALT-DESC / DESCRIPTION from Outlook and friends) or plain text typed by
// hand. These helpers decide which of the two the reader should receive.

// Only real markup counts as HTML — a bare "<" or "a > b" inside hand-typed text
// must stay plain text instead of being parsed as a tag.
const TAG_NAMES = 'a|abbr|address|article|aside|b|big|blockquote|body|br|center|cite|code|dd|del|dfn|div|dl|dt|em|figcaption|figure|font|footer|h[1-6]|head|header|hr|html|i|img|ins|kbd|li|main|mark|meta|nav|ol|o:p|p|pre|q|s|samp|section|small|span|strike|strong|style|sub|sup|table|tbody|td|tfoot|th|thead|tr|tt|u|ul|var';
const HTML_MARKUP = new RegExp(`<\\s*(?:${TAG_NAMES})(?:\\s[^<>]*)?/?>|<\\s*/\\s*(?:${TAG_NAMES})\\s*>`, 'i');
const HTML_ENTITY = /&(?:nbsp|amp|lt|gt|quot|#\d{2,5}|#x[0-9a-f]{2,5});/i;
// What an "empty" WYSIWYG document looks like once serialized.
const EMPTY_DOCUMENT = /^\s*<p>(?:\s|<br\s*\/?>|&nbsp;)*<\/p>\s*$/i;

export function isHtmlRichText(value) {
  if (typeof value !== 'string' || !value) return false;
  return HTML_MARKUP.test(value) || HTML_ENTITY.test(value);
}

// An editor left untouched still emits "<p></p>"; that is no description at all.
export function isEmptyRichText(value) {
  if (typeof value !== 'string') return true;
  const trimmed = value.trim();
  return !trimmed || EMPTY_DOCUMENT.test(trimmed);
}

// The value the API should store: null when there is nothing to keep.
export function richTextOrNull(value) {
  return isEmptyRichText(value) ? null : value.trim();
}

// The props MessageBodyRenderer expects: exactly one of html/text is used.
export function calendarDescriptionBody(description) {
  if (isEmptyRichText(description)) return { html: '', text: '' };
  return isHtmlRichText(description) ? { html: description, text: '' } : { html: '', text: description };
}

function escapeHtmlText(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// What the WYSIWYG editor should show for a stored description. Plain text —
// which is what a description accepted from a mail client usually is — keeps its
// line structure instead of collapsing into a single paragraph, and is escaped so
// the editor never displays it as markup.
export function richTextEditorContent(value) {
  if (isEmptyRichText(value)) return '';
  if (isHtmlRichText(value)) return value;
  return value.split(/\r?\n/).map(line => `<p>${escapeHtmlText(line)}</p>`).join('');
}
