import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { setAuthEpoch, getAuthEpoch } from './authEpoch.ts';
import { mailMutationStatus, mailMutationFailure } from './mailMutationOutcome.ts';
import { queueReadStateMutation, pendingReadState, isLatestReadStateMutation, resetReadStateMutationsForTest } from './readStateMutation.ts';
import { queueStarStateMutation, pendingStarState } from './starStateMutation.ts';
import { mailFlagReadbackTicket, projectMailFlagIntents } from './mailFlagIntents.ts';
import { api } from './api.ts';
const originalFetch = globalThis.fetch;
afterEach(() => { resetReadStateMutationsForTest(); globalThis.fetch = originalFetch; });
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

test('only explicit item confirmation succeeds when a response is structured', () => {
  const result = { ok: true, updated: ['yes'], pending: ['wait'], failed: ['no'] };
  assert.equal(mailMutationStatus(result, 'yes'), 'confirmed');
  assert.equal(mailMutationStatus(result, 'wait'), 'pending');
  assert.equal(mailMutationStatus(result, 'no'), 'failed');
  assert.equal(mailMutationStatus(result, 'missing'), 'pending');
  assert.equal(mailMutationStatus({ ok: true }, 'legacy'), 'confirmed');
  assert.equal(mailMutationStatus(undefined, 'missing'), 'pending');
  assert.equal(mailMutationStatus({ ok: true, outcomes: [{ id: 'no', status: 'failed' }] }, 'no'), 'failed');
  assert.equal(mailMutationStatus({ ok: true, outcomes: [{ id: 'wait', status: 'unknown' }] }, 'wait'), 'pending');
  assert.equal(mailMutationFailure(new Error('network lost')), 'pending');
  assert.equal(mailMutationFailure({ status: 403 }), 'failed');
});

test('pending read survives stale refresh and only a post-settlement readback acknowledges it', async () => {
  const read = queueReadStateMutation('copy', true, async () => ({ ok: true, pending: ['copy'] }));
  const staleTicket = mailFlagReadbackTicket();
  await read.promise;
  assert.equal(pendingReadState('copy'), true);
  assert.equal(projectMailFlagIntents([{ id: 'copy', is_read: false }])[0].is_read, true);
  projectMailFlagIntents([{ id: 'copy', is_read: true }], staleTicket);
  assert.equal(pendingReadState('copy'), true);
  projectMailFlagIntents([{ id: 'copy', is_read: true }], mailFlagReadbackTicket());
  assert.equal(pendingReadState('copy'), undefined);
});

test('confirmed writes also guard old GETs, while permanent failure releases exact server state', async () => {
  await queueReadStateMutation('yes', true, async () => ({ ok: true })).promise;
  assert.equal(pendingReadState('yes'), undefined);
  assert.equal(projectMailFlagIntents([{ id: 'yes', is_read: false }])[0].is_read, true);
  await queueReadStateMutation('yes', false, async () => ({ ok: true, failed: ['yes'] })).promise;
  assert.equal(projectMailFlagIntents([{ id: 'yes', is_read: true }])[0].is_read, true);
});

test('same-state retries remain actionable and old readback cannot acknowledge the new intent', async () => {
  await queueReadStateMutation('copy', true, async () => ({ pending: ['copy'] })).promise;
  const oldTicket = mailFlagReadbackTicket();
  let calls = 0;
  await queueReadStateMutation('copy', true, async () => { calls++; return { pending: ['copy'] }; }).promise;
  projectMailFlagIntents([{ id: 'copy', is_read: true }], oldTicket);
  assert.equal(pendingReadState('copy'), true);
  assert.equal(calls, 1);
});

test('star uncertainty survives a lost response without automatic replay', async () => {
  let calls = 0;
  const mutation = queueStarStateMutation('star', true, async () => { calls++; throw new Error('lost'); });
  await assert.rejects(mutation.promise, /lost/);
  assert.equal(calls, 1);
  assert.equal(pendingStarState('star'), true);
  assert.equal(projectMailFlagIntents([{ id: 'star', is_starred: false }])[0].is_starred, true);
});

test('logout fences running and queued requests and cannot acknowledge a later session intent', async () => {
  let release: (value: unknown) => void = () => { throw new Error('not started'); };
  const first = queueReadStateMutation('same', true, () => new Promise(resolve => { release = resolve; }));
  let calls = 0;
  const queued = queueReadStateMutation('same', false, async () => { calls++; return { ok: true }; });
  await Promise.resolve(); await Promise.resolve();
  setAuthEpoch(getAuthEpoch() + 1);
  const next = queueReadStateMutation('same', false, async () => ({ pending: ['same'] }));
  release({ ok: true });
  await first.promise; await assert.rejects(queued.promise, /expired session/); await next.promise;
  assert.equal(calls, 0);
  assert.equal(isLatestReadStateMutation('same', first.version), false);
  assert.equal(pendingReadState('same'), false);
});

