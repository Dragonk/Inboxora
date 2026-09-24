import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./ComposeModal.tsx', import.meta.url), 'utf8');

/**
 * MAIL-05: an uncertain send outcome must not lose its idempotency protection.
 *
 * The composer used to clear the key once the server answered `SEND_OUTCOME_UNKNOWN`, which turned the user's
 * next ordinary click into a fresh operation — exactly when a duplicate was most likely. The key is kept now,
 * so that click lands on the same durable intent and the server refuses to dispatch again; re-sending is a
 * separate action that names the risk and mints a new key.
 */
test('an unknown send outcome keeps its idempotency key', () => {
  const branch = source.indexOf("appError.code === 'SEND_OUTCOME_UNKNOWN'");
  assert.ok(branch >= 0, 'the SEND_OUTCOME_UNKNOWN branch is gone');
  const end = source.indexOf('} else {', branch);
  assert.ok(end > branch, 'the branch could not be delimited');
  const uncertainBranch = source.slice(branch, end);
  assert.ok(uncertainBranch.includes('sendOutcomeUnknownRef.current = true;'));
  assert.ok(!uncertainBranch.includes('idempotencyKeyRef.current = null;'), 'the key is cleared on an uncertain outcome again');
});

test('a forward uses the native forward intent even without forwarded attachments', () => {
  assert.match(source, /sendKind: composeData\?\.isForward \? 'forward'/);
  assert.doesNotMatch(source, /sendKind: fwdAttachments\.length \? 'forward'/);
});

test('re-sending is an explicit action that names the duplicate risk before a new key is minted', () => {
  const guard = source.indexOf('if (sendOutcomeUnknownRef.current) {');
  assert.ok(guard >= 0, 'the explicit re-send guard is gone');
  const setSending = source.indexOf('setSending(true);', guard);
  assert.ok(setSending > guard, 'the guard could not be delimited');
  const guardBlock = source.slice(guard, setSending);

  assert.ok(guardBlock.includes('window.confirm('), 'the re-send is not confirmed');
  assert.ok(guardBlock.includes("t('compose.sendUncertainResend')"), 'the confirmation does not name the duplicate risk');
  const confirmAt = guardBlock.indexOf('window.confirm(');
  const newKeyAt = guardBlock.indexOf('idempotencyKeyRef.current = null;');
  assert.ok(newKeyAt > confirmAt, 'the new key is minted before the user confirmed');
  assert.ok(guardBlock.includes('if (!confirmed) return;'), 'declining the confirmation does not stop the send');
});
