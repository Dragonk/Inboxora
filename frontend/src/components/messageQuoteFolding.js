const FORWARD_MARKER_RE = /^(?:[-–—]{2,}\s*)?(?:forwarded message|forwarded mail|begin forwarded message|przekazana wiadomość|wiadomość przekazana)(?:\s*[-–—]{2,})?:?/i;
const REPLY_MARKER_RE = /^(?:on\s+.+\s+wrote:|dnia\s+.+\s+napisa(?:ł|ła|li|ły)?\(?(?:a)?\)?:|am\s+.+\s+schrieb\s+.+:|le\s+.+\s+a écrit\s*:|el\s+.+\s+escribió:|il\s+.+\s+ha scritto:|-----\s*(?:original message|wiadomość oryginalna)\s*-----)/i;

function normalizedLines(value = '') {
  return String(value)
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[\t ]+/g, ' ').trim())
    .filter(Boolean);
}

export function startsWithForwardMarker(value = '') {
  return FORWARD_MARKER_RE.test(normalizedLines(value)[0] || '');
}

export function startsWithReplyMarker(value = '') {
  return normalizedLines(value).slice(0, 4).some(line => REPLY_MARKER_RE.test(line));
}

function isInside(root, element) {
  return root === element || root.contains(element);
}

function uniqueTopLevel(elements) {
  const ordered = [...new Set(elements)].filter(Boolean);
  return ordered.filter(element => !ordered.some(other => other !== element && other.contains(element)));
}

function candidateElements(doc, protectedForwards) {
  const explicit = [...doc.querySelectorAll([
    '.gmail_quote',
    '.gmail_quote_container',
    '.moz-quote-container',
    '.yahoo_quoted',
    'blockquote[type="cite"]',
    '#divRplyFwdMsg',
    '.OutlookMessageHeader',
  ].join(','))];

  const markedBlockquotes = [...doc.querySelectorAll('blockquote')]
    .filter(element => startsWithReplyMarker(element.textContent));

  return uniqueTopLevel([...explicit, ...markedBlockquotes])
    .filter(element => !protectedForwards.some(root => isInside(root, element)))
    .filter(element => !startsWithForwardMarker(element.textContent));
}

function protectedForwardRoots(doc) {
  const knownRoots = [...doc.querySelectorAll('.gmail_quote, .gmail_quote_container, .moz-forward-container, blockquote, div')]
    .filter(element => startsWithForwardMarker(element.textContent));
  return uniqueTopLevel(knownRoots);
}

function createToggle(doc, id, showLabel, hideLabel, onChange) {
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'mailflow-quote-toggle';
  button.dataset.mailflowQuoteToggle = id;
  button.setAttribute('aria-expanded', 'false');
  button.textContent = showLabel;
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    const expanded = button.getAttribute('aria-expanded') === 'true';
    const nextExpanded = !expanded;
    for (const node of doc.querySelectorAll(`[data-mailflow-quote-group="${id}"]`)) {
      node.classList.toggle('mailflow-quote-collapsed', !nextExpanded);
    }
    button.setAttribute('aria-expanded', String(nextExpanded));
    button.textContent = nextExpanded ? hideLabel : showLabel;
    onChange?.();
  });
  return button;
}

function installElementGroup(doc, element, index, options) {
  const id = `mailflow-quote-${index}`;
  element.dataset.mailflowQuoteGroup = id;
  element.classList.add('mailflow-quote-collapsed');
  element.parentNode?.insertBefore(createToggle(doc, id, options.showLabel, options.hideLabel, options.onChange), element);
}

export function plainTextBoundary(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/\u00a0/g, ' ').trim();
    if (FORWARD_MARKER_RE.test(line)) return -1;
    if (REPLY_MARKER_RE.test(line)) return offset;
    if (/^>/.test(line)) {
      const quotedTail = lines.slice(index).filter(candidate => candidate.trim()).every(candidate => /^\s*>/.test(candidate));
      const quotedCount = lines.slice(index).filter(candidate => /^\s*>/.test(candidate)).length;
      if (quotedTail && quotedCount >= 2) return offset;
    }
    offset += lines[index].length + 1;
  }
  return -1;
}

function installPlainTextGroup(doc, pre, options) {
  const text = pre.textContent || '';
  const boundary = plainTextBoundary(text);
  if (boundary < 0) return false;
  const visible = text.slice(0, boundary);
  const quoted = text.slice(boundary);
  const id = 'mailflow-quote-plain';
  pre.textContent = '';
  pre.append(doc.createTextNode(visible));
  const quote = doc.createElement('span');
  quote.dataset.mailflowQuoteGroup = id;
  quote.className = 'mailflow-quote-collapsed';
  quote.textContent = quoted;
  pre.append(createToggle(doc, id, options.showLabel, options.hideLabel, options.onChange), quote);
  return true;
}

export function installMessageQuoteFolding(doc, {
  showLabel = 'Show quoted text',
  hideLabel = 'Hide quoted text',
  onChange = null,
} = {}) {
  if (!doc?.body) return { count: 0, protectedForwardCount: 0 };
  const plainText = doc.querySelector('[data-mailflow-plain-text="true"]');
  if (plainText) {
    const installed = installPlainTextGroup(doc, plainText, { showLabel, hideLabel, onChange });
    return { count: installed ? 1 : 0, protectedForwardCount: startsWithForwardMarker(plainText.textContent) ? 1 : 0 };
  }

  const protectedForwards = protectedForwardRoots(doc);
  protectedForwards.forEach(root => { root.dataset.mailflowForwardRoot = 'true'; });
  const candidates = candidateElements(doc, protectedForwards);
  candidates.forEach((element, index) => installElementGroup(doc, element, index, { showLabel, hideLabel, onChange }));
  return { count: candidates.length, protectedForwardCount: protectedForwards.length };
}
