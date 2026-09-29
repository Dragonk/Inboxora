import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMailReadBatch } from './mailReadBatch.ts';

test('batches 1201 ready physical writes with bounded request size and per-item results', async () => {
  const sent: Array<{ ids: string[]; read: boolean; accounts: string[] }> = [];
  const write = createMailReadBatch(async (ids, read, accounts) => {
    sent.push({ ids, read, accounts });
    return { updated: ids.filter(id => id !== 'm8'), pending: ids.includes('m8') ? ['m8'] : [] };
  }, () => 1);
  const responses = await Promise.all(Array.from({ length: 1201 }, (_, i) => write(`m${i}`, true, `a${i % 2}`)));
  assert.deepEqual(sent.map(request => request.ids.length), [500,500,201]);
  assert.equal(sent.flatMap(request => request.ids).length, 1201);
  assert.ok(sent.every(request => request.read && request.accounts.length === 2));
  assert.deepEqual((responses[8] as { pending: string[] }).pending, ['m8']);
});

test('limits concurrent batches and separates opposite read intentions', async () => {
  let active = 0; let high = 0;
  const sent: boolean[] = [];
  const write = createMailReadBatch(async (_ids, read) => {
    sent.push(read); active++; high = Math.max(high, active);
    await new Promise(resolve => setTimeout(resolve, 3)); active--;
    return { ok: true };
  }, () => 1, 2, 2);
  await Promise.all(Array.from({ length: 13 }, (_, i) => write(`m${i}`, Boolean(i % 2), 'a')));
  assert.equal(high, 2); assert.equal(active, 0); assert.equal(sent.length, 7);
  assert.ok(sent.includes(true) && sent.includes(false));
});

test('drops undispatched old-session items and propagates provider rejection', async () => {
  let epoch = 1; let calls = 0;
  const write = createMailReadBatch(async () => { calls++; throw new Error('provider rejected'); }, () => epoch);
  const old = write('m', true, 'a'); epoch++;
  await assert.rejects(old, { name: 'AbortError' }); assert.equal(calls, 0);
  await assert.rejects(write('m', false, 'a'), /provider rejected/); assert.equal(calls, 1);
});