test('API expansion accepts opposite authoritative readback but preserves older request fencing', async () => {
  let settle!: (response: unknown) => void;
  const write = queueReadStateMutation('a', true, () => new Promise(resolve => { settle = resolve; }));
  await Promise.resolve(); await Promise.resolve();
  let answer!: (response: Response) => void;
  globalThis.fetch = () => new Promise(resolve => { answer = resolve; });
  const older = api.getThread('thread', 'INBOX', false, 'one');
  await Promise.resolve();
  settle({ pending: ['a'] });
  await write.promise;
  answer(json({ messages: [{ id: 'a', account_id: 'one', is_read: false }, { id: 'b', account_id: 'one', is_read: false }] }));
  assert.deepEqual((await older).messages.map(row => row.is_read), [true, false]);
  globalThis.fetch = async () => json({ messages: [{ id: 'other', account_id: 'two', is_read: false }] });
  await api.getThread('other', 'INBOX', false, 'two');
  assert.equal(pendingReadState('a'), true);
  globalThis.fetch = async () => json({ messages: [{ id: 'a', account_id: 'one', is_read: false }] });
  const current = await api.getThread('thread', 'INBOX', false, 'one');
  assert.equal(current.messages[0].is_read, false);
  assert.equal(pendingReadState('a'), undefined);
});

test('an older GET cannot undo a newer readback even after pending is acknowledged', async () => {
  const oldTicket = mailFlagReadbackTicket();
  await queueReadStateMutation('copy', true, async () => ({ pending: ['copy'] })).promise;
  projectMailFlagIntents([{ id: 'copy', is_read: true }], mailFlagReadbackTicket());
  assert.equal(pendingReadState('copy'), undefined);
  assert.equal(projectMailFlagIntents([{ id: 'copy', is_read: false }], oldTicket)[0].is_read, true);
  // A genuinely later server change remains authoritative.
  assert.equal(projectMailFlagIntents([{ id: 'copy', is_read: false }], mailFlagReadbackTicket())[0].is_read, false);
});

test('a failed opposite intent restores the preceding still-pending intent', async () => {
  await queueReadStateMutation('copy', true, async () => ({ pending: ['copy'] })).promise;
  await queueReadStateMutation('copy', false, async () => ({ failed: ['copy'] })).promise;
  assert.equal(pendingReadState('copy'), true);
  assert.equal(projectMailFlagIntents([{ id: 'copy', is_read: false }])[0].is_read, true);
});

test('search readback accepts provider truth when pending read and star never landed', async () => {
  await queueReadStateMutation('search-copy', false, async () => ({ pending: ['search-copy'] })).promise;
  await queueStarStateMutation('search-copy', true, async () => ({ pending: ['search-copy'] })).promise;
  globalThis.fetch = async () => json({ messages: [{ id: 'search-copy', is_read: true, is_starred: false }] });
  const current = await api.search('fixture');
  assert.equal(current.messages[0].is_read, true);
  assert.equal(current.messages[0].is_starred, false);
  assert.equal(pendingReadState('search-copy'), undefined);
  assert.equal(pendingStarState('search-copy'), undefined);
  globalThis.fetch = async () => json({ messages: [{ id: 'search-copy', is_read: false, is_starred: true }] });
  const newer = await api.search('fixture');
  assert.equal(newer.messages[0].is_read, false);
  assert.equal(newer.messages[0].is_starred, true);
});

test('thread aggregate overlay respects category, labels and virtual archive scope', async () => {
  const { projectMailThreadRows } = await import('./mailFlagIntents.ts');
  const rows = [
    { id: 'a', account_id: 'account', folder: 'INBOX', category: 'primary', folder_paths: ['Work'], is_read: false },
    { id: 'b', account_id: 'account', folder: 'INBOX', category: 'social', is_read: false },
    { id: 'c', account_id: 'account', folder: 'INBOX', category: 'primary', is_archived: true, is_read: false },
  ];
  await queueReadStateMutation('a', true, async () => ({ pending: ['a'] })).promise;
  const parent = { ...rows[0], thread_id: 'thread', message_count: 3, unread_count: 1 };
  for (const scope of [{ folder: 'INBOX', category: 'primary' }, { folder: 'Work' }]) {
    const [result] = projectMailThreadRows([{ ...parent, _mailProjectionScope: scope }], { thread: rows });
    assert.equal(result.unread_count, 0);
  }
  const [archive] = projectMailThreadRows([{ ...parent, _mailProjectionScope: { folder: 'Archive' } }], { thread: rows });
  assert.equal(archive.unread_count, 1);
});

