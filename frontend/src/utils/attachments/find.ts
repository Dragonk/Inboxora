/** Literal Unicode-insensitive search keeps offsets in the original UTF-16 source. */
export function findMatches(text: string, query: string): Array<{ start: number; end: number }> {
  if (!query) return [];
  const literal = Array.from(query).map(character => '^$\\.*+?()[]{}|'.includes(character) ? String.fromCharCode(92) + character : character).join('');
  const pattern = new RegExp(literal, 'giu');
  const matches: Array<{ start: number; end: number }> = [];
  for (let match = pattern.exec(text); match && matches.length < 10000; match = pattern.exec(text)) {
    matches.push({ start: match.index, end: match.index + match[0].length });
  }
  return matches;
}
