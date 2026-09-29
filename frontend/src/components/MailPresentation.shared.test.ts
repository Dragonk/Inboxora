import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
function jsxUses(file: string, tag: string): number {
  const tree = ts.createSourceFile(file, source(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let count = 0;
  function visit(node: ts.Node) {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(tree) === tag) count++;
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return count;
}

test('both native inbox row modes and Scheduled consume the extracted row presentation', () => {
  for (const tag of ['MailRowAvatar', 'MailRowHeading', 'MailRowSubject', 'MailRowSender', 'MailRowDate']) {
    assert.equal(jsxUses('./MessageList.tsx', tag), 2, `${tag} must serve both threaded and unthreaded inbox rows`);
    assert.equal(jsxUses('./ScheduledMail.tsx', tag), 1, `${tag} must serve the queue too`);
  }
  for (const tag of ['MailListHeader', 'MailListTitle']) {
    assert.equal(jsxUses('./MessageList.tsx', tag), 1);
    assert.equal(jsxUses('./ScheduledMail.tsx', tag), 1);
  }
  assert.equal(jsxUses('./MessagePane.tsx', 'MessageHeaderCard'), 1);
  assert.equal(jsxUses('./ScheduledMail.tsx', 'MessageHeaderCard'), 1);
  assert.equal(jsxUses('./MessageToolbar.tsx', 'MessageToolbarSurface'), 1);
  assert.equal(jsxUses('./ScheduledMail.tsx', 'MessageToolbarSurface'), 1);
});

test('queue and inbox share the allocated list width and the resize handler', () => {
  for (const file of ['./MailApp.tsx', './ScheduledMail.tsx']) {
    assert.match(source(file), /mailListPanelStyle\(/);
    assert.match(source(file), /mailReaderPanelStyle/);
  }
  assert.match(source('./MailApp.tsx'), /<ScheduledMail[^>]*onListResize=\{handleListResizeMouseDown\}/);
  assert.match(source('./ScheduledMail.tsx'), /<PanelResizeHandle[^>]*onMouseDown=\{onListResize\}/);
  assert.doesNotMatch(source('./scheduledMail.css'), /max-width: 44%|width: var\(--list-width, 340px\)/);
});

test('queue preview stays read-only and uses shared attachment controls without a fabricated physical ID', () => {
  const queue = source('./ScheduledMail.tsx');
  assert.equal(jsxUses('./ScheduledMail.tsx', 'MessageBodyRenderer'), 0);
  assert.equal(jsxUses('./ScheduledMail.tsx', 'MessageDetailContent'), 2);
  assert.equal(jsxUses('./ScheduledMail.tsx', 'dl'), 0);
  assert.doesNotMatch(queue, /scheduled-attachments|api\.(markStarred|bulkRead|bulkArchive)|scheduledApi\.edit/);
  assert.match(queue, /remoteImages=\{false\} hideDownloadAll readOnly/);
  assert.match(queue, /queuedAttachmentPath\(row.id, row.revision, part\)/);
  assert.match(queue, /!editingHere && \['pending', 'editing'\]/);
  assert.match(queue, /preview.revision === row.revision/);
  assert.match(queue, /request.signal.aborted && useStore.getState\(\).authEpoch === controller.authEpoch/);
  const detail = source('./MessageDetailContent.tsx');
  assert.match(detail, /!hideDownloadAll && attachments.length > 1/);
  assert.match(detail, /downloadFailed && <p role="alert"/);
  assert.match(detail, /scope === downloadScope.current/);
  assert.match(detail, /!readOnly && canAccessCopy && physicalCopyId/);
});

test('queue keeps one selectable button per row and preserves status observers and action selectors', () => {
  const queue = source('./ScheduledMail.tsx');
  const rows = queue.slice(queue.indexOf('<ul>{controller.items.map'), queue.indexOf('})}</ul>'));
  assert.equal((rows.match(/<button\b/g) || []).length, 1);
  assert.doesNotMatch(rows, /<ToolbarButton|<Button/);
  for (const id of ['status', 'item', 'edit', 'reschedule', 'cancel', 'dismiss', 'undo']) assert.ok(queue.includes('scheduled-' + id + '-${row.id}'));
  assert.match(queue, /observeSentStatus\(element.current, \(\) => acknowledge\(row.id\)\)/);
  assert.match(queue, /data-testid="scheduled-preview"/);
  assert.match(queue, /data-testid="scheduled-back"/);
});
