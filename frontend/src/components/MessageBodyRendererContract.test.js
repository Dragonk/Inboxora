import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');

describe('shared message body renderer contract', () => {
  it('uses one quote-folding renderer in single-message and conversation modes', () => {
    const renderer = read('MessageBodyRenderer.jsx');
    const pane = read('MessagePane.jsx');
    const conversation = read('ConversationMessage.jsx');
    const detail = read('MessageDetailContent.jsx');
    assert.match(renderer, /quoteFolding = true/);
    assert.match(renderer, /installMessageQuoteFolding/);
    assert.match(renderer, /showQuotedTextLabel/);
    assert.match(renderer, /hideQuotedTextLabel/);
    assert.match(pane, /<MessageDetailContent/);
    assert.match(conversation, /<MessageDetailContent/);
    assert.match(detail, /showQuotedTextLabel=\{t\('conversation\.showQuotedText'\)\}/);
    assert.match(detail, /hideQuotedTextLabel=\{t\('conversation\.hideQuotedText'\)\}/);
    assert.match(detail, /<MessageBodyRenderer[\s\S]*?text=\{text\}/);
    assert.doesNotMatch(conversation, /collapseQuotes/);
  });

  it('folds nested reply history inside a forwarded body without exempting the whole subtree', () => {
    const folding = read('messageQuoteFolding.js');
    // The candidateElements function must NOT use an ancestor-contains filter that
    // exempts every element inside a forward root. The old isInside() helper is gone;
    // the new implementation only excludes the forward roots themselves.
    assert.doesNotMatch(folding, /function isInside\s*\(/);
    // Forward roots are excluded from the candidate set by identity, not by containment.
    assert.match(folding, /protectedSet\.has\(element\)/);
    // The forward root detection is still present so the envelope stays visible.
    assert.match(folding, /startsWithForwardMarker/);
    assert.match(folding, /protectedForwardRoots/);
    // plainTextBoundary must not bail out on a forward marker — it should continue
    // scanning so a reply marker AFTER the forwarded body is detected and folded.
    assert.doesNotMatch(folding, /if \(FORWARD_MARKER_RE\.test\(line\)\) return -1/);
  });

  it('preserves remote-image sources so blocking is reversible and the CSP admits enabled sources', () => {
    const security = read('messageBodySecurity.js');
    // When blocked, the remote src is preserved on a data attribute, not stripped.
    assert.match(security, /data-mailflow-remote-src/);
    assert.match(security, /data-mailflow-remote-blocked/);
    // When enabled, the remote src is restored from the preserved attribute.
    assert.match(security, /image\.setAttribute\('src', normalizedSrc\)/);
    // CSP switches on remoteImages: blocked excludes https:, enabled includes it.
    assert.match(security, /img-src 'self' data: cid:; style-src 'unsafe-inline'; media-src 'self' data:/);
    assert.match(security, /img-src 'self' data: cid: https:; style-src 'unsafe-inline'; media-src 'self' data:/);
  });

  it('keys conversation body state by physicalCopyId so out-of-order responses never cross messages', () => {
    const reader = read('ConversationReader.jsx');
    // Body/cache/request identity is the physical copy ID, not the logical message ID.
    assert.match(reader, /bodiesByCopy/);
    assert.match(reader, /bodyStatusByCopy/);
    assert.match(reader, /bodiesRef/);
    assert.match(reader, /statusRef/);
    // The abort controller is keyed by physicalCopyId.
    assert.match(reader, /aborters\.current\.get\(physicalCopyId\)/);
    // The body API call uses the physical copy ID, not the logical message ID.
    assert.match(reader, /api\.getMessageBody\(physicalCopyId, remoteImages\)/);
    // Old logical-keyed state is gone.
    assert.doesNotMatch(reader, /setBodies\(previous => \(\{ \.\.\.previous, \[logicalId\]/);
  });
});

describe('safe email CSS contract', () => {
  it('keeps newsletter layout styles and responsive safe style blocks', async () => {
    const { sanitizeInlineStyle, sanitizeEmailCss, buildSrcDoc } = await import('./messageBodySecurity.js');
    const inline = sanitizeInlineStyle('background-color:#f8f8f8;max-width:520px;padding:20px;border-radius:16px;font-family:Montserrat,Arial;font-size:24px;font-weight:700;line-height:1.4;color:#123456;display:none;opacity:0;overflow:hidden;background-image:url(https://cdn.example.test/thumb.jpg);background-size:cover;background-position:center');
    for (const property of ['background-color','max-width','padding','border-radius','font-family','font-size','font-weight','line-height','color','display','opacity','overflow','background-image','background-size','background-position']) assert.match(inline, new RegExp(property));
    const css = sanitizeEmailCss('.container { width: 600px; table-layout: fixed; background: #fff; } @media (max-width: 600px) { .container { width: 100%; } }');
    assert.match(css, /width: 600px/); assert.match(css, /@media/); assert.match(css, /width: 100%/);
    const doc = buildSrcDoc('<table width="600"><tr><td>newsletter</td></tr></table>');
    assert.match(doc, /@media \(max-width: 767px\) \{ table \{ width: 100% !important; max-width: 100% !important; \} \}/);
    assert.doesNotMatch(doc, /table \{[^}]*width: auto/);
    assert.doesNotMatch(doc, /a \{ color: inherit/);
  });

  it('rejects executable CSS but leaves safe remote backgrounds reversible under CSP', async () => {
    const { sanitizeInlineStyle, sanitizeEmailCss, buildSrcDoc } = await import('./messageBodySecurity.js');
    assert.equal(sanitizeInlineStyle('background-image:url(javascript:alert(1));color:red'), 'color:red');
    const css = sanitizeEmailCss('@import url(https://evil.test/x.css); .x{width:expression(alert(1));color:blue;behavior:url(x);background-image:url(vbscript:evil)}');
    assert.doesNotMatch(css, /@import|expression|behavior|vbscript/i); assert.match(css, /color:blue/);
    const blocked = buildSrcDoc('<div style="background-image:url(https://cdn.example.test/image.jpg)"></div>', { remoteImages: false });
    const enabled = buildSrcDoc('<div style="background-image:url(https://cdn.example.test/image.jpg)"></div>', { remoteImages: true });
    assert.doesNotMatch(blocked.match(/Content-Security-Policy" content="([^"]+)/)?.[1] || '', /https:/);
    assert.match(enabled.match(/Content-Security-Policy" content="([^"]+)/)?.[1] || '', /img-src[^;]*https:/);
  });
});
