import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DefaultRecipients, defaultRecipientsForSender, splitDefaultRecipients, type Recipients } from './defaultRecipients.ts';
const empty = (): Recipients => ({ to: [], cc: [], bcc: [] });
const pending = { to: '', cc: '', bcc: '' };
const a = { id: 'a', default_cc: ['cc@example.test', 'private@example.test'], default_bcc: ['private@example.test'] };
const b = { id: 'b', default_cc: ['next@example.test'], default_bcc: ['hidden@example.test'] };

test('sender defaults inherit per field and explicit empty alias arrays override the account', () => {
  const account = { ...a, aliases: [
    { id: 'inherit', default_cc: null, default_bcc: null },
    { id: 'custom', default_cc: ['alias@example.test'], default_bcc: [] },
    { id: 'cc-only', default_cc: ['only@example.test'], default_bcc: null },
  ] };
  assert.deepEqual(defaultRecipientsForSender(account, null), { id: 'account:a', default_cc: a.default_cc, default_bcc: a.default_bcc });
  assert.deepEqual(defaultRecipientsForSender(account, 'inherit'), { id: 'account:a', default_cc: a.default_cc, default_bcc: a.default_bcc });
  assert.deepEqual(defaultRecipientsForSender(account, 'custom'), { id: 'alias:custom:a', default_cc: ['alias@example.test'], default_bcc: [] });
  assert.deepEqual(defaultRecipientsForSender(account, 'cc-only'), { id: 'alias:cc-only:a', default_cc: ['only@example.test'], default_bcc: a.default_bcc });
});
test('same-account alias switches replace only automatic identity defaults and preserve manual recipients', () => {
  const account = { ...a, aliases: [{ id: 'custom', default_cc: ['alias@example.test'], default_bcc: [] }] };
  const recipients = empty();
  const owner = new DefaultRecipients(defaultRecipientsForSender(account, 'custom'), recipients);
  assert.deepEqual(recipients.cc, ['alias@example.test']);
  assert.deepEqual(recipients.bcc, []);
  recipients.to = ['manual@example.test']; owner.edit('to', recipients.to);
  const primary = owner.switchAccount(defaultRecipientsForSender(account, null), recipients, pending);
  assert.deepEqual(primary, { to: ['manual@example.test'], cc: ['cc@example.test'], bcc: ['private@example.test'] });
  const alias = owner.switchAccount(defaultRecipientsForSender(account, 'custom'), primary, pending);
  assert.deepEqual(alias, { to: ['manual@example.test'], cc: ['alias@example.test'], bcc: [] });
});

