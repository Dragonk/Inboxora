import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { shouldAutosave } from './draftAutosave.js';

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
