import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { IDLE_GESTURE_STATE, stepGesture } from './mobileGestureMachine.ts';
import type { GestureContext, GestureState } from './mobileGestureMachine.ts';
import { resetGestureArbitration, setRowGestureSuppressed } from './mobileGestureArbiter.ts';

export interface UseMobileDrawerGestureOptions {
  /** Mobile viewport. The gesture is desktop-inert. */
  isMobile: boolean;
  /** User preference (`mobileSidebarSwipeEnabled`). */
  enabled: boolean;
  /** Drawer visibility from the store. */
  open: boolean;
  /** Content surface the left-quarter start zone is measured against. */
  surfaceRef: RefObject<HTMLElement | null>;
  /** The sliding drawer element. */
  drawerRef: RefObject<HTMLElement | null>;
  /** Optional scrim whose opacity follows the drag. */
  backdropRef?: RefObject<HTMLElement | null>;
  onOpen: () => void;
  onClose: () => void;
  /** Changing this cancels an in-flight sequence (account/module switch). */
  resetKey?: string | number | null;
}

/**
 * Controls whose own interaction must win over the drawer even when the touch
 * starts inside the left quarter. Message rows are deliberately *not* listed:
 * they are the swipe surface the drawer must be able to claim.
 */
const IGNORE_SELECTOR = [
  'input',
  'textarea',
  'select',
  'option',
  '[contenteditable="true"]',
  '[contenteditable=""]',
  '[role="slider"]',
  '[role="dialog"]',
  '[aria-modal="true"]',
  '[data-mobile-gesture-ignore]',
  '.ProseMirror',
].join(', ');

const SETTLE_MS = 260;
const SETTLE_EASING = 'cubic-bezier(0.25,0.46,0.45,0.94)';

interface FrozenGeometry {
  surfaceLeft: number;
  surfaceWidth: number;
  /** Visual (client-space) drawer width; divided by `scale` when writing transforms. */
  drawerWidth: number;
  /** Visual-to-layout ratio from the app's `transform: scale(...)` wrapper. */
  scale: number;
}

/**
 * Owns the drawer's pointer sequence. It attaches capture-phase touch listeners
 * to the content surface so it observes the drag before a row's own listener,
 * freezes the geometry at the start of a sequence (rotation/layout changes
 * cancel instead of drifting), and writes the position straight to the drawer
 * element so pointermove never re-renders the message list.
 */
