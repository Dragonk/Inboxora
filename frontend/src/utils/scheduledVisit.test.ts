import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeScheduledVisit } from './scheduledVisit.ts';
import type { ScheduledSummary, ScheduledState } from './scheduledMail.ts';

const row = (id: string, state: ScheduledState): ScheduledSummary => ({
  id, state, accountId: 'owner-account', mode: 'schedule', subject: id, scheduledAt: '2020-01-01T12:00:00Z',
  timeZone: 'UTC', revision: 1, errorCode: null,
});
test('an overnight sent result stays for the visit after acknowledgement and repeated refreshes', () => {
  const sent = row('overnight', 'sent');
  let visit = mergeScheduledVisit([], [sent]);
  for (let poll = 0; poll < 10; poll++) visit = mergeScheduledVisit(visit, []);
  assert.deepEqual(visit, [sent]);
  // Only a new visit starts from an empty retained set and the fresh owner response.
  assert.deepEqual(mergeScheduledVisit([], []), []);
});
test('a pending row becoming sent remains after this or another tab acknowledges it', () => {
  let visit = mergeScheduledVisit([], [row('night', 'pending')]);
  visit = mergeScheduledVisit(visit, [row('night', 'sent')]);
  assert.deepEqual(mergeScheduledVisit(visit, []), [row('night', 'sent')]);
});
test('retention never turns another delivery state into a seen sent result', () => {
  const states: ScheduledState[] = ['pending', 'editing', 'preparing', 'sending', 'failed', 'partial', 'uncertain', 'cancelled', 'dismissed'];
  const fresh = states.map(state => row(state, state));
  const visit = mergeScheduledVisit([], fresh);
  assert.equal(visit.length, states.length - 1);
  assert.deepEqual(new Set(visit.map(value => value.state)), new Set(states.filter(state => state !== 'cancelled')));
  assert.deepEqual(mergeScheduledVisit(visit, []), []);
});
test('fresh revisions win, sent pins deduplicate, and active mail sorts before history', () => {
  const sent = row('sent', 'sent'); const pending = row('pending', 'pending');
  const updated = { ...pending, revision: 3, subject: 'Changed' };
  assert.deepEqual(mergeScheduledVisit([sent, pending], [updated, sent, sent]), [updated, sent]);
});
test('a new owner/visit cannot inherit private rows from the previous retention set', () => {
  const old = mergeScheduledVisit([], [row('private-old-owner', 'sent')]);
  assert.equal(old.length, 1);
  assert.deepEqual(mergeScheduledVisit([], [row('new-owner', 'pending')]), [row('new-owner', 'pending')]);
});

test('cancelled rows disappear on receipt or read while sent and dismissed history keep their own rules', () => {
  const pending = row('cancel-me', 'pending');
  const sent = row('sent', 'sent'); const dismissed = row('dismissed', 'dismissed');
  assert.deepEqual(mergeScheduledVisit([pending, sent], [row('cancel-me', 'cancelled'), dismissed]), [sent, dismissed]);
  assert.deepEqual(mergeScheduledVisit([pending, sent], [pending], new Set(['cancel-me'])), [sent]);
  assert.deepEqual(mergeScheduledVisit([], [row('cancel-me', 'cancelled')]), []);
});
