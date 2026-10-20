import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyZoomedPanOverride, isViewportZoomed } from './useZoomedViewportPan.ts';
import type { OverscrollSurface } from './useZoomedViewportPan.ts';

function fakeSurface(): OverscrollSurface & { valueOf(name: string): string } {
  const store = new Map<string, string>();
  return {
    style: {
      setProperty: (name: string, value: string) => store.set(name, value),
      removeProperty: (name: string) => { store.delete(name); return ''; },
    },
    valueOf: (name: string) => store.get(name) ?? '',
  };
}

function fakeRoots() {
  return { documentElement: fakeSurface(), body: fakeSurface() };
}

describe('isViewportZoomed', () => {
  it('treats the resting scale and float noise around it as not zoomed', () => {
    assert.equal(isViewportZoomed(1), false);
    assert.equal(isViewportZoomed(1.0005), false);
    assert.equal(isViewportZoomed(0.5), false);
    assert.equal(isViewportZoomed(Number.NaN), false);
  });

  it('treats a real pinch factor as zoomed', () => {
    assert.equal(isViewportZoomed(1.05), true);
    assert.equal(isViewportZoomed(2.5), true);
  });
});

describe('applyZoomedPanOverride', () => {
  it('sets the inline overscroll-behavior override on both root scrollers while zoomed', () => {
    const roots = fakeRoots();
    applyZoomedPanOverride(roots, true);
    assert.equal(roots.documentElement.valueOf('overscroll-behavior'), 'auto');
    assert.equal(roots.body.valueOf('overscroll-behavior'), 'auto');
  });

  it('removes the inline override when the zoom is released so the stylesheet value applies again', () => {
    const roots = fakeRoots();
    applyZoomedPanOverride(roots, true);
    applyZoomedPanOverride(roots, false);
    assert.equal(roots.documentElement.valueOf('overscroll-behavior'), '');
    assert.equal(roots.body.valueOf('overscroll-behavior'), '');
  });

  it('leaves untouched roots alone when clearing a zoom that never happened', () => {
    const roots = fakeRoots();
    applyZoomedPanOverride(roots, false);
    assert.equal(roots.documentElement.valueOf('overscroll-behavior'), '');
    assert.equal(roots.body.valueOf('overscroll-behavior'), '');
  });
});
