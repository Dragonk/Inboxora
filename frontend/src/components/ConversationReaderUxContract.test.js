import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');

describe('conversation reader final UX contract', () => {
  it('renders no body for collapsed cards and keeps quote folding inside expanded content', () => {
    const message = read('ConversationMessage.jsx'); const detail = read('MessageDetailContent.jsx');
    assert.match(message, /expanded && <div data-conversation-message-expanded-content/);
    assert.match(message, /<MessageDetailContent/);
    assert.match(detail, /<MessageBodyRenderer[\s\S]*?showQuotedTextLabel/);
    assert.match(detail, /hideQuotedTextLabel/);
    assert.match(detail, /data-message-detail-body/);
  });

  it('uses native-copy read state per card and auto-reads only settled native membership', () => {
    const reader = read('ConversationReader.jsx');
    const message = read('ConversationMessage.jsx');
    assert.match(message, /data-conversation-message-subject="true"/);
    assert.match(message, /data-unread=\{String\(!\(copy\.isRead \?\? copy\.is_read\)\)\}/);
    assert.match(reader, /autoReadStarted/);
    assert.match(reader, /queueReadStateMutation\(copy\.id, true/);
    assert.match(reader, /api\.bulkRead\(\[copy\.id\], read\)/);
  });

  it('keeps forwarded-message protection in the shared folding pipeline', () => {
    const folding = read('messageQuoteFolding.js');
    assert.match(folding, /startsWithForwardMarker/);
    assert.match(folding, /dataset\.mailflowForwardRoot/);
  });

  it('uses a white light-theme body token without forcing dark themes to white', () => {
    const css = read('../index.css');
    const message = read('MessageDetailContent.jsx');
    assert.match(css, /--message-body-bg: var\(--bg-secondary\)/);
    assert.match(css, /:root\[data-mailflow-theme="light"\][\s\S]*?--message-body-bg: #ffffff/);
    assert.match(css, /:root\[data-mailflow-theme="dark"\][\s\S]*?--message-body-bg: var\(--bg-secondary\)/);
    assert.doesNotMatch(css, /:root\[data-mailflow-theme="dark"\][\s\S]*?--message-body-bg: #ffffff/);
    assert.match(message, /background: 'var\(--message-body-bg\)'/);
    assert.doesNotMatch(message, /background: '#ffffff'/);
  });
});
