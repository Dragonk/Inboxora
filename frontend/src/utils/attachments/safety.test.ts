import test from 'node:test';
import assert from 'node:assert/strict';
import { setAuthEpoch } from '../authEpoch.ts';
import { acquireAttachment, clearAttachmentCache, fetchOriginalAttachment } from './fetchAttachment.ts';
import { ensurePreviewSafe, rememberSourceScan, sourceScanWarning } from './safety.ts';
const path = '/api/mail/messages/owned-message/attachments/1';

test('known scan failures survive a warned download, and raw bytes are not approved for preview', async () => {
  const original = globalThis.fetch; setAuthEpoch(950); clearAttachmentCache();
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('preview=1') || options?.method === 'POST') return Response.json({ code: 'INFECTED' }, { status: 422 });
    return new Response('Original fixture bytes', { headers: { 'x-attachment-scan': 'clean' } });
  };
  try {
    const preview = acquireAttachment(path, 950);
    await assert.rejects(preview.promise, /INFECTED/); preview.release();
    assert.equal(sourceScanWarning(path), 'INFECTED');
    const raw = await fetchOriginalAttachment(path, 950, new AbortController().signal);
    assert.equal(await raw.text(), 'Original fixture bytes');
    await assert.rejects(ensurePreviewSafe(raw, new AbortController().signal), /INFECTED/);
    assert.equal(sourceScanWarning(path), 'INFECTED');
    setAuthEpoch(951); assert.equal(sourceScanWarning(path), undefined);
    rememberSourceScan(path, 'INFECTED', 950); assert.equal(sourceScanWarning(path), undefined);
  } finally { clearAttachmentCache(); globalThis.fetch = original; }
});

test('only a fresh successful preview scan clears a remembered warning', async () => {
  const original = globalThis.fetch; setAuthEpoch(952); clearAttachmentCache();
  rememberSourceScan(path, 'SCAN_UNAVAILABLE', 952);
  globalThis.fetch = async () => new Response('Checked fixture', { headers: { 'x-attachment-scan': 'clean' } });
  try {
    const preview = acquireAttachment(path, 952); const file = await preview.promise;
    assert.equal(sourceScanWarning(path), undefined);
    assert.equal(await ensurePreviewSafe(file, new AbortController().signal), true);
    preview.release();
  } finally { clearAttachmentCache(); globalThis.fetch = original; }
});
