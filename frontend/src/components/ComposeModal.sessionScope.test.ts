import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./ComposeModal.tsx', import.meta.url), 'utf8');

test('compose send work is scoped to its captured auth epoch', () => {
  assert.ok(source.includes('const requestAuthEpoch = useStore.getState().authEpoch;'));
  assert.ok(source.includes('const isCurrentSession = () => useStore.getState().authEpoch === requestAuthEpoch;'));
  const sendResult = source.indexOf('const sendResult = await api.post');
  assert.ok(sendResult >= 0);
  assert.ok(source.indexOf('if (!isCurrentSession()) return;', sendResult) > sendResult);
});

test('draft saves require both their auth generation and compose instance', () => {
  const draftSave = source.indexOf('const doSaveDraft');
  assert.ok(draftSave >= 0);
  assert.ok(source.indexOf('const isCurrentComposeSession', draftSave) > draftSave);
  assert.ok(source.indexOf('if (!isCurrentComposeSession()) return;', draftSave) > draftSave);
  assert.ok(source.indexOf('if (isCurrentComposeSession()) setSavingDraft(false);', draftSave) > draftSave);
});

test('post-send refresh transfers to the session-owned manager before closing modal', () => {
  assert.ok(source.includes('postSendRefreshManager.schedule({'));
  assert.ok(!source.includes('refreshTimersRef'));
});
