/** Bounded workers with ordered results; callers own per-item error fallback. */
export async function mapConcurrent<T, R>(items: readonly T[], limit: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Concurrency must be a positive integer');
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await run(items[index]!, index);
    }
  }));
  return results;
}
