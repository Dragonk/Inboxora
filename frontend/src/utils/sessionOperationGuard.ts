/** Guard asynchronous UI work against supersession, unmount, and auth changes. */
export function createSessionOperationGuard(currentEpoch: () => number) {
  let generation = 0;
  let active = true;
  return {
    begin() {
      const operation = ++generation;
      const epoch = currentEpoch();
      return () => active && generation === operation && currentEpoch() === epoch;
    },
    invalidate() {
      active = false;
      generation += 1;
    },
  };
}
