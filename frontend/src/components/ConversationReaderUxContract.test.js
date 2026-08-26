import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');

describe('conversation reader final UX contract', () => {
  it('renders no body for collapsed cards and keeps quote folding inside expanded content', () => {
    const message = read('ConversationMessage.jsx');
    assert.match(message, /expanded && <div data-conversation-message-expanded-content/);
    assert.match(message, /<MessageBodyRenderer[\s\S]*?showQuotedTextLabel/);
    assert.match(message, /hideQuotedTextLabel/);
    assert.match(message, /\{body && <div className="msg-card conversation-message-body-panel"/);
  });

  it('keeps forwarded-message protection in the shared folding pipeline', () => {
    const folding = read('messageQuoteFolding.js');
    assert.match(folding, /startsWithForwardMarker/);
    assert.match(folding, /dataset\.mailflowForwardRoot/);
  });

  it('uses a white light-theme body token without forcing dark themes to white', () => {
    const css = read('../index.css');
    const message = read('ConversationMessage.jsx');
    assert.match(css, /--message-body-bg: var\(--bg-secondary\)/);
    assert.match(css, /:root\[data-mailflow-theme="light"\][\s\S]*?--message-body-bg: #ffffff/);
    assert.match(css, /:root\[data-mailflow-theme="dark"\][\s\S]*?--message-body-bg: var\(--bg-secondary\)/);
    assert.doesNotMatch(css, /:root\[data-mailflow-theme="dark"\][\s\S]*?--message-body-bg: #ffffff/);
    assert.match(message, /background: 'var\(--message-body-bg\)'/);
    assert.doesNotMatch(message, /background: '#ffffff'/);
  });
});
