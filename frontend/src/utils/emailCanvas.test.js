import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { emailAssumesLightCanvas, luminance, parseColor } from './emailCanvas.js';

describe('parseColor', () => {
  it('parses the colour notations mail actually uses', () => {
    assert.deepEqual(parseColor('#fff'), [255, 255, 255]);
    assert.deepEqual(parseColor('#FFFFFF'), [255, 255, 255]);
    assert.deepEqual(parseColor('#1a1e25'), [26, 30, 37]);
    assert.deepEqual(parseColor('#ffffffff'), [255, 255, 255]);
    assert.deepEqual(parseColor('rgb(255, 255, 255)'), [255, 255, 255]);
    assert.deepEqual(parseColor('rgba(0, 0, 0, 0.5)'), [0, 0, 0]);
    assert.deepEqual(parseColor('rgb(100% 100% 100%)'), [255, 255, 255]);
    assert.deepEqual(parseColor('white'), [255, 255, 255]);
    assert.deepEqual(parseColor('  Black  '), [0, 0, 0]);
  });

  it('returns null for anything it cannot be sure about', () => {
    assert.equal(parseColor(''), null);
    assert.equal(parseColor(null), null);
    assert.equal(parseColor('currentColor'), null);
    assert.equal(parseColor('var(--x)'), null);
    assert.equal(parseColor('url(x.png)'), null);
    assert.equal(parseColor('#12345'), null);
    assert.equal(parseColor(0xffffff), null);
  });
});

describe('luminance', () => {
  it('orders black, mid and white as expected', () => {
    assert.equal(luminance([0, 0, 0]), 0);
    assert.equal(luminance([255, 255, 255]), 1);
    assert.ok(luminance([128, 128, 128]) > 0.2 && luminance([128, 128, 128]) < 0.25);
  });
});

describe('emailAssumesLightCanvas', () => {
  it('detects a light background declared inline', () => {
    // The reported case: a light card with no text colour of its own.
    assert.equal(emailAssumesLightCanvas(
      '<table width="100%" style="background-color:#F7F7F7"><tr><td style="background-color:#FFFFFF"><div>Witaj</div></td></tr></table>',
    ), true);
  });

  it('detects a light background declared through the legacy bgcolor attribute', () => {
    assert.equal(emailAssumesLightCanvas('<table bgcolor="#FFFFFF"><tr><td>Hi</td></tr></table>'), true);
    assert.equal(emailAssumesLightCanvas('<body bgcolor="white"><p>Hi</p></body>'), true);
  });

  it('detects a light background declared in a style block', () => {
    assert.equal(emailAssumesLightCanvas(
      '<style>.card { background: #f3f3f3 url(bg.png) no-repeat; }</style><div class="card">Hi</div>',
    ), true);
  });

  it('detects dark text that would sit on a light canvas', () => {
    // The second reported case: black text on a transparent background, which assumes the
    // surrounding canvas is white.
    assert.equal(emailAssumesLightCanvas('<h1 style="color:#000000">Tytuł</h1>'), true);
    assert.equal(emailAssumesLightCanvas('<p style="color: rgb(13, 13, 13)">Text</p>'), true);
    assert.equal(emailAssumesLightCanvas('<style>p { color: black; }</style><p>Text</p>'), true);
  });

  it('leaves an unstyled message to the app theme', () => {
    assert.equal(emailAssumesLightCanvas('<p>Fixture body</p><a href="https://example.test">Link</a>'), false);
    assert.equal(emailAssumesLightCanvas('<div><table><tr><td>Plain</td></tr></table></div>'), false);
    assert.equal(emailAssumesLightCanvas(''), false);
    assert.equal(emailAssumesLightCanvas(null), false);
  });

  it('leaves a message with only dark backgrounds to the app theme', () => {
    assert.equal(emailAssumesLightCanvas('<td style="background-color:#000000;color:#ffffff">Dark card</td>'), false);
    assert.equal(emailAssumesLightCanvas('<div style="background: #1a1e25">Dark</div>'), false);
  });

  it('ignores colours it cannot parse', () => {
    assert.equal(emailAssumesLightCanvas('<div style="background-color:var(--surface)">x</div>'), false);
    assert.equal(emailAssumesLightCanvas('<div style="color:currentColor">x</div>'), false);
  });

  it('ignores a mid-grey background but reads mid-grey text as a light-canvas signal', () => {
    // #808080 is not a light background, so on its own it does not ask for a light canvas.
    assert.equal(emailAssumesLightCanvas('<div style="background-color:#808080">x</div>'), false);
    // The same grey as *text* is unreadable on a dark canvas, so it does.
    assert.equal(emailAssumesLightCanvas('<div style="color:#808080">x</div>'), true);
  });

  it('does not read a background image URL as a colour', () => {
    assert.equal(emailAssumesLightCanvas('<div style="background-image:url(https://x.test/white.png)">x</div>'), false);
  });
});
