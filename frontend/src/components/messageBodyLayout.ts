export function scheduleInitialLayoutReady(
  onReady: (value?: number) => void,
  requestFrame: (cb: FrameRequestCallback) => number = requestAnimationFrame,
  cancelFrame: (id: number) => void = cancelAnimationFrame,
) {
  let cancelled = false;
  const pendingFrames = new Set<number>();
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


/** A temporary measurement must not shrink the outer scrollable reader. */
export function measureMessageFrameHeight(iframe: HTMLIFrameElement): number | null {
  const body = iframe.contentDocument?.body;
  if (!body) return null;
  const holder = iframe.parentElement;
  const saved = holder?.style.getPropertyValue('min-height') ?? '';
  const priority = holder?.style.getPropertyPriority('min-height') ?? '';
  const previousHeight = iframe.style.height;
  if (holder) holder.style.setProperty('min-height', `${holder.getBoundingClientRect().height}px`, 'important');
  try {
    iframe.style.height = '0px';
    const height = Math.max(300, body.scrollHeight || 0);
    iframe.style.height = `${height}px`;
    return height;
  } catch (error) {
    iframe.style.height = previousHeight;
    throw error;
  } finally {
    if (holder) {
      if (saved) holder.style.setProperty('min-height', saved, priority);
      else holder.style.removeProperty('min-height');
    }
  }
}
