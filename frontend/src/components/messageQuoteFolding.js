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

function uniqueTopLevel(elements) {
  const ordered = [...new Set(elements)].filter(Boolean);
  return ordered.filter(element => !ordered.some(other => other !== element && other.contains(element)));
}

function quoteElements(doc) {
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
  return [...new Set([...explicit, ...markedBlockquotes])];
}

function protectedForwardRoots(doc) {
  return [...doc.querySelectorAll('.gmail_quote, .gmail_quote_container, .moz-forward-container, blockquote, div')]
    .filter(element => startsWithForwardMarker(element.textContent));
}

function candidateGroups(doc, protectedForwards) {
  const protectedSet = new Set(protectedForwards);
  // A forwarded envelope remains visible, but quote candidates nested inside it are
  // still eligible. Filtering forward roots before top-level de-duplication is what
  // preserves Gmail's hierarchical behaviour for forwards containing old replies.
  const explicit = quoteElements(doc)
    .filter(element => !protectedSet.has(element))
    .filter(element => !startsWithForwardMarker(element.textContent));
  const explicitTop = uniqueTopLevel(explicit);
  const explicitGroups = explicitTop.map(element => [element]);
  // Structural fold: detect reply markers ("On ... wrote:", "Dnia ... napisał(a):") in
  // block elements that have NO provider quote wrapper (.gmail_quote, blockquote, etc.).
  // Gmail, Apple Mail, Thunderbird and many clients emit plain <p>/<div> with the marker
  // as the first visible line, followed by the entire historical subtree. Without this,
  // MailFlow displays the complete reply chain.
  // One expander per historical region: the marker's top-level ancestor and ALL following
  // top-level siblings collapse into a single group (returned as one array).
  // Skip structural roots already covered by explicit wrappers to avoid double toggles.
  const structuralGroup = structuralQuoteRoots(doc, protectedSet, explicitTop);
  const groups = [...explicitGroups];
  if (structuralGroup.length) groups.push(structuralGroup);
  return groups;
}

function structuralQuoteRoots(doc, protectedSet, explicitElements = []) {
  const roots = [];
  const seen = new Set();
  const topLevel = [...(doc.body?.children || [])];
  for (let index = 0; index < topLevel.length; index += 1) {
    const element = topLevel[index];
    if (protectedSet.has(element) || seen.has(element)) continue;
    // Skip if this top-level element is already covered by an explicit wrapper (e.g.
    // .gmail_quote) — those get their own toggle via explicitGroups.
    if (explicitElements.some(explicit => explicit === element || explicit.contains(element) || element.contains(explicit))) continue;
    // A top-level element is a quote root if it (or a descendant block) starts with a
    // reply marker. This catches both <p>On ... wrote:</p> at top level and <div>...
    // <p>On ... wrote:</p> ...</div> where the <div> is the top-level container.
    if (elementStartsWithReplyMarker(element)) {
      roots.push(element);
      seen.add(element);
      // Collapse the entire remaining historical region: this element AND all following
      // top-level siblings. One expander for one historical region.
      for (let tail = index + 1; tail < topLevel.length; tail += 1) {
        const sibling = topLevel[tail];
        if (!seen.has(sibling)) { roots.push(sibling); seen.add(sibling); }
      }
      break;
    }
  }
  return roots;
}

function elementStartsWithReplyMarker(element) {
  // Check the element's own visible text first (for <p>On ... wrote:</p> at top level).
  if (startsWithReplyMarker(element.textContent || '')) return true;
  // Then check descendant block elements (for <div><p>On ... wrote:</p>...</div>).
  // Only inspect block elements — inline <span> fragments are part of the current message.
  const blocks = element.querySelectorAll('p, div, span, blockquote, pre, table');
  for (const block of blocks) {
    if (startsWithReplyMarker(block.textContent || '')) return true;
  }
  return false;
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

function installGroup(doc, elements, index, options) {
  if (!elements.length) return;
  const id = `mailflow-quote-${index}`;
  // One toggle before the first element; all elements share the same group ID so
  // they collapse/expand together. This produces a single "Show quoted text" button
  // for the entire historical region (one expander per region).
  elements.forEach(element => {
    element.dataset.mailflowQuoteGroup = id;
    element.classList.add('mailflow-quote-collapsed');
  });
  elements[0].parentNode?.insertBefore(createToggle(doc, id, options.showLabel, options.hideLabel, options.onChange), elements[0]);
}

export function plainTextBoundary(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/\u00a0/g, ' ').trim();
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
  const groups = candidateGroups(doc, protectedForwards);
  groups.forEach((elements, index) => installGroup(doc, elements, index, { showLabel, hideLabel, onChange }));
  return { count: groups.length, protectedForwardCount: protectedForwards.length };
}
