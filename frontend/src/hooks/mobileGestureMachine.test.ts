import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_GESTURE_CONFIG,
  IDLE_GESTURE_STATE,
  decideDrawerCommit,
  isInDrawerStartZone,
  stepGesture,
} from './mobileGestureMachine.ts';
import type { GestureContext, GestureState } from './mobileGestureMachine.ts';

const SURFACE_WIDTH = 400;
const DRAWER_WIDTH = 300;

function ctx(overrides: Partial<GestureContext> = {}): GestureContext {
  return {
    drawerEnabled: true,
    drawerOpen: false,
    surfaceLeft: 0,
    surfaceWidth: SURFACE_WIDTH,
    drawerWidth: DRAWER_WIDTH,
    ...overrides,
  };
}

function start(x: number, y: number, t = 0) {
  return stepGesture(IDLE_GESTURE_STATE, { type: 'start', point: { x, y, t } }, ctx());
}

function move(state: GestureState, x: number, y: number, t = 16, context = ctx()) {
  return stepGesture(state, { type: 'move', point: { x, y, t } }, context);
}

function end(state: GestureState, x: number, y: number, t = 200, context = ctx()) {
  return stepGesture(state, { type: 'end', point: { x, y, t } }, context);
}

describe('isInDrawerStartZone', () => {
  it('treats the left quarter of the visible surface as the opening zone', () => {
    assert.equal(isInDrawerStartZone(0, 0, 400), true);
    assert.equal(isInDrawerStartZone(99.6, 0, 400), true, '24.9% is inside');
    assert.equal(isInDrawerStartZone(100, 0, 400), true, '25.0% is the inclusive boundary');
    assert.equal(isInDrawerStartZone(100.4, 0, 400), false, '25.1% is outside');
  });

  it('measures from the surface left edge, not the viewport', () => {
    assert.equal(isInDrawerStartZone(140, 100, 400), true);
    assert.equal(isInDrawerStartZone(201, 100, 400), false);
  });

  it('rejects degenerate geometry instead of claiming the gesture', () => {
    assert.equal(isInDrawerStartZone(10, 0, 0), false);
    assert.equal(isInDrawerStartZone(Number.NaN, 0, 400), false);
  });
});

describe('drawer gesture ownership', () => {
  it('claims a rightward drag that starts in the left quarter', () => {
    const s = start(60, 200).state;
    const result = move(s, 90, 202);
    assert.equal(result.state.owner, 'drawer');
    assert.equal(result.effects.rowSuppressed, true);
    assert.equal(result.effects.drawerDx, 30);
  });

  it('leaves a rightward drag outside the quarter to the row', () => {
    const s = start(300, 200).state;
    const result = move(s, 330, 202);
    assert.equal(result.state.owner, 'row');
    assert.equal(result.effects.rowSuppressed, undefined);
    assert.equal(result.effects.drawerDx, undefined);
  });

  it('leaves a leftward drag in the left quarter to the row', () => {
    const s = start(60, 200).state;
    const result = move(s, 30, 202);
    assert.equal(result.state.owner, 'row');
    assert.equal(result.effects.drawerDx, undefined);
  });

  it('lets a clear vertical drag scroll', () => {
    const s = start(60, 200).state;
    const result = move(s, 62, 260);
    assert.equal(result.state.owner, 'scroll');
    assert.equal(result.effects.rowSuppressed, true);
  });

  it('stays pending below the slop and on diagonal jitter', () => {
    const s = start(60, 200).state;
    const small = move(s, 63, 202);
    assert.equal(small.state.phase, 'pending');
    assert.equal(small.state.owner, null);
    // 10px each axis is neither dominant horizontally nor vertically at 1.25x.
    const diagonal = move(small.state, 70, 210);
    assert.equal(diagonal.state.phase, 'pending');
    assert.equal(diagonal.state.owner, null);
  });

  it('never hands ownership to another mechanism mid-sequence', () => {
    const s = start(60, 200).state;
    const claimed = move(s, 120, 202);
    assert.equal(claimed.state.owner, 'drawer');
    // Reversing direction must not archive the row.
    const reversed = move(claimed.state, 40, 202);
    assert.equal(reversed.state.owner, 'drawer');
    assert.equal(reversed.effects.drawerDx, 0, 'a reversed drawer drag clamps at closed');
  });

  it('reserves no zone when the preference is disabled', () => {
    const disabled = ctx({ drawerEnabled: false });
    const s = start(60, 200).state;
    const result = move(s, 90, 202, 16, disabled);
    assert.equal(result.state.owner, 'row');
  });
});

