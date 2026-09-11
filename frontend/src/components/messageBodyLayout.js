export function scheduleInitialLayoutReady(onReady, requestFrame = requestAnimationFrame, cancelFrame = cancelAnimationFrame) {
  let cancelled = false;
  const pendingFrames = new Set();
  const outerFrame = requestFrame(() => {
    pendingFrames.delete(outerFrame);
    if (cancelled) return;
    const innerFrame = requestFrame(() => {
      pendingFrames.delete(innerFrame);
      if (!cancelled) onReady();
    });
    pendingFrames.add(innerFrame);
    if (cancelled) {
      pendingFrames.delete(innerFrame);
      cancelFrame(innerFrame);
    }
  });
  pendingFrames.add(outerFrame);

  return () => {
    cancelled = true;
    for (const frame of pendingFrames) cancelFrame(frame);
    pendingFrames.clear();
  };
}
