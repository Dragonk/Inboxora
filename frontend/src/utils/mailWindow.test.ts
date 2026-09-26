import assert from 'node:assert/strict';
import test from 'node:test';
import { readMailWindow } from './mailWindow.ts';

test('a loaded window larger than 500 does not shrink on a background refresh', async () => {
  const data = Array.from({ length: 1200 }, (_, i) => ({ id: String(i) }));
  const calls: number[][] = [];
  const result = await readMailWindow(async (limit, offset) => {
    calls.push([limit, offset]); return { messages: data.slice(offset, offset + limit), total: data.length };
  }, 1100);
  assert.equal(result.messages.length, 1100);
  assert.deepEqual(calls, [[500, 0], [500, 500], [100, 1000]]);
});
test('paginated refresh retains its existing offset', async () => {
  const calls: number[][] = [];
  await readMailWindow(async (limit, offset) => {
    calls.push([limit, offset]); return { messages: [{ id: 'row' }], total: 151 };
  }, 50, 100);
  assert.deepEqual(calls, [[50, 100]]);
});
test('duplicate boundary rows from a changing mailbox are not inserted twice', async () => {
  const result = await readMailWindow(async (_limit, offset) => ({
    messages: offset ? [{ id: '499' }, { id: '500' }] : Array.from({ length: 500 }, (_, i) => ({ id: String(i) })),
    total: 502,
  }), 502);
  assert.equal(result.messages.length, 501);
  assert.equal(new Set(result.messages.map(row => row.id)).size, 501);
});
