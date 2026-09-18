import test from 'node:test';
import assert from 'node:assert/strict';

import { createViewHistory, viewSnapshotFromState, viewSnapshotsEqual, VIEW_HISTORY_LIMIT } from './viewHistory.ts';
import type { ViewSnapshot, ViewSourceState } from './viewHistory.ts';

function view(partial: Partial<ViewSnapshot> = {}): ViewSnapshot {
  const base: ViewSnapshot = {
    surface: 'mail',
    messageId: null,
    messageRef: null,
    messageAccountId: null,
    accountId: null,
    folder: 'INBOX',
    adminTab: 'accounts',
  };
  return Object.assign(base, partial);
}

function source(partial: Partial<ViewSourceState> = {}): ViewSourceState {
  return {
    showContacts: false,
    showCalendar: false,
    showAdmin: false,
    selectedMessageId: null,
    selectedAccountId: null,
    selectedFolder: 'INBOX',
    adminTab: 'accounts',
    ...partial,
  };
}

test('derives one view per surface, with the Settings overlay as its own step', () => {
  assert.deepEqual(viewSnapshotFromState(source()), view());

  assert.deepEqual(
    viewSnapshotFromState(source({ showCalendar: true })),
    view({ surface: 'calendar' }),
  );
  assert.deepEqual(
    viewSnapshotFromState(source({ showContacts: true })),
    view({ surface: 'contacts' }),
  );
  // Settings is an overlay on top of a surface: it wins so opening it is a step,
  // and the surface under it stays in the store for the way back.
  assert.deepEqual(
    viewSnapshotFromState(source({ showCalendar: true, showAdmin: true, adminTab: 'notifications' })),
    view({ surface: 'settings', adminTab: 'notifications' }),
  );
});

test('captures the mail context that Back has to restore', () => {
  assert.deepEqual(
    viewSnapshotFromState(source({ selectedMessageId: 'm1', selectedAccountId: 'a1', selectedFolder: 'Sent' })),
    view({ messageId: 'm1', accountId: 'a1', folder: 'Sent' }),
  );
  // A missing folder falls back to the app default instead of an empty string.
  assert.deepEqual(viewSnapshotFromState(source({ selectedFolder: '' })).folder, 'INBOX');
});

test('compares every field that a restored view carries', () => {
  assert.equal(viewSnapshotsEqual(view(), view()), true);
  for (const changed of [
    view({ surface: 'calendar' }),
    view({ messageId: 'm1' }),
    view({ messageRef: '<stable@message.id>' }),
    view({ messageAccountId: 'a1' }),
    view({ accountId: 'a1' }),
    view({ folder: 'Sent' }),
    view({ adminTab: 'notifications' }),
  ]) {
    assert.equal(viewSnapshotsEqual(view(), changed), false);
  }
});

test('attaches the durable message reference the caller knows about', () => {
  assert.deepEqual(
    viewSnapshotFromState(source({ selectedMessageId: 'row-1' }), { ref: '<stable@message.id>', accountId: 'a1' }),
    view({ messageId: 'row-1', messageRef: '<stable@message.id>', messageAccountId: 'a1' }),
  );
  // Without a hint there is nothing durable to point at, and the row id is all the
  // history can fall back to.
  assert.deepEqual(
    viewSnapshotFromState(source({ selectedMessageId: 'row-1' })),
    view({ messageId: 'row-1', messageRef: null, messageAccountId: null }),
  );
  assert.deepEqual(viewSnapshotFromState(source()).messageRef, null);
});

test('replaceCurrent swaps the entry without moving through the history', () => {
  const history = createViewHistory(view());
  history.record(view({ messageId: 'row-1', messageRef: '<stable@message.id>' }));
  history.record(view({ surface: 'calendar' }));
  history.back();

  // The restored message resolved to a new physical row (it moved and was
  // re-created): same history step, so the entry is updated in place.
  history.replaceCurrent(view({ messageId: 'row-2', messageRef: '<stable@message.id>' }));

  assert.equal(history.size(), 3);
  assert.deepEqual(history.state(), { canGoBack: true, canGoForward: true });
  assert.deepEqual(history.current(), view({ messageId: 'row-2', messageRef: '<stable@message.id>' }));
  assert.deepEqual(history.forward(), view({ surface: 'calendar' }));
  assert.deepEqual(history.back(), view({ messageId: 'row-2', messageRef: '<stable@message.id>' }));
  // The entries around it are untouched.
  assert.deepEqual(history.back(), view());
});

test('records consecutive distinct views and reports the boundaries', () => {
  const history = createViewHistory(view());
  assert.deepEqual(history.state(), { canGoBack: false, canGoForward: false });

  history.record(view({ messageId: 'm1' }));
  assert.deepEqual(history.state(), { canGoBack: true, canGoForward: false });

  history.record(view({ surface: 'calendar' }));
  history.record(view({ surface: 'contacts' }));
  assert.equal(history.size(), 4);
  assert.deepEqual(history.state(), { canGoBack: true, canGoForward: false });
});

test('ignores a repeated view so re-renders do not fill the history', () => {
  const history = createViewHistory(view());
  history.record(view({ messageId: 'm1' }));
  history.record(view({ messageId: 'm1' }));
  history.record(view({ messageId: 'm1' }));
  assert.equal(history.size(), 2);
});

