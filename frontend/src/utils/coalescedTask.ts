/** One in-flight operation plus one remembered follow-up; a stream cannot starve it. */
export function createCoalescedTask(
  run: () => Promise<unknown> | void,
  options: { delayMs?: number; onError?: (error: unknown) => void } = {},
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let dirty = false;
  let disposed = false;
  const delay = options.delayMs ?? 250;
  const flush = async () => {
    timer = undefined;
    if (disposed || running || !dirty) return;
    dirty = false;
    running = true;
    try { await run(); }
    catch (error) {
      try { options.onError?.(error); } catch { /* Diagnostics cannot strand the queue. */ }
    }
    finally {
      running = false;
      if (!disposed && dirty && timer === undefined) timer = setTimeout(() => { void flush(); }, delay);
    }
  };
  return {
    request(waitMs = delay) {
      if (disposed) return;
      dirty = true;
      if (!running && timer === undefined) timer = setTimeout(() => { void flush(); }, waitMs);
    },
    dispose() {
      disposed = true;
      dirty = false;
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
