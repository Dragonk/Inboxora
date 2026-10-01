// Run inside the built backend image. Fixtures are mounted read-only, networking is disabled.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runAttachmentWorker } from '/app/dist/services/attachments/pool.js';
const run = async (action, filename, extra = {}) => {
  const bytes = readFileSync(`/fixtures/${filename}`);
  const result = await runAttachmentWorker({ action, bytes, filename, ...extra }, new AbortController().signal);
  assert.deepEqual(readFileSync(`/fixtures/${filename}`), bytes);
  return result;
};
const signed = await run('signatures', 'signature-sample.pdf');
assert.equal(signed.json.signatures[0].integrity, 'valid');
assert.equal(signed.json.signatures[0].certificate.commonName, 'Inboxora synthetic signer');
assert.notEqual(signed.json.status, 'valid', 'An unconfigured synthetic CA must not become trusted');
const empty = await run('signatures', 'empty-signature.pdf');
assert.equal(empty.json.status, 'unknown');
for (const filename of ['archive.7z', 'archive.rar', 'sample-rar5.rar', 'archive.tar', 'archive.tar.gz', 'single.txt.gz']) {
  const index = await run('archive-index', filename);
  assert.ok(index.json.entries.length > 0, filename);
  if (filename !== 'sample-rar5.rar') {
    const item = filename === 'single.txt.gz' ? 'single.txt' : 'notes.md';
    const extracted = await run('archive-extract', filename, { entry: item, remaining: 1024 });
    assert.equal(Buffer.from(extracted.bytes).toString(), '# Archive preview\n\nSynthetic archive text.\n');
  }
}
console.log('Native image checks passed: PDF integrity, untrusted/empty signatures, 7z, RAR4/5, TAR and GZIP.');
