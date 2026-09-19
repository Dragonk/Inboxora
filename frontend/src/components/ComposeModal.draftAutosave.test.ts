import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./ComposeModal.tsx', import.meta.url), 'utf8');
const draftSaveStart = source.indexOf('const doSaveDraft');
const draftSaveEnd = source.indexOf('// Compose state is local to this modal.', draftSaveStart);
const draftSave = source.slice(draftSaveStart, draftSaveEnd);

test('draft save uses its invocation snapshot as both payload and dirty baseline', () => {
  const snapshot = draftSave.indexOf('const draftSnapshot = {');
  const request = draftSave.indexOf('const result = await api.saveDraft');
  const baseline = draftSave.indexOf('initialBodyRef.current = draftSnapshot.body;');

  assert.ok(snapshot >= 0, 'draft save captures an invocation snapshot');
  assert.ok(request > snapshot, 'the request starts after capturing the snapshot');
  assert.ok(baseline > request, 'the saved baseline advances only after success');
  assert.match(draftSave, /body: draftSnapshot.body,/);
  assert.match(draftSave, /subject: draftSnapshot.subject,/);
  assert.match(draftSave, /to: draftSnapshot.to,/);
  assert.match(draftSave, /initialSubjectRef.current = draftSnapshot.subject;/);
  assert.match(draftSave, /initialToRef\.current = normalizeTo\(draftSnapshot\.to\);/);
  assert.match(draftSave, /savedAttachmentCountRef.current = draftSnapshot.attachmentCount;/);
});

test('an older draft response cannot mark a newer invocation as saved', () => {
  const version = draftSave.indexOf('version: ++draftSaveVersionRef.current');
  const guard = draftSave.indexOf('if (draftSnapshot.version !== draftSaveVersionRef.current) return;');
  const baseline = draftSave.indexOf('initialBodyRef.current = draftSnapshot.body;');

  assert.ok(version >= 0, 'each save invocation has a monotonic version');
  assert.ok(guard > version, 'responses verify their version before applying state');
  assert.ok(baseline > guard, 'a stale response cannot replace the saved baseline');
});

test('draft acknowledgement separates recipient and document edits from request order (V6-03/V6-04)', () => {
  assert.match(draftSave, /recipientRevisions: \{ \.\.\.recipientRevisionRef\.current \}/);
  assert.match(draftSave, /isDraftSnapshotCurrent\(draftSnapshot\.recipientRevisions\.to, recipientRevisionRef\.current\.to\)/);
  assert.match(draftSave, /isDraftSnapshotCurrent\(draftSnapshot\.recipientRevisions\.cc, recipientRevisionRef\.current\.cc\)/);
  assert.match(draftSave, /isDraftSnapshotCurrent\(draftSnapshot\.recipientRevisions\.bcc, recipientRevisionRef\.current\.bcc\)/);
  assert.match(draftSave, /if \(closeAfter && snapshotStillCurrent\) \{/);
});

test('draft replacement keeps the prior account, UID and folder as one request snapshot (V7-02)', () => {
  // `uidValidity` is carried when the draft has one and omitted for a provider-native draft, whose
  // identity is the provider id held server-side — requiring it here would strand every provider draft.
  assert.match(draftSave, /existingDraft: draftUid != null && draftFolder != null && draftAccountId/);
  assert.match(draftSave, /\? \{ accountId: draftAccountId, uid: draftUid, folder: draftFolder, \.\.\.\(draftUidValidity != null \? \{ uidValidity: draftUidValidity \} : \{\}\) \}/);
  assert.match(draftSave, /draftSnapshot\.existingDraft \? \{ existingDraft: draftSnapshot\.existingDraft \}/);
  assert.doesNotMatch(draftSave, /existingUid:/);
});
