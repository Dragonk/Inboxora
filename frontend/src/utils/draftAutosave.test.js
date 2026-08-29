import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { shouldAutosave, isAutosaveDue } from './draftAutosave.js';

const ready = { dirty: true, hasAccount: true, sending: false, savingDraft: false, inFlight: false, dialogOpen: false };

describe('shouldAutosave', () => {
  test('saves only when unsaved work can be safely persisted', () => {
    assert.equal(shouldAutosave(ready), true);
    for (const key of ['dirty', 'hasAccount', 'sending', 'savingDraft', 'inFlight', 'dialogOpen']) {
      const value = key === 'dirty' || key === 'hasAccount' ? false : true;
      assert.equal(shouldAutosave({ ...ready, [key]: value }), false);
    }
  });
});

describe('isAutosaveDue', () => {
  const base = { now: 100000, idleMs: 5000, maxMs: 30000, minGapMs: 15000 };
  test('saves after an idle edit period once the minimum gap has passed', () => assert.equal(isAutosaveDue({ ...base, lastEditAt: 95000, lastSaveAt: 80000 }), true));
  test('waits while active typing continues before the cap', () => assert.equal(isAutosaveDue({ ...base, lastEditAt: 99000, lastSaveAt: 80000 }), false));
  test('saves at the maximum interval during continuous typing', () => assert.equal(isAutosaveDue({ ...base, lastEditAt: 99000, lastSaveAt: 70000 }), true));
  test('enforces a minimum gap for pause-prone writers', () => assert.equal(isAutosaveDue({ ...base, lastEditAt: 92000, lastSaveAt: 90000 }), false));
  test('is safe when handed nothing', () => { assert.equal(shouldAutosave(null), false); assert.equal(isAutosaveDue(null), false); });
});
