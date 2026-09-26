/** Refresh only the already loaded window, respecting the server's 500-row cap. */
export async function readMailWindow<T extends { id: string }>(
  fetchPage: (limit: number, offset: number) => Promise<{ messages: T[]; total: number }>,
  requestedLimit: number,
  offset = 0,
): Promise<{ messages: T[]; total: number }> {
  const limit = Math.max(1, Math.floor(requestedLimit || 50));
  const start = Math.max(0, Math.floor(offset || 0));
  let total = 0;
  const rows = new Map<string, T>();
  for (let fetched = 0; fetched < limit;) {
    const size = Math.min(500, limit - fetched);
    const page = await fetchPage(size, start + fetched);
    total = page.total;
    for (const row of page.messages) rows.set(row.id, row);
    fetched += page.messages.length;
    if (page.messages.length < size || start + fetched >= total) break;
  }
  return { messages: [...rows.values()], total };
}
