import type { Options } from 'docx-preview';

/** Conversion never inserts document content into the application DOM.
 * The result is sanitized again by the isolated message frame. */
export function inertOfficeDom(): { document: Document; h: Options['h'] } {
  const document = window.document.implementation.createHTMLDocument('');
  let nodes = 0;
  const h: Options['h'] = entry => {
    if (++nodes > 150000) throw new Error('LIMIT');
    if (typeof entry === 'string') return document.createTextNode(entry);
    if (entry instanceof Node) return entry.ownerDocument === document ? entry : document.importNode(entry, true);
    const { tagName, ns, className, style, children, ...attributes } = entry;
    if (!tagName || tagName === '#fragment') {
      const fragment = document.createDocumentFragment();
      children?.forEach(child => fragment.append(h(child)));
      return fragment;
    }
    if (tagName === '#comment') return document.createComment('');
    if (['script', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form', 'input'].includes(tagName.toLowerCase())) return document.createTextNode('');
    const element = ns ? document.createElementNS(ns, tagName) : document.createElement(tagName);
    if (className) element.setAttribute('class', className);
    if (typeof style === 'string') element.setAttribute('style', style);
    else if (style && 'style' in element) Object.assign((element as HTMLElement).style, style);
    for (const [key, value] of Object.entries(attributes)) {
      if (typeof value !== 'string' && typeof value !== 'number') continue;
      if (key === 'src' && !/^data:image\//i.test(String(value))) continue;
      if (key === 'href' && !String(value).startsWith('#')) continue;
      if (['src', 'href', 'id', 'lang', 'title', 'colSpan', 'rowSpan', 'width', 'height', 'xmlns'].includes(key)) element.setAttribute(key.toLowerCase(), String(value));
    }
    children?.forEach(child => element.appendChild(h(child)));
    return element;
  };
  return { document, h };
}