test('settings split comma/semicolon, preserve malformed values for authoritative server validation, and clear', () => {
  assert.deepEqual(splitDefaultRecipients(' A@example.test ; b@example.test, '), ['A@example.test', 'b@example.test']);
  assert.deepEqual(splitDefaultRecipients(''), []);
  assert.deepEqual(splitDefaultRecipients('Name <a@example.test>'), ['Name <a@example.test>']);
});
for (const mode of ['new', 'reply', 'reply-all', 'forward']) {
  test(`${mode}: defaults are visible with BCC priority; authored display-name duplicates stay intact`, () => {
    const recipients = { to: ['"Name, Person" <CC@EXAMPLE.TEST>'], cc: ['authored@example.test'], bcc: [] };
    new DefaultRecipients(a, recipients, false, mode === 'reply-all');
    assert.deepEqual(recipients, { to: ['"Name, Person" <CC@EXAMPLE.TEST>'], cc: ['authored@example.test'], bcc: ['private@example.test'] });
  });
}
test('switch removes only untouched defaults, preserves edited/re-added/moved chips and pending inputs', () => {
  const recipients = empty(); const owner = new DefaultRecipients(a, recipients);
  owner.edit('cc', []); recipients.cc = [];
  owner.edit('to', ['CC@EXAMPLE.TEST']); recipients.to = ['CC@EXAMPLE.TEST'];
  owner.edit('bcc', []); recipients.bcc = [];
  owner.edit('bcc', ['private@example.test']); recipients.bcc = ['private@example.test'];
  const next = owner.switchAccount(b, recipients, { ...pending, cc: 'Next <NEXT@example.test>' });
  assert.deepEqual(next, { to: ['CC@EXAMPLE.TEST'], cc: [], bcc: ['private@example.test', 'hidden@example.test'] });
});
test('untouched defaults alone are removed on switch; same account refresh/alias preserves removals', () => {
  const recipients = empty(); const owner = new DefaultRecipients(a, recipients);
  recipients.cc = []; owner.edit('cc', []);
  assert.equal(owner.switchAccount({ ...a, default_cc: ['changed@example.test'] }, recipients, pending), recipients);
  assert.deepEqual(recipients, { to: [], cc: [], bcc: ['private@example.test'] });
  assert.deepEqual(owner.switchAccount(b, recipients, pending), { to: [], cc: ['next@example.test'], bcc: ['hidden@example.test'] });
});
test('pending raw addresses across every field prevent new automatic duplicates', () => {
  for (const field of ['to', 'cc', 'bcc']) {
    const recipients = empty(); const owner = new DefaultRecipients(a, recipients);
    const result = owner.switchAccount(b, recipients, { ...pending, [field]: '"Last, First" <NEXT@example.test>; HIDDEN@example.test' });
    assert.deepEqual(result, empty());
  }
});
test('restored draft is exact, saved chips manual even after deliberate account switch', () => {
  const recipients = { to: ['Recipient <r@example.test>'], cc: [], bcc: ['private@example.test'] };
  const owner = new DefaultRecipients(a, recipients, true, true);
  assert.deepEqual(recipients, { to: ['Recipient <r@example.test>'], cc: [], bcc: ['private@example.test'] });
  assert.equal(owner.switchAccount(a, recipients, pending), recipients);
  assert.deepEqual(owner.switchAccount(b, recipients, pending), { to: ['Recipient <r@example.test>'], cc: ['next@example.test'], bcc: ['private@example.test', 'hidden@example.test'] });
});
test('reply toggles retain defaults, manual recipients and pending input; removed defaults stay removed', () => {
  const recipients = { to: ['sender@example.test'], cc: ['thread@example.test'], bcc: [] };
  const owner = new DefaultRecipients(a, recipients, false, true);
  let next = owner.switchReply(false, [], recipients, pending);
  assert.deepEqual(next.cc, ['cc@example.test']); assert.deepEqual(next.bcc, ['private@example.test']);
  owner.edit('cc', ['manual@example.test']); next.cc = ['manual@example.test'];
  next = owner.switchReply(true, ['thread@example.test', 'cc@example.test', 'private@example.test', 'pending@example.test'], next, { ...pending, to: 'pending@example.test' });
  assert.deepEqual(next.cc, ['manual@example.test', 'thread@example.test']);
  next = owner.switchReply(false, [], next, pending);
  assert.deepEqual(next.cc, ['manual@example.test']); assert.deepEqual(next.bcc, ['private@example.test']);
});
test('partial send retry edits never trigger reinjection on refresh or alias change', () => {
  const recipients = empty(); const owner = new DefaultRecipients(a, recipients);
  owner.edit('bcc', []); recipients.bcc = [];
  owner.edit('cc', []); recipients.cc = [];
  assert.deepEqual(owner.switchAccount({ ...a }, recipients, pending), empty());
});

test('a manually added recipient displaces only its automatic duplicate in another field', () => {
  const recipients = empty(); const owner = new DefaultRecipients(a, recipients);
  const next = owner.editRecipients('to', ['Private <PRIVATE@example.test>'], recipients);
  assert.deepEqual(next, { to: ['Private <PRIVATE@example.test>'], cc: ['cc@example.test'], bcc: [] });
  assert.deepEqual(owner.switchAccount(b, next, pending), {
    to: ['Private <PRIVATE@example.test>'], cc: ['next@example.test'], bcc: ['hidden@example.test'],
  });
});
test('retyping an automatic chip in its own field makes the remaining occurrence manual', () => {
  const recipients = empty(); const owner = new DefaultRecipients(a, recipients);
  const next = owner.editRecipients('cc', ['cc@example.test', 'cc@example.test'], recipients);
  assert.deepEqual(next.cc, ['cc@example.test']);
  assert.deepEqual(owner.switchAccount(b, next, pending).cc, ['cc@example.test', 'next@example.test']);
});
test('an original Reply All recipient overlapping a default survives a switch to Reply', () => {
  const recipients = { to: ['sender@example.test'], cc: ['cc@example.test', 'thread@example.test'], bcc: [] };
  const owner = new DefaultRecipients(a, recipients, false, true);
  const before = structuredClone(recipients);
  const next = owner.switchReply(false, [], recipients, pending);
  assert.deepEqual(next, { to: ['sender@example.test'], cc: ['cc@example.test'], bcc: ['private@example.test'] });
  assert.deepEqual(recipients, before, 'reply transition does not mutate the previous React state');
});
test('a removed original Reply All recipient matching a default is not restored on toggle', () => {
  const recipients = { to: ['sender@example.test'], cc: ['cc@example.test'], bcc: [] };
  const owner = new DefaultRecipients(a, recipients, false, true);
  const edited = owner.editRecipients('cc', [], recipients);
  assert.deepEqual(owner.switchReply(false, [], edited, pending).cc, []);
});

