import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduledApi, scheduledEditToDraft, type ScheduledEdit } from './scheduledMail.ts';

const edit: ScheduledEdit = {
  id: 'queued-1', revision: 3, state: 'editing', scheduledAt: '2030-07-01T08:30:00Z', timeZone: 'Europe/Warsaw',
  message: { accountId: 'account-1', aliasId: 'alias-1', to: ['rejected@example.test'], cc: [], bcc: [], subject: 'Retry',
    body: '<p>Body</p>', bodyIsHtml: true, editedSignature: '<p>Frozen</p>', editedSignatureIsHtml: true,
    attachments: [{ filename: 'bytes.bin', content: 'AAEC/w==', contentType: 'application/octet-stream' }],
    priority: 'high', sendKind: 'reply_all', inReplyTo: '<parent@example.test>', references: '<root@example.test>',
    replyParentMessageId: '<parent@example.test>', replyParentAccountId: 'account-1', replyToMessageId: 'physical-1' },
};
test('paused queue conversion retains snapshot bytes and recipient retry identity', () => {
  const draft = scheduledEditToDraft(edit);
  for (const [key, value] of Object.entries(edit.message)) assert.deepEqual(draft[key], value, key);
  assert.equal(draft.queuedRetryRecipients, true);
  assert.equal(draft.isReply, true); assert.equal(draft.isReplyAll, true);
  assert.deepEqual(draft.queuedMail, { id: edit.id, revision: edit.revision, scheduledAt: edit.scheduledAt, timeZone: edit.timeZone });
  assert.equal(draft.draftRowId, undefined);
});
test('enqueue retries preserve key and exact request; metadata list has abort signal', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  globalThis.fetch = async (input, options) => {
    calls.push({ url: String(input), options });
    return new Response(JSON.stringify({ id: 'queued-1' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const request = { message: edit.message, mode: 'schedule' as const, scheduledAt: edit.scheduledAt, timeZone: edit.timeZone };
    await scheduledApi.enqueue(request, 'logical-1'); await scheduledApi.enqueue(request, 'logical-1');
    assert.equal(calls[0].options?.body, calls[1].options?.body);
    assert.equal(new Headers(calls[0].options?.headers).get('X-Idempotency-Key'), 'logical-1');
    assert.equal(new Headers(calls[1].options?.headers).get('X-Idempotency-Key'), 'logical-1');
    const controller = new AbortController(); await scheduledApi.list(controller.signal);
    assert.equal(calls[2].options?.signal, controller.signal);
  } finally { globalThis.fetch = originalFetch; }
});

test('queued primary sender stays explicit even when backend omits alias', () => {
  const message = { ...edit.message }; delete message.aliasId;
  assert.equal(scheduledEditToDraft({ ...edit, message }).aliasId, null);
  assert.equal(scheduledEditToDraft(edit).aliasId, 'alias-1');
});