test('walks back and forward over Inboxora views, not browser documents', () => {
  const history = createViewHistory(view());
  history.record(view({ messageId: 'm1' }));       // message reader
  history.record(view({ surface: 'calendar' }));   // Calendar
  history.record(view({ surface: 'settings', adminTab: 'notifications' }));

  assert.deepEqual(history.back(), view({ surface: 'calendar' }));
  assert.deepEqual(history.back(), view({ messageId: 'm1' }));
  assert.deepEqual(history.state(), { canGoBack: true, canGoForward: true });
  assert.deepEqual(history.forward(), view({ surface: 'calendar' }));
  assert.deepEqual(history.forward(), view({ surface: 'settings', adminTab: 'notifications' }));

  // Walking past either end stops there rather than wrapping around.
  assert.deepEqual(history.back(), view({ surface: 'calendar' }));
  assert.deepEqual(history.back(), view({ messageId: 'm1' }));
  assert.deepEqual(history.back(), view());
  assert.equal(history.back(), null);
  assert.deepEqual(history.current(), view());
  assert.deepEqual(history.forward(), view({ messageId: 'm1' }));
});

test('returns null at the ends instead of wrapping around', () => {
  const history = createViewHistory(view());
  assert.equal(history.back(), null);
  assert.equal(history.forward(), null);

  history.record(view({ messageId: 'm1' }));
  assert.equal(history.forward(), null);
  assert.deepEqual(history.back(), view());
  assert.equal(history.back(), null);
  assert.deepEqual(history.forward(), view({ messageId: 'm1' }));
});

test('a new view after going back truncates the forward entries', () => {
  const history = createViewHistory(view());
  history.record(view({ messageId: 'm1' }));
  history.record(view({ surface: 'calendar' }));

  // Step back and let the restore settle (the recorder echoes the stored view).
  history.back();
  history.record(view({ messageId: 'm1' }));

  history.record(view({ surface: 'contacts' }));
  assert.deepEqual(history.state(), { canGoBack: true, canGoForward: false });
  assert.equal(history.size(), 3);
  assert.equal(history.current().surface, 'contacts');
});

test('re-recording the restored view keeps Forward available', () => {
  const history = createViewHistory(view());
  history.record(view({ folder: 'Sent' }));
  history.record(view({ surface: 'calendar' }));

  // Step back, then the store reports the same view again (the recorder's effect
  // fires after every render). Forward must survive that echo.
  const restored = history.back();
  assert.deepEqual(restored, view({ folder: 'Sent' }));
  history.record(view({ folder: 'Sent' }));

  assert.equal(history.size(), 3);
  assert.deepEqual(history.state(), { canGoBack: true, canGoForward: true });
  assert.deepEqual(history.forward(), view({ surface: 'calendar' }));
});

test('a partial restore corrects the entry instead of stranding Forward', () => {
  const history = createViewHistory(view());
  history.record(view({ messageId: 'm1' }));
  history.record(view({ surface: 'calendar' }));

  // Back to the message view, but the reader cannot resolve it any more, so the
  // store lands on the mailbox without a message open.
  history.back();
  history.record(view({ messageId: null }));

  assert.equal(history.size(), 3);
  assert.deepEqual(history.current(), view({ messageId: null }));
  assert.deepEqual(history.state(), { canGoBack: true, canGoForward: true });
  assert.deepEqual(history.forward(), view({ surface: 'calendar' }));

  // Forward again echoes the stored view, which is a no-op and clears the flag.
  history.record(view({ surface: 'calendar' }));

  // A genuine navigation after that is pushed, not folded into the entry.
  history.record(view({ surface: 'contacts' }));
  assert.equal(history.size(), 4);
  assert.equal(history.current().surface, 'contacts');
});

test('cancelPendingRestore drops a restore that changed nothing', () => {
  const build = () => {
    const history = createViewHistory(view());
    history.record(view({ messageId: 'm1' }));
    history.record(view({ surface: 'calendar' }));
    return history;
  };

  // Without the cancel, the next record is folded into the restored entry and
  // Forward is preserved...
  const folded = build();
  folded.back();
  folded.record(view({ surface: 'contacts' }));
  assert.equal(folded.size(), 3);
  assert.deepEqual(folded.state(), { canGoBack: true, canGoForward: true });

  // ...which is wrong for a real navigation, so navigateAppHistory cancels the
  // pending restore when the store did not change at all.
  const pushed = build();
  pushed.back();
  pushed.cancelPendingRestore();
  pushed.record(view({ surface: 'contacts' }));
  assert.equal(pushed.size(), 3);
  assert.equal(pushed.current().surface, 'contacts');
  assert.deepEqual(pushed.state(), { canGoBack: true, canGoForward: false });
});

test('bounds the history so a long session cannot grow without limit', () => {
  const history = createViewHistory(view(), 3);
  for (let i = 0; i < 10; i += 1) history.record(view({ messageId: `m${i}` }));
  assert.equal(history.size(), 3);
  assert.equal(history.current().messageId, 'm9');
  // The oldest entries were dropped, so Back only reaches the retained window.
  history.back();
  history.back();
  assert.equal(history.back(), null);
});

test('reset roots the history again (app re-mount after login)', () => {
  const history = createViewHistory(view());
  history.record(view({ surface: 'calendar' }));
  history.reset(view({ surface: 'mail' }));
  assert.equal(history.size(), 1);
  assert.deepEqual(history.state(), { canGoBack: false, canGoForward: false });
});

test('state() is reference-stable until availability actually changes', () => {
  const history = createViewHistory(view());
  const initial = history.state();
  assert.equal(history.state(), initial);
  history.record(view({ messageId: 'm1' }));
  assert.notEqual(history.state(), initial);
  const afterRecord = history.state();
  assert.equal(history.state(), afterRecord);
});

test('the default limit is a sane, documented bound', () => {
  assert.equal(VIEW_HISTORY_LIMIT, 60);
});
