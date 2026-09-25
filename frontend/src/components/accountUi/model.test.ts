import assert from 'node:assert/strict';
import test from 'node:test';
import { colorValue, effectiveColor, readableText, groupState, selectGroup, reconcileSelection, sourceLabel, bookSourceId, groupBooks, featureState, syncFailed } from './model.ts';

const t = (key: string) => `translated:${key}`;

test('selecting a group is a single atomic union, not a sequence of stale toggles', () => {
  assert.deepEqual(selectGroup([], ['a', 'b', 'c'], true), ['a', 'b', 'c']);
  assert.deepEqual(selectGroup(['a', 'x'], ['a', 'b'], true), ['a', 'x', 'b']);
  assert.deepEqual(selectGroup(['a', 'b', 'x'], ['a', 'b'], false), ['x']);
});
test('an empty group is not checked', () => {
  assert.deepEqual(groupState([], []), { count: 0, total: 0, checked: false, mixed: false });
});
test('tri-state selection distinguishes none, some and all', () => {
  assert.equal(groupState(['a', 'b'], []).mixed, false);
  assert.equal(groupState(['a', 'b'], ['a']).mixed, true);
  assert.equal(groupState(['a', 'b'], ['a', 'b']).checked, true);
  assert.equal(groupState(['a', 'a'], ['a']).total, 1);
});
test('an explicit empty selection remains empty after a refresh', () => {
  const books = [{ id: 'a', visible: true }, { id: 'b', visible: false }];
  assert.deepEqual(reconcileSelection([], books), []);
  assert.deepEqual(reconcileSelection(null, books), ['a']);
  assert.deepEqual(reconcileSelection(['a', 'retired'], books), ['a']);
});
test('system source labels are semantic translations, not English API labels', () => {
  assert.equal(sourceLabel({ id: 'local', kind: 'local', label: 'My calendars' }, t), 'translated:accountUi.localCalendars');
  assert.equal(sourceLabel({ id: 'local', kind: 'local', label: 'My calendars' }, t, [], true), 'translated:accountUi.localBooks');
  assert.equal(sourceLabel({ id: 'system:contacts-birthdays', kind: 'system', label: 'Contact dates' }, t), 'translated:accountUi.contactDates');
});
test('actual user/source names are not translated by comparing their text', () => {
  assert.equal(sourceLabel({ id: 'dav1', kind: 'caldav', label: 'My calendars' }, t), 'My calendars');
  assert.equal(sourceLabel({ id: 'google:account:1', kind: 'google', accountId: '1', label: 'Google' }, t, [{ id: '1', name: 'Praca' }]), 'Praca');
});
test('different accounts at one provider stay separate even with identical labels', () => {
  const groups = groupBooks([{ id: 'a', source: 'google', account_id: 'one', name: 'Contacts' }, { id: 'b', source: 'google', account_id: 'two', name: 'Contacts' }]);
  assert.equal(groups.length, 2);
  assert.notEqual(groups[0].id, groups[1].id);
});
test('CardDAV groups use the owning integration ID instead of the first provider account', () => {
  assert.equal(bookSourceId({ id: 'book1', source: 'carddav', dav_source_id: 'source2', source_connection_id: 'link3' }), 'carddav:source:source2');
  assert.notEqual(bookSourceId({ id: 'book1', source: 'carddav' }), bookSourceId({ id: 'book2', source: 'carddav' }));
});
test('enabled is not a synonym for authorized or synchronized', () => {
  assert.equal(featureState({ enabled: true }), 'unknown');
  assert.equal(featureState({ enabled: true, authorized: false }), 'authorization');
  assert.equal(featureState({ enabled: true, authorized: true, synchronized: false }), 'pending');
  assert.equal(featureState({ enabled: true, authorized: true, synchronized: true, syncErrorCode: 'ERROR' }), 'failed');
  assert.equal(featureState({ enabled: false, authorized: true, synchronized: true }), 'off');
  assert.equal(featureState({ enabled: true, authorized: true, synchronized: true }), 'ready');
});
test('partial sync results cannot be presented as success merely because HTTP succeeded', () => {
  assert.equal(syncFailed({ state: 'success', result: { errors: ['one failed'] } }), true);
  assert.equal(syncFailed({ ok: false }), true);
  assert.equal(syncFailed({ state: 'success', result: { errors: [], created: 1 } }), false);
});
test('colors are validated and reset falls back to the source then the active theme', () => {
  assert.equal(colorValue('#AABBcc'), '#AABBcc');
  assert.equal(colorValue('url(x)'), null);
  assert.equal(effectiveColor(null, '#112233', '#35558a'), '#112233');
  assert.equal(effectiveColor(null, null, '#35558a'), '#35558a');
  assert.equal(effectiveColor('#ffffff', '#112233', '#35558a'), '#ffffff');
  assert.equal(readableText('#ffffff'), '#000000');
  assert.equal(readableText('#000000'), '#ffffff');
});
