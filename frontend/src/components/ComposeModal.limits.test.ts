import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * A size refusal must leave the composer exactly as the user left it: open, with the message and every
 * attachment still there, so removing one file and pressing Send again is the whole recovery (P06).
 *
 * It must also read the server's **domain** answer rather than its English sentence — the codes are the
 * contract, and a client that matches prose breaks the moment a translator touches it.
 */

const composePath = new URL('./ComposeModal.tsx', import.meta.url);
const apiPath = new URL('../utils/api.ts', import.meta.url);
const localeDir = new URL('../locales/', import.meta.url);

test('a limit refusal is shown inline and never closes the composer or clears state', async () => {
  const source = await readFile(composePath, 'utf8');
  const start = source.indexOf('const appError = toAppError(err);');
  assert.notEqual(start, -1, 'the send failure path is missing');
  const failing = source.slice(start, start + 2600);

  // The refusal is reported through the composer's inline error, not by closing it or discarding the draft.
  assert.match(failing, /setError\(t\('compose\.limitAttachmentTooLarge'/);
  assert.match(failing, /setError\(t\('compose\.limitTooLarge'/);
  assert.doesNotMatch(failing, /handleClose\(|onClose\(|setAttachments\(\[\]\)|setAttachmentsState\(\[\]\)/);
  // Every dimension the server can name is in the branch, so no refusal falls through to raw prose.
  for (const code of [
    'ATTACHMENT_TOO_LARGE', 'ATTACHMENTS_TOO_LARGE', 'INLINE_IMAGES_TOO_LARGE', 'MESSAGE_TOO_LARGE',
    'PROVIDER_MESSAGE_TOO_LARGE', 'PROVIDER_UPLOAD_TOO_LARGE', 'REQUEST_TOO_LARGE',
  ]) {
    assert.ok(failing.includes(`'${code}'`), `${code} is not handled by the composer`);
  }
  // The figures are the server's `actualBytes`/`limitBytes`, not the removed `actual`/`limit` aliases.
  assert.match(failing, /actualBytes/);
  assert.match(failing, /limitBytes/);
  assert.doesNotMatch(failing, /figures\.actual\b/);
  assert.doesNotMatch(failing, /figures\.limit\b/);
});

test('the composer asks the server for the sending account’s limits and pre-checks a chosen file', async () => {
  const source = await readFile(composePath, 'utf8');
  assert.match(source, /api\.getSendLimits\(sendingAccountId\)/);
  // The pre-check refuses locally with the same wording, and the attachment is not added.
  const start = source.indexOf('const handleFileSelect');
  const handler = source.slice(start, source.indexOf('const handleKeyDown', start));
  assert.match(handler, /sendLimits\?\.limits\?\.singleAttachmentBytes/);
  assert.match(handler, /sendLimits\?\.limits\?\.totalAttachmentBytes/);
  assert.match(handler, /setError\(t\('compose\.limitAttachmentTooLarge'/);
  assert.match(handler, /setError\(t\('compose\.limitTooLarge'/);

  const apiSource = await readFile(apiPath, 'utf8');
  assert.match(apiSource, /getSendLimits: \(accountId: string\) => request\('GET', `\/mail\/send-limits\?accountId=\$\{encodeURIComponent\(accountId\)\}`\)/);
});

test('every locale carries the limit messages the composer asks for', async () => {
  const languages = ['en', 'de', 'es', 'fr', 'it', 'pl', 'ru', 'cs', 'zhCN'];
  const keys = ['limitAttachmentTooLarge', 'limitTooLarge', 'limitTransportSmtp', 'limitTransportGraph', 'limitTransportGmail'];
  for (const language of languages) {
    const raw = await readFile(new URL(`${language}.json`, localeDir), 'utf8');
    const messages = JSON.parse(raw) as { compose?: Record<string, string> };
    for (const key of keys) {
      const value = messages.compose?.[key];
      assert.equal(typeof value, 'string', `${language} is missing compose.${key}`);
      assert.notEqual(value?.trim(), '', `${language} has an empty compose.${key}`);
    }
    // Each message names the byte figures and the transport, so a refusal is actionable in any language.
    // Placeholder order is the translator's to choose, so the placeholders are checked as a set.
    const placeholdersOf = (value: string) => new Set(Array.from(value.matchAll(/\{(\w+)\}/g), match => match[1]));
    assert.deepEqual([...placeholdersOf(messages.compose?.limitAttachmentTooLarge ?? '')].sort(), ['actual', 'limit', 'name', 'transport']);
    assert.deepEqual([...placeholdersOf(messages.compose?.limitTooLarge ?? '')].sort(), ['actual', 'limit', 'transport']);
  }
});
