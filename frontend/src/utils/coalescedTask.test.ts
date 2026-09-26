import assert from 'node:assert/strict';
import test from 'node:test';
import { createCoalescedTask } from './coalescedTask.ts';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('coalesces a burst and does not postpone its anchored deadline', async () => {
  let calls = 0;
  const task = createCoalescedTask(() => { calls += 1; }, { delayMs: 10 });
  try {
    for (let i = 0; i < 100; i += 1) task.request();
    await sleep(40);
    assert.equal(calls, 1);
  } finally { task.dispose(); }
});
test('serializes one trailing refresh when changes arrive during a GET', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0; let active = 0; let max = 0;
  const task = createCoalescedTask(async () => {
    active += 1; max = Math.max(max, active); calls += 1;
    if (calls === 1) await gate;
    active -= 1;
  }, { delayMs: 5 });
  try {
    task.request(); await sleep(25);
    for (let i = 0; i < 50; i += 1) task.request();
    assert.equal(calls, 1);
    release(); await sleep(40);
    assert.equal(calls, 2); assert.equal(max, 1);
  } finally { release(); task.dispose(); }
});
test('dispose cancels a timer and a remembered follow-up', async () => {
  let calls = 0;
  const task = createCoalescedTask(() => { calls += 1; }, { delayMs: 10 });
  task.request(); task.dispose(); task.request();
  await sleep(30); assert.equal(calls, 0);
});
test('a failure preserves the next attempt, even if diagnostics also fails', async () => {
  let calls = 0;
  const task = createCoalescedTask(() => { calls += 1; throw new Error('offline'); }, {
    delayMs: 5, onError: () => { throw new Error('diagnostic'); },
  });
  try {
    task.request(); await sleep(25); task.request(); await sleep(25);
    assert.equal(calls, 2);
  } finally { task.dispose(); }
});
