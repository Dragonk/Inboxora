import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { shouldAutosave, isAutosaveDue } from './draftAutosave.js';

const ready = {
  dirty: true, hasAccount: true,
  sending: false, savingDraft: false, inFlight: false, dialogOpen: false,
};

describe('shouldAutosave', () => {
  test('saves when there are unsaved changes and nothing else is happening', () => {
    assert.equal(shouldAutosave(ready), true);
  });

  test('does nothing when the compose is untouched', () => {
    assert.equal(shouldAutosave({ ...ready, dirty: false }), false);
  });

  test('does nothing before a From account resolves (the server requires one)', () => {
    assert.equal(shouldAutosave({ ...ready, hasAccount: false }), false);
  });

  test('never writes while a send is in progress', () => {
    // Appending around the moment the message leaves can strand a copy in Drafts.
    assert.equal(shouldAutosave({ ...ready, sending: true }), false);
  });

  test('never overlaps a manual save already in progress', () => {
    assert.equal(shouldAutosave({ ...ready, savingDraft: true }), false);
  });

  test('inFlight blocks even when savingDraft state has not committed yet', () => {
    // savingDraft is React state and lags a tick; inFlight is the synchronous guard that
    // closes the window where two saves could both append and both claim the uid.
    assert.equal(shouldAutosave({ ...ready, savingDraft: false, inFlight: true }), false);
  });

  test('holds off while a close or discard prompt is open', () => {
    // Those dialogs render different text and buttons based on isDirty(); saving underneath
    // would change the question the user is answering.
    assert.equal(shouldAutosave({ ...ready, dialogOpen: true }), false);
  });

  test('is safe when handed nothing', () => {
    assert.equal(shouldAutosave(null), false);
    assert.equal(shouldAutosave(undefined), false);
  });

  test('every blocking condition wins on its own, even all together', () => {
    for (const k of ['sending', 'savingDraft', 'inFlight', 'dialogOpen']) {
      assert.equal(shouldAutosave({ ...ready, [k]: true }), false, `${k} should block`);
    }
    assert.equal(shouldAutosave({
      dirty: true, hasAccount: true,
      sending: true, savingDraft: true, inFlight: true, dialogOpen: true,
    }), false);
  });
});

describe('isAutosaveDue', () => {
  const base = { now: 100000, idleMs: 5000, maxMs: 30000, minGapMs: 15000 };

  test('saves once typing has paused for the idle period', () => {
    assert.equal(isAutosaveDue({ ...base, lastEditAt: 100000 - 5000, lastSaveAt: 100000 - 20000 }), true);
  });

  test('holds off while the user is still typing', () => {
    // Edited 1s ago and saved 2s ago: neither threshold reached.
    assert.equal(isAutosaveDue({ ...base, lastEditAt: 100000 - 1000, lastSaveAt: 100000 - 2000 }), false);
  });

  test('saves anyway once maxMs passes, even during continuous typing', () => {
    // Still typing (edited 1s ago) but nothing saved for 30s.
    assert.equal(isAutosaveDue({ ...base, lastEditAt: 100000 - 1000, lastSaveAt: 100000 - 30000 }), true);
  });

  test('does not fire repeatedly right after a save while typing continues', () => {
    assert.equal(isAutosaveDue({ ...base, lastEditAt: 100000 - 500, lastSaveAt: 100000 - 100 }), false);
  });

  test('idle threshold is inclusive at the boundary', () => {
    assert.equal(isAutosaveDue({ ...base, lastEditAt: 100000 - 4999, lastSaveAt: 100000 - 20000 }), false);
    assert.equal(isAutosaveDue({ ...base, lastEditAt: 100000 - 5000, lastSaveAt: 100000 - 20000 }), true);
  });

  test('floor stops a pause-prone writer triggering a save after every pause', () => {
    // Idle long enough, but only 10s since the last save: below the 15s floor.
    assert.equal(isAutosaveDue({ ...base, lastEditAt: 100000 - 8000, lastSaveAt: 100000 - 10000 }), false);
  });

  test('the cap overrides the floor, so a dirty compose is never left too long', () => {
    assert.equal(isAutosaveDue({ ...base, lastEditAt: 100000 - 1000, lastSaveAt: 100000 - 30000 }), true);
  });

  test('is safe when handed nothing', () => {
    assert.equal(isAutosaveDue(null), false);
  });
});
