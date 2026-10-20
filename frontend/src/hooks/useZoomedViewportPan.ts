import { useEffect } from 'react';
import { setVisualViewportZoomed } from './mobileGestureArbiter.ts';

// Pinch zoom on Android can leave the user zoomed into the message view with
// no way to move around: the app shell pins `overscroll-behavior: none` on the
// root scrollers (see html/body in src/index.css, which stops a browser from
// turning a row swipe into pull-to-refresh or history navigation), and on some
// WebView builds that same property also stops the root scroller from handing
// a one-finger drag over to the pinch-zoomed visual viewport - panning the
// zoomed view then requires a two-finger drag. While the visual viewport is
// zoomed in there is nothing for those browser gestures to hijack, so the
// lock is temporarily replaced with the default chaining (`auto`) and the
// stylesheet value returns as soon as the zoom is released.

const OVERSCROLL_PROPERTY = 'overscroll-behavior';
// Toggled on the root element while zoomed; the stylesheet pairs it with a
// `touch-action: auto !important` override for swipe surfaces (index.css).
const ZOOMED_CLASS = 'zoomed-viewport';
// visualViewport.scale floats around 1 at rest; tiny deviations must not
// count as a zoom.
const ZOOM_EPSILON = 0.001;

export interface OverscrollSurface {
  style: {
    setProperty(name: string, value: string, priority?: string): void;
    removeProperty(name: string): string;
  };
}

/** Narrow structural type so the helper is unit-testable with fake roots. */
export interface OverscrollRoots {
  documentElement: OverscrollSurface;
  body: OverscrollSurface;
}

/** True when a visual-viewport scale represents a pinch-zoomed state. */
export function isViewportZoomed(scale: number): boolean {
  return Number.isFinite(scale) && scale > 1 + ZOOM_EPSILON;
}

/**
 * Applies or removes the root `overscroll-behavior` override for the zoomed
 * state. Zoomed: an inline `auto` on both root scrollers beats the
 * stylesheet's `none`, letting one-finger drags pan the zoomed viewport.
 * Not zoomed: the inline property is removed so the stylesheet value - and
 * with it the pull-to-refresh and history-swipe protection - applies again.
 */
export function applyZoomedPanOverride(roots: OverscrollRoots, zoomed: boolean): void {
  for (const element of [roots.documentElement, roots.body]) {
    if (zoomed) element.style.setProperty(OVERSCROLL_PROPERTY, 'auto');
    else element.style.removeProperty(OVERSCROLL_PROPERTY);
  }
}

/**
 * Releases the root overscroll lock while the user is pinch-zoomed in. The
 * listener runs on visualViewport `resize`, which fires whenever the pinch
 * zoom factor changes.
 */
export function useZoomedViewportPan(enabled = true): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!enabled || !viewport) return;
    const sync = () => {
      const zoomed = isViewportZoomed(viewport.scale);
      applyZoomedPanOverride(
        { documentElement: document.documentElement, body: document.body },
        zoomed,
      );
      // Share the state with the mobile horizontal gestures (drawer, swipe
      // rows, pane swipe-back) so none of them claims a drag that belongs to
      // the zoomed viewport, and pair it with the CSS class whose rules relax
      // the swipe surfaces' inline `touch-action: pan-y`.
      setVisualViewportZoomed(zoomed);
      document.documentElement.classList.toggle(ZOOMED_CLASS, zoomed);
    };
    sync();
    viewport.addEventListener('resize', sync);
    return () => {
      viewport.removeEventListener('resize', sync);
      applyZoomedPanOverride(
        { documentElement: document.documentElement, body: document.body },
        false,
      );
      setVisualViewportZoomed(false);
      document.documentElement.classList.remove(ZOOMED_CLASS);
    };
  }, [enabled]);
}