export function useMobileDrawerGesture(options: UseMobileDrawerGestureOptions): void {
  const latest = useRef(options);
  latest.current = options;

  const stateRef = useRef<GestureState>(IDLE_GESTURE_STATE);
  const geometryRef = useRef<FrozenGeometry>({ surfaceLeft: 0, surfaceWidth: 0, drawerWidth: 0, scale: 1 });
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { isMobile, enabled, resetKey, surfaceRef, drawerRef, backdropRef } = options;

  useEffect(() => {
    if (!isMobile || !enabled) return;
    const surface = surfaceRef.current;
    if (!surface) return;

    const clearSettleTimer = () => {
      if (settleTimerRef.current) {
        clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
    };

    // `drawerDx` and the frozen geometry are in visual (client) space so they
    // can be compared with clientX. The drawer lives inside the app's
    // `transform: scale(...)` wrapper, so its own transform must be written in
    // unscaled layout px — divide by the scale derived from the element.
    const writeDrawer = (drawerDxVisual: number, animate: boolean) => {
      const drawer = latest.current.drawerRef.current;
      const widthVisual = geometryRef.current.drawerWidth || drawer?.getBoundingClientRect().width || 0;
      const scale = geometryRef.current.scale || 1;
      if (!drawer || widthVisual <= 0) return;
      const widthLocal = widthVisual / scale;
      const dxLocal = drawerDxVisual / scale;
      drawer.style.transition = animate ? `transform ${SETTLE_MS}ms ${SETTLE_EASING}` : 'none';
      drawer.style.transform = `translateX(${dxLocal - widthLocal}px)`;
    };

    const writeBackdrop = (progress: number) => {
      const backdrop = latest.current.backdropRef?.current;
      if (backdrop) backdrop.style.opacity = String(Math.max(0, Math.min(1, progress)));
    };

    /**
     * Hand the element back to React.
     *
     * Restoring the value React owns matters: clearing the property looks equivalent but
     * is not, because React does not re-apply a style it has already committed. After a
     * programmatic close — a navigation click, which also fires `blur` and aborts the
     * sequence — clearing left the drawer with *no* transform, so it rendered at its
     * layout position, fully open over the page, while the state said closed.
     */
    const clearInlineStyles = () => {
      const drawer = latest.current.drawerRef.current;
      if (drawer) {
        drawer.style.transition = '';
        drawer.style.transform = latest.current.open ? 'translateX(0px)' : 'translateX(-100%)';
      }
      const backdrop = latest.current.backdropRef?.current;
      if (backdrop) backdrop.style.opacity = '';
    };

    /** Animate to the drawer's resting position and hand styling back to React. */
    const settle = (shouldBeOpen: boolean) => {
      clearSettleTimer();
      const width = geometryRef.current.drawerWidth;
      writeDrawer(shouldBeOpen ? width : 0, true);
      writeBackdrop(shouldBeOpen ? 1 : 0);
      settleTimerRef.current = setTimeout(() => {
        settleTimerRef.current = null;
        clearInlineStyles();
      }, SETTLE_MS);
    };

    const context = (): GestureContext => ({
      drawerEnabled: latest.current.enabled,
      drawerOpen: latest.current.open,
      surfaceLeft: geometryRef.current.surfaceLeft,
      surfaceWidth: geometryRef.current.surfaceWidth,
      drawerWidth: geometryRef.current.drawerWidth,
    });

    const abort = (animateBack: boolean) => {
      stateRef.current = IDLE_GESTURE_STATE;
      resetGestureArbitration();
      if (animateBack) settle(latest.current.open);
      else clearInlineStyles();
    };

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length > 1) {
        // Multi-touch (pinch) always belongs to the browser.
        abort(true);
        return;
      }
      const target = e.target as Element | null;
      if (target && typeof target.closest === 'function' && target.closest(IGNORE_SELECTOR)) {
        abort(false);
        return;
      }
      const rect = surface.getBoundingClientRect();
      const drawer = latest.current.drawerRef.current;
      const drawerRect = drawer?.getBoundingClientRect();
      const drawerLayoutWidth = drawer?.offsetWidth ?? 0;
      const scale = drawerRect && drawerLayoutWidth > 0 ? drawerRect.width / drawerLayoutWidth : 1;
      geometryRef.current = {
        surfaceLeft: rect.left,
        surfaceWidth: rect.width,
        drawerWidth: drawerRect?.width ?? rect.width,
        scale: scale > 0 ? scale : 1,
      };
      // A fresh sequence starts with no owner; the previous sequence's
      // suppression must be cleared here (the row's own touchend for the
      // previous sequence may still be pending).
      resetGestureArbitration();
      stateRef.current = IDLE_GESTURE_STATE;
      const touch = e.touches[0];
      const result = stepGesture(stateRef.current, {
        type: 'start',
        point: { x: touch.clientX, y: touch.clientY, t: e.timeStamp },
      }, context());
      stateRef.current = result.state;
    };

    const onTouchMove = (e: TouchEvent) => {
      const state = stateRef.current;
      if (state.phase !== 'pending' && state.phase !== 'owned') return;
      const touch = e.touches[0];
      if (!touch) return;
      const result = stepGesture(state, {
        type: 'move',
        point: { x: touch.clientX, y: touch.clientY, t: e.timeStamp },
      }, context());
      stateRef.current = result.state;
      const effects = result.effects;
      if (effects.rowSuppressed) setRowGestureSuppressed(true);
      if (effects.drawerDx !== undefined) {
        if (e.cancelable) e.preventDefault();
        writeDrawer(effects.drawerDx, false);
        if (effects.drawerProgress !== undefined) writeBackdrop(effects.drawerProgress);
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      const state = stateRef.current;
      if (state.phase !== 'pending' && state.phase !== 'owned') return;
      const touch = e.changedTouches[0];
      const point = touch
        ? { x: touch.clientX, y: touch.clientY, t: e.timeStamp }
        : state.last ?? { x: 0, y: 0, t: e.timeStamp };
      const result = stepGesture(state, { type: 'end', point }, context());
      stateRef.current = result.state;
      const effects = result.effects;
      if (effects.opened) {
        settle(true);
        latest.current.onOpen();
      } else if (effects.closed) {
        settle(false);
        latest.current.onClose();
      } else if (effects.settled) {
        settle(latest.current.open);
      }
      // Keep row suppression for the remainder of this sequence so the row's
      // touchend cannot execute a swipe action after the drawer owned the drag.
    };

    const onTouchCancel = () => abort(true);

    const onLayoutChange = () => {
      // Rotation, keyboard open/close and resize invalidate frozen geometry.
      if (stateRef.current.phase !== 'idle') abort(true);
    };

    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible' && stateRef.current.phase !== 'idle') abort(true);
    };

    const onBlur = () => abort(true);

    surface.addEventListener('touchstart', onTouchStart, { passive: true, capture: true });
    surface.addEventListener('touchmove', onTouchMove, { passive: false, capture: true });
    surface.addEventListener('touchend', onTouchEnd, { passive: true, capture: true });
    surface.addEventListener('touchcancel', onTouchCancel, { passive: true, capture: true });
    window.addEventListener('resize', onLayoutChange);
    window.addEventListener('orientationchange', onLayoutChange);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      surface.removeEventListener('touchstart', onTouchStart, { capture: true });
      surface.removeEventListener('touchmove', onTouchMove, { capture: true });
      surface.removeEventListener('touchend', onTouchEnd, { capture: true });
      surface.removeEventListener('touchcancel', onTouchCancel, { capture: true });
      window.removeEventListener('resize', onLayoutChange);
      window.removeEventListener('orientationchange', onLayoutChange);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      clearSettleTimer();
      clearInlineStyles();
      stateRef.current = IDLE_GESTURE_STATE;
      resetGestureArbitration();
    };
  }, [isMobile, enabled, resetKey, surfaceRef, drawerRef, backdropRef]);
}
