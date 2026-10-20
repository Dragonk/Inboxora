import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const src = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const swipeRow = src('./useSwipeRow.ts');
const drawer = src('./useMobileDrawerGesture.ts');
const zoomHook = src('./useZoomedViewportPan.ts');
const pane = src('../components/MessagePane.tsx');
const sidebar = src('../components/Sidebar.tsx');
const floating = src('../components/FloatingWindow.tsx');
const css = src('../index.css');

const before = (haystack: string, first: string, second: string) => {
  const a = haystack.indexOf(first);
  const b = haystack.indexOf(second);
  assert.ok(a >= 0, `missing: ${first}`);
  assert.ok(b >= 0, `missing: ${second}`);
  assert.ok(a < b, `${first} must precede ${second}`);
};

// Regression contract for 4.4.3: a one-finger drag panned the pinch-zoomed
// view vertically only, because every JS gesture that reserves the X axis
// claimed the horizontal component while zoomed (pane swipe-back, swipe rows,
// the drawer capture claim) and the rows' inline `touch-action: pan-y`
// forbade the compositor's horizontal pan outright. While the viewport is
// zoomed those claimants must stand down BEFORE their preventDefault, and the
// stylesheet must override the inline touch-action so the compositor may pan
// sideways.
describe('zoomed viewport horizontal pan contract', () => {
  it('relaxes the swipe surfaces touch-action while zoomed, beating the inline style', () => {
    assert.ok(css.includes('html.zoomed-viewport [data-swipe-surface],'));
    assert.ok(css.includes('html.zoomed-viewport .mailflow-window [data-window-drag],'));
    assert.ok(css.includes('touch-action: auto !important;'));
  });

  it('marks swipe rows as surfaces and keeps a pinch startable over a row', () => {
    assert.ok(swipeRow.includes("el.style.touchAction = 'pan-y pinch-zoom';"));
    assert.ok(swipeRow.includes("el.dataset.swipeSurface = 'true';"));
    assert.ok(swipeRow.includes('delete el.dataset.swipeSurface;'));
  });

  it('gates the row swipe claim before its preventDefault while zoomed', () => {
    before(swipeRow, 'isVisualViewportZoomed()', 'e.preventDefault();');
    // touchend must not turn the end of a pan into a tap or a swipe action.
    assert.ok(swipeRow.includes('if (isVisualViewportZoomed() && s.dir) {'));
  });

  it('gates the drawer claim before its capture-phase preventDefault', () => {
    assert.ok(drawer.includes('if (isVisualViewportZoomed()) {'));
    before(drawer, 'isVisualViewportZoomed()', 'e.preventDefault();');
  });

  it('ignores the pane swipe-back sequence while zoomed before it preventDefaults', () => {
    const effect = pane.slice(pane.indexOf('Swipe-back gesture'));
    assert.ok(effect.length > 0, 'swipe-back effect not found');
    assert.ok(effect.includes('let ignored = false;'));
    before(effect, 'ignored = isVisualViewportZoomed();', 'e.preventDefault();');
    assert.ok(effect.includes('if (ignored) return;'));
  });

  it('marks the floating window drag zones as zoomed pan surfaces', () => {
    assert.ok(floating.includes('data-swipe-surface={ true }'));
  });

  it('keeps the sidebar touch preventDefault off while zoomed', () => {
    assert.ok(sidebar.includes('if (isVisualViewportZoomed()) return;'));
    assert.ok(sidebar.includes("touchAction: 'pan-y pinch-zoom',"));
  });

  it('shares the zoom state with the gestures and pairs it with the CSS class', () => {
    assert.ok(zoomHook.includes('setVisualViewportZoomed(zoomed);'));
    assert.ok(zoomHook.includes('classList.toggle(ZOOMED_CLASS, zoomed);'));
    assert.ok(zoomHook.includes('setVisualViewportZoomed(false);'));
  });
});