test('a list GET older than acknowledged expansion cannot restore a stale thread aggregate', async () => {
  const { projectMailThreadRows } = await import('./mailFlagIntents.ts');
  const old = mailFlagReadbackTicket();
  await queueReadStateMutation('a', true, async () => ({ pending: ['a'] })).promise;
  const children = projectMailFlagIntents([
    { id: 'a', account_id: 'account', folder: 'INBOX', is_read: true },
    { id: 'b', account_id: 'account', folder: 'INBOX', is_read: true },
  ], mailFlagReadbackTicket());
  const stale = { ...children[0], is_read: false, unread_count: 1, message_count: 2, thread_id: 'thread', _mailReadbackSequence: old.sequence };
  assert.equal(projectMailThreadRows([stale], { thread: children })[0].unread_count, 0);
});

test('opposite readback releases both pending and completed badge guards', async () => {
  const { setPending, setCompletedRead, pendingMarkReadMap, completedMarkReadMap } = await import('./pendingReads.ts');
  await queueReadStateMutation('readback-mismatch', true, async () => ({ pending: ['readback-mismatch'] })).promise;
  setCompletedRead('readback-mismatch', 'account');
  setPending('readback-mismatch', 'account');
  const rows = projectMailFlagIntents([{ id: 'readback-mismatch', is_read: false, unread_count: 1 }], mailFlagReadbackTicket());
  assert.equal(rows[0].is_read, false);
  assert.equal(rows[0].unread_count, 1);
  assert.equal(pendingReadState('readback-mismatch'), undefined);
  assert.equal(pendingMarkReadMap.has('readback-mismatch'), false);
  assert.equal(completedMarkReadMap.has('readback-mismatch'), false);
});

test('thread aggregate cannot acknowledge a physical intent without its physical flag', async () => {
  await queueReadStateMutation('head', true, async () => ({ pending: ['head'] })).promise;
  const aggregate = projectMailFlagIntents([{ id: 'head', message_count: 3, unread_count: 1, is_read: false }], mailFlagReadbackTicket());
  assert.equal(aggregate[0].is_read, false);
  assert.equal(pendingReadState('head'), true);
  const physical = projectMailFlagIntents([{ id: 'head', message_count: 3, unread_count: 1, is_read: false, physical_is_read: false }], mailFlagReadbackTicket());
  assert.equal(physical[0].is_read, false);
  assert.equal(physical[0].physical_is_read, false);
  assert.equal(pendingReadState('head'), undefined);
});

test('permanent and conflict item outcomes cannot be mistaken for pending', () => {
  for (const status of ['permanent', 'conflict', 'cancelled']) {
    assert.equal(mailMutationStatus({ ok: true, outcomes: [{ id: 'copy', status }] }, 'copy'), 'failed');
  }
  for (const status of ['pending', 'retryable', 'outcome_unknown', 'accepted']) {
    assert.equal(mailMutationStatus({ ok: true, outcomes: [{ id: 'copy', status }] }, 'copy'), 'pending');
  }
});

test('post-settlement list totals preserve unread children from fresh server evidence', async () => {
  const { projectMailThreadRows } = await import('./mailFlagIntents.ts');
  const children = [
    { id: 'list-head', account_id: 'account', folder: 'INBOX', is_read: true },
    { id: 'pending-child', account_id: 'account', folder: 'INBOX', is_read: false },
  ];
  let settle!: (value: unknown) => void;
  const write = queueReadStateMutation('pending-child', true, () => new Promise(resolve => { settle = resolve; }));
  await Promise.resolve(); await Promise.resolve();
  const oldTicket = mailFlagReadbackTicket();
  settle({ pending: ['pending-child'] });
  await write.promise;
  const head = { ...children[0], physical_is_read: true, thread_id: 'thread', message_count: 2, unread_count: 1, is_read: false };
  const old = projectMailThreadRows([{ ...head, _mailReadbackSequence: oldTicket.sequence }], { thread: children });
  assert.equal(old[0].unread_count, 0);
  const current = projectMailThreadRows([{ ...head, _mailReadbackSequence: mailFlagReadbackTicket().sequence }], { thread: children });
  assert.equal(current[0].unread_count, 1);
  assert.equal(current[0].is_read, false);
  assert.equal(pendingReadState('pending-child'), true, 'aggregate is not a physical confirmation');
});
