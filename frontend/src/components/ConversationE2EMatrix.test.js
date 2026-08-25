import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';

describe('Conversation E2E 2x2 contract', () => {
  it('maps every preference pair to mode props on the native MessageList/MessagePane', () => {
    const source = readFileSync(new URL('./MailApp.jsx', import.meta.url), 'utf8');

    // 2×2 matrix: list (grouped/flat) × reader (conversation/single)
    // All four combinations must be expressible via mode= props, not via
    // separate parallel conversation list/pane subsystem.
    const matrix = [
      { list: false, reader: false, listMode: 'flat',        readerMode: 'single' },
      { list: true,  reader: false, listMode: 'grouped',      readerMode: 'single' },
      { list: false, reader: true,  listMode: 'flat',        readerMode: 'conversation' },
      { list: true,  reader: true,  listMode: 'grouped',      readerMode: 'conversation' },
    ];
    assert.equal(matrix.length, 4);

    // MailApp MUST NOT import or render a parallel conversation subsystem
    assert.doesNotMatch(source, /import\s+ConversationList/);
    assert.doesNotMatch(source, /import\s+ConversationPane/);
    assert.doesNotMatch(source, /<ConversationList/);
    assert.doesNotMatch(source, /<ConversationPane/);

    // MailApp MUST use mode= on MessageList and MessagePane
    assert.match(source, /<MessageList\s+mode=\{/);
    assert.match(source, /<MessagePane\s+mode=\{/);

    // MessageList mode must be driven by threadedView (grouped vs flat)
    assert.match(source, /threadedView\s*\?\s*['"]grouped['"]\s*:\s*['"]flat['"]/);

    // MessagePane mode must be driven by conversationReaderViewEnabled (conversation vs single)
    assert.match(source, /conversationReaderViewEnabled\s*&&\s*conversationId\s*\?\s*['"]conversation['"]\s*:\s*['"]single['"]/);

    // Deep-link target must still be passed
    assert.match(source, /targetLogicalMessageId/);
  });
});
