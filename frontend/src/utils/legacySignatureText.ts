const BLOCK_TAGS = new Set(['ADDRESS', 'ARTICLE', 'BLOCKQUOTE', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'P', 'PRE', 'SECTION']);

/** Convert legacy HTML-only signature metadata without relying on rendered DOM layout. */
export function legacySignatureHtmlToText(html: string): string {
  const root = document.createElement('div');
  root.innerHTML = html;
  let result = '';
  const appendBreak = () => { if (!result.endsWith('\n')) result += '\n'; };
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      result += node.textContent || '';
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as HTMLElement;
    if (element.tagName === 'BR') { appendBreak(); return; }
    const block = BLOCK_TAGS.has(element.tagName);
    const before = result.length;
    element.childNodes.forEach(visit);
    // Historical empty paragraphs commonly contain only NBSP; retain real spaces.
    if (block && result.slice(before).replace(/\u00a0/g, '').trim() === '') result = result.slice(0, before);
    if (block) appendBreak();
  };
  root.childNodes.forEach(visit);
  return result.endsWith('\n') ? result.slice(0, -1) : result;
}
