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

test('stale thread refreshes and delayed retries cannot mutate a new session', () => {
  const threadRequest = source.indexOf('const data = await api.getThread');
  assert.ok(threadRequest >= 0);
  const threadGuard = source.indexOf('if (!isCurrentSession()) return;', threadRequest);
  assert.ok(threadGuard > threadRequest);
  assert.ok(source.indexOf('setThreadMessages', threadGuard) > threadGuard);
  assert.ok(source.includes('refreshTimersRef.current.forEach(clearTimeout);'));
  assert.ok(source.includes('}, [authEpoch]);'));
});
