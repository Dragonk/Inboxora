import assert from 'node:assert/strict';
import test from 'node:test';
import { createBadgeWriter, mailIndicatorTitle } from './mailIndicators.ts';

test('title uses the authoritative unread scope and clears zero/disabled/invalid counts', () => {
  assert.equal(mailIndicatorTitle(3, true), '(3) Inboxora');
  for (const count of [0, -1, NaN, Infinity, 0.2]) assert.equal(mailIndicatorTitle(count, true), 'Inboxora');
  assert.equal(mailIndicatorTitle(42, false), 'Inboxora');
});
test('an older asynchronous badge write cannot win over a new zero', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const applied: number[] = [];
  const write = createBadgeWriter(async count => {
    if (count === 7) await gate;
    applied.push(count);
  });
  const old = write(7); const latest = write(0); release();
  await Promise.all([old, latest]);
  assert.deepEqual(applied, [7, 0]);
});
test('badge failures do not reject callers and a new value is still attempted', async () => {
  const applied: number[] = [];
  const write = createBadgeWriter(async count => { applied.push(count); throw new Error('denied'); });
  await write(1); await write(0);
  assert.deepEqual(applied, [1, 0]);
});
test('a write requested from a completion continuation is not lost', async () => {
  const applied: number[] = [];
  const write = createBadgeWriter(async count => { applied.push(count); });
  await write(2).then(() => write(0));
  assert.equal(applied.at(-1), 0);
});
