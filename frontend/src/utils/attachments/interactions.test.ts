import test from 'node:test';
import assert from 'node:assert/strict';
import { pdfTextIndex } from './pdfText.ts';
import { draftPreviewBlob } from './draftPreview.ts';
import { archiveFolder, type ArchiveEntry } from './archiveBrowser.ts';

test('PDF item offsets preserve Unicode and the separators used by search', () => {
  const index = pdfTextIndex([{ str: 'Before' }, { str: 'İ needle', hasEOL: true }, { str: 'after' }]);
  assert.equal(index.text, 'Before İ needle\nafter ');
  assert.deepEqual(index.segments, [{ start: 0, end: 6 }, { start: 7, end: 15 }, { start: 16, end: 21 }]);
});
test('draft previews preserve bytes and do not accept corrupt base64', async () => {
  const bytes = Buffer.from([0, 255, 13, 10, 195, 179]);
  assert.deepEqual(Buffer.from(await draftPreviewBlob(bytes.toString('base64'), 'application/pdf').arrayBuffer()), bytes);
  assert.throws(() => draftPreviewBlob('%bad%', ''), /CORRUPT/);
});
test('archive views expose immediate virtual folders, then natural file ordering', () => {
  const entry = (name: string, directory = false): ArchiveEntry => ({ name, directory, encrypted: false, size: 20 });
  const entries = [entry('photos/2.png'), entry('photos/10.png'), entry('readme.txt'), entry('photos/', true), entry('photos', true), entry('other/nested/data.txt')];
  assert.deepEqual(archiveFolder(entries, '').map(item => item.name), ['other/', 'photos/', 'readme.txt']);
  assert.deepEqual(archiveFolder(entries, 'photos/').map(item => item.name), ['photos/2.png', 'photos/10.png']);
  assert.equal(archiveFolder(entries, 'other/')[0].directory, true);
  assert.deepEqual(archiveFolder(entries, 'missing/'), []);
});

test('archive thumbnail decoding is serial and cancelled queued work never runs', async () => {
  const { withArchiveThumbnail } = await import('./archiveBrowser.ts');
  let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  const first = withArchiveThumbnail(new AbortController().signal, async () => { calls.push('first'); await hold; return 1; });
  const cancelled = new AbortController();
  const second = withArchiveThumbnail(cancelled.signal, async () => { calls.push('cancelled'); return 2; });
  const rejected = assert.rejects(second, { name: 'AbortError' });
  await Promise.resolve(); assert.deepEqual(calls, ['first']);
  cancelled.abort(); release(); assert.equal(await first, 1); await rejected;
  assert.equal(await withArchiveThumbnail(new AbortController().signal, async () => 3), 3);
  assert.deepEqual(calls, ['first']);
});
