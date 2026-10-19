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


/** A temporary measurement must not shrink the outer scrollable reader.
 *
 * `scale` is the fit-to-width factor last returned by fitMessageFrameToWidth: the
 * frame height must expose the visually scaled content, not the unscaled layout,
 * so a shrunken email never leaves a block of empty space below it.
 */
export function measureMessageFrameHeight(iframe: HTMLIFrameElement, scale = 1): number | null {
  const body = iframe.contentDocument?.body;
  if (!body) return null;
  const holder = iframe.parentElement;
  const saved = holder?.style.getPropertyValue('min-height') ?? '';
  const priority = holder?.style.getPropertyPriority('min-height') ?? '';
  const previousHeight = iframe.style.height;
  if (holder) holder.style.setProperty('min-height', `${holder.getBoundingClientRect().height}px`, 'important');
  try {
    iframe.style.height = '0px';
    const effectiveScale = scale > 0 && scale <= 1 ? scale : 1;
    // A scaled body is by definition real content, so it gets its exact visual
    // height; the 300px floor only guards unscaled measurements from collapsing
    // to zero and would leave a gap below a short but wide email.
    const height = effectiveScale < 1 ? Math.round((body.scrollHeight || 0) * effectiveScale) : Math.max(300, body.scrollHeight || 0);
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

// Marker attribute recording the applied fit-to-width scale plus the body own
// inline transform declarations, so a later pass can restore the email exactly.
const FIT_MARKER = 'data-mailflow-fit-scale';

interface SavedFitTransform {
  scale: number;
  transform: string;
  transformPriority: string;
  origin: string;
  originPriority: string;
}

function readSavedFit(body: HTMLElement): SavedFitTransform | null {
  const raw = body.getAttribute(FIT_MARKER);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SavedFitTransform>;
    if (typeof parsed.scale !== 'number' || !Number.isFinite(parsed.scale) || parsed.scale <= 0 || parsed.scale > 1) return null;
    return {
      scale: parsed.scale,
      transform: typeof parsed.transform === 'string' ? parsed.transform : '',
      transformPriority: typeof parsed.transformPriority === 'string' ? parsed.transformPriority : '',
      origin: typeof parsed.origin === 'string' ? parsed.origin : '',
      originPriority: typeof parsed.originPriority === 'string' ? parsed.originPriority : '',
    };
  } catch {
    return null;
  }
}

function restoreSavedFit(body: HTMLElement, saved: SavedFitTransform): void {
  if (saved.transform) body.style.setProperty('transform', saved.transform, saved.transformPriority);
  else body.style.removeProperty('transform');
  if (saved.origin) body.style.setProperty('transform-origin', saved.origin, saved.originPriority);
  else body.style.removeProperty('transform-origin');
  body.removeAttribute(FIT_MARKER);
}

/**
 * Gmail-style shrink-to-fit for email bodies laid out wider than the frame.
 * The frame keeps its fluid width and the srcDoc CSS first gives the email a
 * chance to reflow (fluid widths, wrapping, narrow-viewport table
 * normalisation). Whatever still overflows — legacy newsletters with
 * hard-coded table-cell widths — is scaled down by a transform on the body so
 * the whole message is visible without horizontal scrolling. The scale is
 * never larger than 1: an email that fits keeps its natural size.
 *
 * The transform is applied to the frame body from the parent document (the
 * frame is sandboxed without allow-scripts), and any previous fit is rolled
 * back before measuring because a scaled-down body can report the viewport as
 * its scrollable width, hiding the real overflow. Returns the applied scale.
 */
export function fitMessageFrameToWidth(iframe: HTMLIFrameElement, enabled = true): number {
  const doc = iframe.contentDocument;
  const body = doc?.body;
  const root = doc?.documentElement;
  if (!doc || !body || !root || !enabled) return 1;
  const viewportWidth = root.clientWidth || iframe.clientWidth;
  // A collapsed or not-yet-laid-out frame cannot be fitted meaningfully;
  // leave its content at the natural size until a real measurement arrives.
  if (viewportWidth < 20) return 1;

  const previous = readSavedFit(body);
  if (previous) restoreSavedFit(body, previous);

  const contentWidth = Math.max(body.scrollWidth, root.scrollWidth);
  if (contentWidth <= viewportWidth + 1) return 1;

  const scale = Math.min(1, viewportWidth / contentWidth);
  const saved: SavedFitTransform = {
    scale,
    transform: body.style.getPropertyValue('transform'),
    transformPriority: body.style.getPropertyPriority('transform'),
    origin: body.style.getPropertyValue('transform-origin'),
    originPriority: body.style.getPropertyPriority('transform-origin'),
  };
  body.style.setProperty('transform', `scale(${Math.round(scale * 10000) / 10000})`, 'important');
  body.style.setProperty('transform-origin', 'top left', 'important');
  body.setAttribute(FIT_MARKER, JSON.stringify(saved));
  return scale;
}