describe('drawer commit', () => {
  it('opens after travelling the settle fraction', () => {
    const s = start(60, 200).state;
    const dragged = move(s, 60 + DRAWER_WIDTH * 0.4, 202, 200).state;
    const result = end(dragged, 60 + DRAWER_WIDTH * 0.4, 202, 400);
    assert.equal(result.effects.opened, true);
    assert.equal(result.state.phase, 'committed');
  });

  it('opens on a short fast flick even below the fraction', () => {
    const s = start(60, 200).state;
    const dragged = move(s, 110, 202, 60).state; // 50px in 60ms ≈ 0.83 px/ms
    const result = end(dragged, 110, 202, 60);
    assert.equal(result.effects.opened, true);
  });

  it('settles back when the drag is short and slow', () => {
    const s = start(60, 200).state;
    const dragged = move(s, 80, 202, 400).state;
    const result = end(dragged, 80, 202, 800);
    assert.equal(result.effects.settled, true);
    assert.equal(result.effects.opened, undefined);
    assert.equal(result.effects.rowSuppressed, true);
  });

  it('closes an open drawer on a leftward drag', () => {
    const open = ctx({ drawerOpen: true });
    const s = start(200, 200).state;
    const dragged = move(s, 200 - DRAWER_WIDTH * 0.5, 202, 200, open).state;
    const result = end(dragged, 200 - DRAWER_WIDTH * 0.5, 202, 400, open);
    assert.equal(result.effects.closed, true);
  });

  it('does not open an already-open drawer on a rightward drag', () => {
    const open = ctx({ drawerOpen: true });
    const s = start(20, 200).state;
    const result = move(s, 90, 202, 16, open);
    assert.equal(result.state.owner, 'row');
  });

  it('reports no owner for a tap and keeps list behaviour', () => {
    const s = start(60, 200).state;
    const result = end(s, 60, 200, 120);
    assert.equal(result.state.phase, 'cancelled');
    assert.equal(result.effects.opened, undefined);
    assert.equal(result.effects.settled, undefined);
  });
});

describe('cancellation', () => {
  it('drops a sequence on pointercancel without committing', () => {
    const s = start(60, 200).state;
    const dragged = move(s, 120, 202);
    const result = stepGesture(dragged.state, { type: 'cancel' }, ctx());
    assert.equal(result.state.phase, 'cancelled');
    assert.equal(result.effects.settled, true);
    assert.equal(result.effects.opened, undefined);
  });

  it('drops a sequence when the layout changes', () => {
    const s = start(60, 200).state;
    const result = stepGesture(s, { type: 'layout-change' }, ctx());
    assert.equal(result.state.phase, 'cancelled');
    assert.equal(result.effects.drawerDx, undefined);
  });
});

describe('decideDrawerCommit', () => {
  const config = DEFAULT_GESTURE_CONFIG;

  it('is symmetric for open and close', () => {
    assert.equal(decideDrawerCommit(DRAWER_WIDTH * 0.5, 0, DRAWER_WIDTH, config), 'open');
    assert.equal(decideDrawerCommit(-DRAWER_WIDTH * 0.5, 0, DRAWER_WIDTH, config), 'close');
  });

  it('does not treat a slow short drag as a commit', () => {
    assert.equal(decideDrawerCommit(10, 0.1, DRAWER_WIDTH, config), 'settle');
  });

  it('handles degenerate widths safely', () => {
    assert.equal(decideDrawerCommit(50, 1, 0, config), 'settle');
  });
});
