export function createLatestRequest() {
  let sequence = 0;
  let pendingSequence: number | null = null;

  return {
    invalidate: () => { sequence += 1; pendingSequence = null; },
    isPending: () => pendingSequence === sequence,
    run: async <T>(request: () => Promise<T>, apply: (value: T) => void): Promise<boolean> => {
      const current = ++sequence;
      pendingSequence = current;
      try {
        const value = await request();
        if (current !== sequence) return false;
        apply(value);
        return true;
      } finally {
        if (pendingSequence === current) pendingSequence = null;
      }
    },
  };
}
