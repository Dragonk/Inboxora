/**
 * Pure arbitration state machine for the mobile menu (drawer) gesture.
 *
 * The drawer may only be opened by a rightward drag that *starts* inside the
 * left quarter of the visible application surface. Everything else keeps the
 * existing behaviour: row swipe actions, vertical scrolling, taps and
 * long-press. Ownership of a pointer sequence is decided once and never handed
 * to another mechanism mid-sequence, so a partially opened drawer can never
 * archive a message.
 *
 * The module is intentionally free of DOM access so the thresholds and the
 * ownership rules can be unit tested directly.
 */

export type GestureOwner = 'drawer' | 'row' | 'scroll';
export type GesturePhase = 'idle' | 'pending' | 'owned' | 'committed' | 'cancelled';

export interface GesturePoint {
  x: number;
  y: number;
  /** Event timestamp in milliseconds. */
  t: number;
}

export interface GestureConfig {
  /** Movement before an axis is chosen. */
  slopPx: number;
  /** Horizontal must exceed vertical by this factor to win the axis. */
  axisDominance: number;
  /** Fraction of the drawer width that commits an open/close drag. */
  settleFraction: number;
  /** Fast flick velocity in CSS px/ms. */
  flickVelocity: number;
  /** Minimum travel for a flick to count as a commit. */
  flickMinDistancePx: number;
  /** Share of the surface width that counts as the opening "left quarter". */
  startZoneFraction: number;
}

export const DEFAULT_GESTURE_CONFIG: GestureConfig = {
  slopPx: 8,
  axisDominance: 1.25,
  settleFraction: 0.35,
  flickVelocity: 0.5,
  flickMinDistancePx: 24,
  startZoneFraction: 0.25,
};

export interface GestureState {
  phase: GesturePhase;
  owner: GestureOwner | null;
  start: GesturePoint | null;
  last: GesturePoint | null;
  startedInDrawerZone: boolean;
}

export const IDLE_GESTURE_STATE: GestureState = Object.freeze({
  phase: 'idle',
  owner: null,
  start: null,
  last: null,
  startedInDrawerZone: false,
});

export interface GestureContext {
  /** User preference: when false the drawer reserves no gesture at all. */
  drawerEnabled: boolean;
  /** Drawer is currently open (only a leftward drag may close it). */
  drawerOpen: boolean;
  /** Visible surface rect the start zone is measured against. */
  surfaceLeft: number;
  surfaceWidth: number;
  /** Drawer width used for progress and settling. */
  drawerWidth: number;
}

export type GestureEvent =
  | { type: 'start'; point: GesturePoint }
  | { type: 'move'; point: GesturePoint }
  | { type: 'end'; point: GesturePoint }
  | { type: 'cancel' }
  | { type: 'layout-change' };

export interface GestureEffects {
  /** Current unobscured drawer offset in CSS px (>= 0). */
  drawerDx?: number;
  /** Open progress 0..1 for the backdrop/animation. */
  drawerProgress?: number;
  /** Commit: the drawer must end fully open. */
  opened?: boolean;
  /** Commit: the drawer must end fully closed. */
  closed?: boolean;
  /** A drag settled without crossing a threshold; the drawer keeps its state. */
  settled?: boolean;
  /** The row must ignore the remainder of this sequence. */
  rowSuppressed?: boolean;
}

export interface GestureStep {
  state: GestureState;
  effects: GestureEffects;
}

/**
 * The opening zone is a share of the *visible* surface, measured from its left
 * edge — the gesture starts in the left quarter, it does not travel a quarter
 * of the screen. Coordinates are raw client coordinates; the caller supplies the
 * surface rect so scaling and visual-viewport offsets cancel out.
 */
export function isInDrawerStartZone(
  startX: number,
  surfaceLeft: number,
  surfaceWidth: number,
  fraction: number = DEFAULT_GESTURE_CONFIG.startZoneFraction,
): boolean {
  if (!Number.isFinite(startX) || !Number.isFinite(surfaceLeft) || !Number.isFinite(surfaceWidth)) return false;
  if (surfaceWidth <= 0) return false;
  const relative = startX - surfaceLeft;
  return relative >= 0 && relative <= surfaceWidth * fraction;
}

function distance(a: GesturePoint, b: GesturePoint): { dx: number; dy: number } {
  return { dx: b.x - a.x, dy: b.y - a.y };
}

function velocity(dx: number, start: GesturePoint, end: GesturePoint): number {
  const dt = end.t - start.t;
  if (!Number.isFinite(dt) || dt <= 0) return 0;
  return dx / dt;
}

/**
 * Decide whether a settled drawer drag opens, closes or merely springs back.
 * A short, fast flick counts even when it did not travel the full fraction.
 */
