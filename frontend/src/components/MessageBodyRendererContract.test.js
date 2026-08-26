import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');

describe('shared message body renderer contract', () => {
  it('uses one quote-folding renderer in single-message and conversation modes', () => {
    const renderer = read('MessageBodyRenderer.jsx');
    const pane = read('MessagePane.jsx');
    const conversation = read('ConversationMessage.jsx');
    assert.match(renderer, /quoteFolding = true/);
    assert.match(renderer, /installMessageQuoteFolding/);
    assert.match(renderer, /showQuotedTextLabel/);
    assert.match(renderer, /hideQuotedTextLabel/);
    assert.match(pane, /showQuotedTextLabel=\{t\('conversation\.showQuotedText'\)\}/);
    assert.match(pane, /hideQuotedTextLabel=\{t\('conversation\.hideQuotedText'\)\}/);
    assert.match(pane, /<MessageBodyRenderer[\s\S]*?text=\{body\.text\}/);
    assert.match(conversation, /showQuotedTextLabel=\{t\('conversation\.showQuotedText'\)\}/);
    assert.match(conversation, /hideQuotedTextLabel=\{t\('conversation\.hideQuotedText'\)\}/);
    assert.doesNotMatch(conversation, /collapseQuotes/);
  });

  it('keeps forwarded-message protection and an accessible in-frame toggle', () => {
    const folding = read('messageQuoteFolding.js');
    const security = read('messageBodySecurity.js');
    assert.match(folding, /dataset\.mailflowForwardRoot/);
    assert.match(folding, /button\.type = 'button'/);
    assert.match(folding, /aria-expanded/);
    assert.match(folding, /mailflow-quote-collapsed/);
    assert.match(security, /\.mailflow-quote-collapsed \{ display: none !important; \}/);
    assert.match(security, /\.mailflow-quote-toggle:focus-visible/);
  });
});
