import assert from 'node:assert/strict';
import { test } from 'node:test';
import { downloadMailAttachment, queuedAttachmentPath, queuedPreviewAttachments } from './mailPresentationDownloads.ts';
import { isDangerousAttachment } from '../utils/dangerousAttachment.ts';

test('queued metadata preserves ordered attachment identity and dangerous-file detection', () => {
  const attachments = queuedPreviewAttachments([
    { filename: 'report.pdf', size: 2048, contentType: 'application/pdf' },
    { filename: 'run.exe', size: 12, contentType: 'application/octet-stream' },
  ]);
  assert.deepEqual(attachments.map(item => item.part), ['0', '1']);
  assert.equal(attachments[0].type, 'application/pdf');
  assert.equal(attachments[0].size, 2048);
  assert.equal(isDangerousAttachment(attachments[1]), true);
  assert.equal(queuedAttachmentPath('queue/id?', 7, attachments[0].part), '/api/mail/scheduled/queue%2Fid%3F/attachments/0?revision=7');
  for (const part of [undefined, '', '-1', '1.0', '1/other', '9007199254740992']) {
    assert.throws(() => queuedAttachmentPath('q', 7, part), /Invalid attachment index/);
  }
});

test('binary attachment reads authenticate, retain the filename and clean up the temporary URL', async context => {
  const anchor = { href: '', download: '', click: context.mock.fn(), remove: context.mock.fn() };
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: () => anchor, body: { appendChild: context.mock.fn() },
  } });
  context.after(() => {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  });
  const fetched = context.mock.method(globalThis, 'fetch', async () => new Response('attachment bytes'));
  const created = context.mock.method(URL, 'createObjectURL', () => 'blob:attachment');
  const revoked = context.mock.method(URL, 'revokeObjectURL', () => {});
  const request = new AbortController();
  const path = queuedAttachmentPath('queued', 19, '0');
  await downloadMailAttachment(path, 'report.pdf', request.signal, () => true);
  assert.deepEqual(fetched.mock.calls[0].arguments, [path, {
    credentials: 'include', headers: { 'X-Requested-With': 'MailFlow' }, signal: request.signal,
  }]);
  assert.equal(anchor.download, 'report.pdf');
  assert.equal(anchor.href, 'blob:attachment');
  assert.equal(anchor.click.mock.callCount(), 1);
  assert.equal(anchor.remove.mock.callCount(), 1);
  assert.equal(created.mock.callCount(), 1);
  assert.deepEqual(revoked.mock.calls[0].arguments, ['blob:attachment']);
});

test('attachment conflicts reject for the shared visible error UI without retrying', async context => {
  const fetched = context.mock.method(globalThis, 'fetch', async () => new Response('revision conflict', { status: 409 }));
  await assert.rejects(downloadMailAttachment(queuedAttachmentPath('q', 2, '0'), 'file', new AbortController().signal, () => true), /download failed/);
  assert.equal(fetched.mock.callCount(), 1);
});

test('closed previews and old sessions cannot start or finish a download', async context => {
  const request = new AbortController();
  const fetched = context.mock.method(globalThis, 'fetch', async () => new Response('bytes'));
  request.abort();
  await downloadMailAttachment('/api/unused', 'file', request.signal, () => true);
  await downloadMailAttachment('/api/unused', 'file', new AbortController().signal, () => false);
  assert.equal(fetched.mock.callCount(), 0);
  const created = context.mock.method(URL, 'createObjectURL', () => { throw new Error('stale blob escaped'); });
  let current = true;
  fetched.mock.mockImplementation(async () => { current = false; return new Response('late bytes'); });
  await downloadMailAttachment('/api/attachment', 'file', new AbortController().signal, () => current);
  assert.equal(fetched.mock.callCount(), 1);
  assert.equal(created.mock.callCount(), 0);
});
