import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createBackNavigation } from './backNavigation.js';

function fixture() {
  const entries = [{ external: true }, { otherState: 'preserved' }];
  let index = 1;
  let listener;
  const jobs = [];
  const history = {
    get state() { return entries[index]; },
    pushState(state) { entries.splice(++index, Infinity, state); },
    back() { jobs.push(() => { if (index > 0) { index--; listener?.(); } }); },
  };
  const nav = createBackNavigation({ history, listen: fn => { listener = fn; return () => { listener = null; }; }, schedule: fn => jobs.push(fn) });
  nav.start(); nav.setEnabled(true);
  const flush = () => { for (let n = 0; jobs.length; n++) { assert.ok(n < 40, 'history must settle'); jobs.shift()(); } };
  flush();
  return { nav, history, entries, flush, step: () => jobs.shift()(), get index() { return index; } };
}

describe('system Back layer history', () => {
  it('dismisses one top layer per gesture and permits exiting only at the root', () => {
    const f = fixture(); const closed = [];
    const reader = f.nav.register('reader', () => { closed.push('reader'); reader(); }, 10);
    const modal = f.nav.register('modal', () => { closed.push('modal'); modal(); }, 5000);
    f.flush(); assert.equal(f.index, 2);
    f.history.back(); f.flush(); assert.deepEqual(closed, ['modal']); assert.equal(f.index, 2);
    f.history.back(); f.flush(); assert.deepEqual(closed, ['modal', 'reader']); assert.equal(f.index, 1);
    f.history.back(); f.flush(); assert.equal(f.index, 0);
  });
  it('does not accumulate history after repeated close buttons and reopens', () => {
    const f = fixture();
    for (let n = 0; n < 20; n++) {
      const close = f.nav.register('reader', () => {}, 10); f.flush();
      close(); f.flush(); assert.equal(f.index, 1);
    }
    assert.equal(f.entries.length, 3);
    assert.equal(f.history.state.otherState, 'preserved');
  });
  it('does not dismiss a new view opened while a close-button history pop is pending', () => {
    const f = fixture();
    const close = f.nav.register('reader', () => {}, 10); f.flush(); close();
    let closed = false;
    // Queue registration after reconcile starts its asynchronous history traversal.
    f.step();
    f.nav.register('calendar', () => { closed = true; }, 20); f.flush();
    assert.equal(closed, false); assert.equal(f.index, 2);
  });
  it('uses LIFO within one priority and blocks navigation through busy dialogs', () => {
    const f = fixture(); const closed = [];
    f.nav.register('reader', () => closed.push('reader'), 10);
    f.nav.register('busy', () => closed.push('busy'), 4500);
    const inner = f.nav.register('inner', () => { closed.push('inner'); inner(); }, 4500);
    f.flush(); f.history.back(); f.flush(); f.history.back(); f.flush();
    assert.deepEqual(closed, ['inner', 'busy']); assert.equal(f.index, 2);
  });
  it('shares native dismissal semantics and reports an empty root as unhandled', () => {
    const f = fixture();
    const close = f.nav.register('calendar', () => close(), 20); f.flush();
    assert.equal(f.nav.back(), true); f.flush();
    assert.equal(f.nav.back(), false); assert.equal(f.index, 1);
  });
  it('removes its mobile entry when resizing to desktop without closing the reader', () => {
    const f = fixture(); let closed = false;
    f.nav.register('reader', () => { closed = true; }, 10); f.flush();
    f.nav.setEnabled(false); f.flush(); assert.equal(f.index, 1); assert.equal(closed, false);
    f.nav.setEnabled(true); f.flush(); assert.equal(f.index, 2);
  });
});