export function decideDrawerCommit(
  dx: number,
  vx: number,
  drawerWidth: number,
  config: GestureConfig = DEFAULT_GESTURE_CONFIG,
): 'open' | 'close' | 'settle' {
  if (!Number.isFinite(dx) || drawerWidth <= 0) return 'settle';
  const settled = Math.abs(dx) >= drawerWidth * config.settleFraction;
  const flicked = Math.abs(vx) >= config.flickVelocity && Math.abs(dx) >= config.flickMinDistancePx;
  if (dx > 0) return settled || flicked ? 'open' : 'settle';
  if (dx < 0) return settled || flicked ? 'close' : 'settle';
  return 'settle';
}

/**
 * Advance the sequence. The state is replaced on every event; callers do not
 * need to reset between sequences because `start` always begins a fresh one.
 */
export function stepGesture(
  state: GestureState,
  event: GestureEvent,
  context: GestureContext,
  config: GestureConfig = DEFAULT_GESTURE_CONFIG,
): GestureStep {
  switch (event.type) {
    case 'start': {
      const startedInDrawerZone = isInDrawerStartZone(
        event.point.x,
        context.surfaceLeft,
        context.surfaceWidth,
        config.startZoneFraction,
      );
      return {
        state: {
          phase: 'pending',
          owner: null,
          start: event.point,
          last: event.point,
          startedInDrawerZone,
        },
        effects: {},
      };
    }

    case 'move': {
      if (!state.start || (state.phase !== 'pending' && state.phase !== 'owned')) {
        return { state, effects: {} };
      }

      // Once an owner is assigned it keeps the sequence until it ends.
      if (state.phase === 'owned' && state.owner) {
        return applyOwnedMove(state, event.point, context, config);
      }

      const { dx, dy } = distance(state.start, event.point);
      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);

      if (absDx < config.slopPx && absDy < config.slopPx) {
        return { state: { ...state, last: event.point }, effects: {} };
      }

      const horizontal = absDx >= config.axisDominance * absDy;
      const vertical = absDy >= config.axisDominance * absDx;
      if (!horizontal && !vertical) {
        // Jitter / diagonal: stay pending until one axis clearly wins.
        return { state: { ...state, last: event.point }, effects: {} };
      }

      if (vertical) {
        return {
          state: { ...state, phase: 'owned', owner: 'scroll', last: event.point },
          effects: { rowSuppressed: true },
        };
      }

      const drawerOwns = context.drawerOpen
        ? dx < 0
        : dx > 0 && state.startedInDrawerZone && context.drawerEnabled;
      const owner: GestureOwner = drawerOwns ? 'drawer' : 'row';
      const owned: GestureState = { ...state, phase: 'owned', owner, last: event.point };
      const applied = applyOwnedMove(owned, event.point, context, config);
      return {
        state: applied.state,
        effects: drawerOwns
          ? { ...applied.effects, rowSuppressed: true }
          : applied.effects,
      };
    }

    case 'end': {
      if (!state.start || !state.owner) {
        // Taps and gestures that never claimed an owner keep the previous behaviour.
        return { state: { ...IDLE_GESTURE_STATE, phase: 'cancelled' }, effects: {} };
      }
      if (state.owner === 'drawer') {
        const { dx } = distance(state.start, event.point);
        const vx = velocity(dx, state.start, event.point);
        const outcome = decideDrawerCommit(dx, vx, context.drawerWidth, config);
        const effects: GestureEffects =
          outcome === 'open'
            ? { opened: true, drawerDx: context.drawerWidth, drawerProgress: 1 }
            : outcome === 'close'
              ? { closed: true, drawerDx: 0, drawerProgress: 0 }
              : { settled: true, rowSuppressed: true };
        return {
          state: { ...state, phase: 'committed', last: event.point },
          effects,
        };
      }
      return { state: { ...state, phase: 'committed', last: event.point }, effects: {} };
    }

    case 'cancel':
    case 'layout-change':
      return { state: { ...IDLE_GESTURE_STATE, phase: 'cancelled' }, effects: { settled: true, rowSuppressed: true } };

    default:
      return { state, effects: {} };
  }
}

function applyOwnedMove(
  state: GestureState,
  point: GesturePoint,
  context: GestureContext,
  _config: GestureConfig,
): GestureStep {
  if (state.owner !== 'drawer' || !state.start) {
    return { state: { ...state, last: point }, effects: {} };
  }
  const { dx } = distance(state.start, point);
  const width = context.drawerWidth > 0 ? context.drawerWidth : 1;
  // Drawer offset from fully closed (0) to fully open (width). While opening the
  // sequence follows rightward travel; while open it follows leftward travel.
  const drawerDx = context.drawerOpen
    ? Math.max(0, Math.min(width, width + dx))
    : Math.max(0, Math.min(width, dx));
  return {
    state: { ...state, last: point },
    effects: { drawerDx, drawerProgress: drawerDx / width, rowSuppressed: true },
  };
}
