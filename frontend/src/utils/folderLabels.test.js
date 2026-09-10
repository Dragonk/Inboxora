import { test } from 'node:test';
import assert from 'node:assert/strict';
import { folderLabel, folderRole } from './folderLabels.js';

test('system labels use server roles and configured mappings without changing paths', () => {
  const folder = { path: 'Gesendet', name: 'Gesendet', special_use: '\\Sent' };
  assert.equal(folderLabel(folder, key => key), 'mailFolders.sent');
  assert.equal(folder.path, 'Gesendet');
  assert.equal(folderRole({ path: 'Outgoing', special_use: '\\Archive' }, { sent: 'Outgoing' }), 'sent');
  assert.equal(folderRole({ path: 'INBOX' }), 'inbox');
  assert.equal(folderRole({ path: '[Gmail]/Sent Mail' }), 'sent');
  assert.equal(folderRole({ path: 'INBOX.Drafts' }), 'drafts');
  assert.equal(folderRole({ path: 'Draft' }), 'drafts');
});

test('custom folder names are not translated by substring or leaf name', () => {
  for (const path of ['Projects/Sent', 'Sent invoices', 'Draft contracts', 'My archive']) {
    assert.equal(folderRole({ path }), null);
    assert.equal(folderLabel({ path, name: 'My custom label' }, key => key), 'My custom label');
  }
});

test('labels are evaluated in the current language without cached translations', () => {
  assert.equal(folderLabel({ path: 'Sent' }, () => 'Wysłane'), 'Wysłane');
  assert.equal(folderLabel({ path: 'Sent' }, () => 'Gesendet'), 'Gesendet');
});