test('reply toggles in a restored draft never reinstate account defaults', () => {
  const recipients = { to: ['sender@example.test'], cc: [], bcc: [] };
  const owner = new DefaultRecipients(a, recipients, true);
  let next = owner.switchReply(true, ['cc@example.test'], recipients, pending);
  next = owner.switchReply(false, [], next, pending);
  assert.deepEqual(next, recipients);
});
test('a default shadowed by To is not reintroduced after a partial send retry', () => {
  const recipients = { to: ['cc@example.test'], cc: [], bcc: [] };
  const owner = new DefaultRecipients(a, recipients);
  let next = owner.editRecipients('to', [], recipients);
  next = owner.editRecipients('bcc', [], next);
  assert.deepEqual(owner.switchReply(false, [], next, pending), empty());
});
test('uncommitted raw input displaces an automatic duplicate before keyboard send', () => {
  for (const field of ['to', 'cc', 'bcc'] as const) {
    const recipients = empty(); const owner = new DefaultRecipients(a, recipients);
    const next = owner.editPending(field, 'Person <PRIVATE@example.test>', recipients);
    assert.deepEqual(next, { to: [], cc: ['cc@example.test'], bcc: [] });
    assert.deepEqual(owner.editPending(field, '', next), next);
  }
});

test('confirmed partial-delivery targets become manual across repeated account and reply-mode changes', () => {
  const recipients = { to: ['accepted@example.test'], cc: ['thread@example.test'], bcc: [] };
  const owner = new DefaultRecipients(a, recipients, false, true);
  owner.enterRetryMode();
  let retry = owner.editRecipients('to', [], recipients);
  retry = owner.editRecipients('cc', ['cc@example.test'], retry);
  retry = owner.editRecipients('bcc', ['private@example.test'], retry);
  const expected = { to: [], cc: ['cc@example.test'], bcc: ['private@example.test'] };
  for (const account of [b, a, b]) {
    retry = owner.switchAccount(account, retry, pending);
    assert.deepEqual(retry, expected);
    for (const all of [true, false]) {
      retry = owner.switchReply(all, ['accepted@example.test', 'thread@example.test'], retry, pending);
      assert.deepEqual(retry, expected);
    }
  }
});
test('retry recipients remain explicitly editable without regaining automatic ownership', () => {
  const recipients = empty(); const owner = new DefaultRecipients(a, recipients);
  owner.enterRetryMode();
  let retry = owner.editRecipients('cc', [], recipients);
  retry = owner.editRecipients('bcc', ['private@example.test', 'manual@example.test'], retry);
  retry = owner.editRecipients('to', ['cc@example.test'], retry);
  const expected = { to: ['cc@example.test'], cc: [], bcc: ['private@example.test', 'manual@example.test'] };
  owner.enterRetryMode(); // another partial response must not reset the recovery policy
  assert.deepEqual(owner.switchAccount(b, retry, { ...pending, cc: 'pending@example.test' }), expected);
  assert.deepEqual(owner.editPending('cc', 'private@example.test', retry), expected);
});
test('a partial response with no identifiable rejected recipients cannot seed a new retry destination', () => {
  const recipients = empty(); const owner = new DefaultRecipients(a, recipients);
  owner.enterRetryMode();
  assert.deepEqual(owner.switchAccount(b, empty(), pending), empty());
  assert.deepEqual(owner.switchReply(true, ['accepted@example.test'], empty(), pending), empty());
});
