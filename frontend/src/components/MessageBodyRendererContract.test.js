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

describe('mail body surface contract', () => {
  const surface = tone => ({ tone, background: '#1a1e25', foreground: '#e8e6df' });
  // The declarations the renderer injected for the frame's own colours. Note that
  // `background-color:` itself ends in `color:`, so the check has to look at the
  // captured declarations rather than at the rendered stylesheet.
  const surfaceDeclarations = doc =>
    doc.match(/html, body \{([^}]*)\}/)?.[1] ?? '';

  it('declares a dark frame surface so unstyled mail is not black on dark', async () => {
    const { buildSrcDoc } = await import('./messageBodySecurity.js');
    const doc = buildSrcDoc('<p>hello</p>', { surface: surface('dark') });
    // The frame, not the operating system, decides the colour scheme...
    assert.match(doc, /<meta name="color-scheme" content="dark">/);
    assert.match(doc, /html \{ color-scheme: dark; \}/);
    // ...and the surface is stated rather than inherited from the user agent.
    assert.match(surfaceDeclarations(doc), /background-color: #1a1e25;/);
    assert.match(surfaceDeclarations(doc), /color: #e8e6df;/);
  });

  it('only fixes the colour scheme on the light frame, leaving the surface alone', async () => {
    const { buildSrcDoc } = await import('./messageBodySecurity.js');
    const doc = buildSrcDoc('<p>hello</p>', { surface: surface('light') });
    assert.match(doc, /<meta name="color-scheme" content="light">/);
    assert.match(doc, /html \{ color-scheme: light; \}/);
    // The light appearance has always inherited the panel behind the frame, which
    // already paints the theme surface. Declaring it here would switch text rendering
    // to subpixel antialiasing and churn every committed light-mode capture.
    assert.doesNotMatch(doc, /html, body \{/);
    assert.doesNotMatch(doc, /background-color: #1a1e25/);
  });

  it('emits no surface rule when no surface is supplied', async () => {
    const { buildSrcDoc } = await import('./messageBodySecurity.js');
    const doc = buildSrcDoc('<p>hello</p>');
    assert.doesNotMatch(doc, /name="color-scheme"/);
    assert.doesNotMatch(doc, /color-scheme:/);
  });

  it('refuses a value that is not a plain CSS colour', async () => {
    const { buildSrcDoc } = await import('./messageBodySecurity.js');
    const doc = buildSrcDoc('<p>hello</p>', {
      surface: { tone: 'dark', background: 'red; } body { display: none', foreground: 'url(https://evil.test/x)' },
    });
    // Both declarations are dropped, so nothing is injected rather than the injected
    // rule being closed early by the hand-written value.
    assert.doesNotMatch(doc, /background-color: red/);
    assert.doesNotMatch(doc, /evil\.test/);
    assert.doesNotMatch(doc, /html, body \{/);
    // The tone is still trusted, so the frame stays on the requested scheme.
    assert.match(doc, /html \{ color-scheme: dark; \}/);
  });

  it('keeps the valid half of a partially malformed surface', async () => {
    const { buildSrcDoc } = await import('./messageBodySecurity.js');
    const doc = buildSrcDoc('<p>hello</p>', {
      surface: { tone: 'dark', background: '#1a1e25', foreground: 'javascript:alert(1)' },
    });
    assert.match(surfaceDeclarations(doc), /background-color: #1a1e25;/);
    assert.doesNotMatch(doc, /javascript/);
    // No stray `color:` declaration is emitted for the rejected foreground. The check
    // must not be fooled by `background-color:` ending in `color:`.
    assert.doesNotMatch(surfaceDeclarations(doc), /(?:^|[\s;])color:/);
  });

  it('keeps the dark canvas for a message that brings its own light design', async () => {
    const { buildSrcDoc } = await import('./messageBodySecurity.js');
    // A white card with no text colour of its own. The canvas must stay dark — the card
    // keeps its own light background and gains a dark text colour, applied by
    // adaptMessageForDarkCanvas, rather than the whole frame being repainted white.
    const doc = buildSrcDoc(
      '<table style="background-color:#F7F7F7"><tr><td style="background-color:#FFFFFF"><div>Witaj</div></td></tr></table>',
      { surface: surface('dark') },
    );
    assert.match(doc, /<meta name="color-scheme" content="dark">/);
    assert.match(doc, /html \{ color-scheme: dark; \}/);
    assert.match(surfaceDeclarations(doc), /background-color: #1a1e25;/);
    assert.doesNotMatch(surfaceDeclarations(doc), /background-color: #ffffff/);
  });

  it('keeps the dark canvas for a message with hard-coded dark text', async () => {
    const { buildSrcDoc } = await import('./messageBodySecurity.js');
    // Nearly every real message contains some dark colour somewhere; that alone must not
    // turn the whole reader white in a dark theme. The text is adapted instead.
    const doc = buildSrcDoc('<h1 style="color:#000000">Tytuł</h1>', { surface: surface('dark') });
    assert.match(doc, /<meta name="color-scheme" content="dark">/);
    assert.match(surfaceDeclarations(doc), /background-color: #1a1e25;/);
    assert.doesNotMatch(surfaceDeclarations(doc), /background-color: #ffffff/);
  });

  it('ignores an unknown tone', async () => {
    const { buildSrcDoc } = await import('./messageBodySecurity.js');
    const doc = buildSrcDoc('<p>hello</p>', { surface: { tone: 'neon', background: '#000', foreground: '#fff' } });
    assert.doesNotMatch(doc, /color-scheme/);
  });
});
