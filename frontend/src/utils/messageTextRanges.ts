import { findMatches } from './attachments/find.ts';
/** Literal search across adjacent text nodes, scoped to one displayed message. */
export function messageTextRanges(root: HTMLElement, query: string, matchCase = false): Range[] {
  const doc = root.ownerDocument; const nodes: { node: Node; start: number; end: number }[] = [];
  const walker = doc.createTreeWalker(root, 4); let node: Node | null; let text = '';
  while ((node = walker.nextNode())) {
    if (node.parentElement?.closest('script,style,button,[hidden]')) continue;
    const value = node.nodeValue || ''; if (!value) continue;
    const start = text.length; text += value; nodes.push({ node, start, end: text.length });
    if (text.length > 2 * 1024 * 1024 || nodes.length > 20000) throw new Error('LIMIT');
  }
  const result: Range[] = []; let cursor = 0;
  for (const hit of findMatches(text, query)) {
    if (matchCase && text.slice(hit.start, hit.end) !== query) continue;
    while (cursor < nodes.length && nodes[cursor].end <= hit.start) cursor++;
    const start = nodes[cursor]; let endIndex = cursor;
    while (endIndex < nodes.length - 1 && nodes[endIndex].end < hit.end) endIndex++;
    const end = nodes[endIndex]; if (!start || !end) continue;
    const range = doc.createRange(); range.setStart(start.node, hit.start - start.start); range.setEnd(end.node, hit.end - end.start);
    result.push(range);
  }
  return result;
}
