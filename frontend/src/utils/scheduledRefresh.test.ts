import test from 'node:test';
import assert from 'node:assert/strict';
import { createScheduledRefresh } from './scheduledRefresh.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test('polls coalesce while slow read still applies before next request', async () => {
  const first = deferred<string>(); const second = deferred<string>();
  let loads = 0; const applied: string[] = [];
  const reader = createScheduledRefresh({ load: () => ++loads === 1 ? first.promise : second.promise,
    apply: value => applied.push(value), failed: () => assert.fail('unexpected failure'), current: () => true });
  reader.refresh(); reader.refresh(); reader.refresh();
  assert.equal(loads, 1);
  first.resolve('first'); await settle();
  assert.deepEqual(applied, ['first']); assert.equal(loads, 2);
  second.resolve('second'); await settle();
  assert.deepEqual(applied, ['first', 'second']); assert.equal(loads, 2);
});
test('mutation invalidation fences earlier reads and session end drops pending refresh', async () => {
  const first = deferred<string>(); const second = deferred<string>();
  let loads = 0; let current = true; const applied: string[] = [];
  const reader = createScheduledRefresh({ load: () => ++loads === 1 ? first.promise : second.promise,
    apply: value => applied.push(value), failed: () => assert.fail('unexpected failure'), current: () => current });
  reader.refresh(); reader.invalidate(); reader.refresh();
  first.resolve('before mutation'); await settle();
  assert.deepEqual(applied, []); assert.equal(loads, 2);
  reader.refresh(); current = false;
  second.resolve('old session'); await settle();
  assert.deepEqual(applied, []); assert.equal(loads, 2);
});

test('completion fence rejects a read started during a mutation', async () => {
  const duringWrite = deferred<string>(); const afterWrite = deferred<string>();
  let loads = 0; const applied: string[] = [];
  const reader = createScheduledRefresh({ load: () => ++loads === 1 ? duringWrite.promise : afterWrite.promise,
    apply: value => applied.push(value), failed: () => assert.fail('unexpected failure'), current: () => true });
  reader.invalidate(); // write begins
  reader.refresh(); // polling reads before the server commits
  reader.invalidate(); reader.refresh(); // completion refresh fences the pre-commit read
  duringWrite.resolve('pre-commit'); await settle();
  assert.deepEqual(applied, []); assert.equal(loads, 2);
  afterWrite.resolve('committed'); await settle();
  assert.deepEqual(applied, ['committed']);
});
