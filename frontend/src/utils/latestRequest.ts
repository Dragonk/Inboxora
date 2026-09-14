export function createLatestRequest() {
  let sequence = 0;

  return {
    invalidate: () => { sequence += 1; },
    run: async <T>(request: () => Promise<T>, apply: (value: T) => void): Promise<boolean> => {
      const current = ++sequence;
      const value = await request();
      if (current !== sequence) return false;
      apply(value);
      return true;
    },
  };
}
