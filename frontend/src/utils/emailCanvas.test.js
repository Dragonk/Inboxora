import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  adaptTextForCanvas,
  findColorToken,
  hslToRgb,
  isLightBackground,
  lightness,
  needsDarkening,
  needsLifting,
  parseColor,
  rgbToHex,
  rgbToHsl,
  textForLightBackground,
} from './emailCanvas.js';

// WCAG relative luminance, so the assertions speak in contrast ratios rather than in
// raw channel values.
function contrast(a, b) {
  const luminance = ([r, g, b]) => {
    const channel = value => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// dark_ink's canvas and default text — the surface a message is adapted to.
const CANVAS = parseColor('#1a1e25');
const THEME_TEXT = parseColor('#e8e6df');

describe('parseColor and findColorToken', () => {
  it('parses the notations mail actually uses', () => {
    assert.deepEqual(parseColor('#fff'), [255, 255, 255]);
    assert.deepEqual(parseColor('#FFFFFF'), [255, 255, 255]);
    assert.deepEqual(parseColor('#1a1e25'), [26, 30, 37]);
    assert.deepEqual(parseColor('rgb(255, 255, 255)'), [255, 255, 255]);
    assert.deepEqual(parseColor('rgba(0, 0, 0, 0.5)'), [0, 0, 0]);
    assert.deepEqual(parseColor('rgb(100% 100% 100%)'), [255, 255, 255]);
    assert.deepEqual(parseColor('white'), [255, 255, 255]);
  });

  it('returns null for anything it cannot be sure about', () => {
    assert.equal(parseColor(''), null);
    assert.equal(parseColor(null), null);
    assert.equal(parseColor('currentColor'), null);
    assert.equal(parseColor('var(--x)'), null);
    assert.equal(parseColor('#12345'), null);
  });

  it('finds a colour inside a shorthand without being fooled by a URL', () => {
    assert.equal(findColorToken('#fff url(x.png) no-repeat'), '#fff');
    assert.equal(findColorToken('rgb(13, 13, 13)'), 'rgb(13, 13, 13)');
    assert.equal(findColorToken('url(white.png)'), null);
  });
});

describe('colour space round trips', () => {
  it('converts to HSL and back without drifting more than a rounding step', () => {
    for (const hex of ['#000000', '#ffffff', '#666666', '#222222', '#1a1e25', '#00a790', '#ff5a00']) {
      const rgb = parseColor(hex);
      const back = hslToRgb(rgbToHsl(rgb));
      for (let channel = 0; channel < 3; channel += 1) {
        assert.ok(Math.abs(rgb[channel] - back[channel]) <= 1, `${hex} channel ${channel}: ${rgb[channel]} vs ${back[channel]}`);
      }
    }
  });

  it('orders lightness the way the eye does', () => {
    assert.ok(lightness(parseColor('#000000')) < lightness(parseColor('#666666')));
    assert.ok(lightness(parseColor('#666666')) < lightness(parseColor('#ffffff')));
  });

  it('renders hex back at full width', () => {
    assert.equal(rgbToHex([0, 0, 0]), '#000000');
    assert.equal(rgbToHex([255, 255, 255]), '#ffffff');
    assert.equal(rgbToHex([26, 30, 37]), '#1a1e25');
  });
});

describe('isLightBackground', () => {
  it('recognises the light surfaces mail paints', () => {
    for (const hex of ['#ffffff', '#eceff1', '#f7f7f7', '#edece6']) {
      assert.equal(isLightBackground(parseColor(hex)), true, hex);
    }
  });

  it('does not mistake a dark surface or a mid-grey card for one', () => {
    for (const hex of ['#1a1e25', '#000000', '#3a4e58']) {
      assert.equal(isLightBackground(parseColor(hex)), false, hex);
    }
  });
});

describe('adapting text to the dark canvas', () => {
  it('lifts dark text to a readable light colour', () => {
    // #222 is the near-black body text of a light-designed newsletter.
    const lifted = adaptTextForCanvas(parseColor('#222222'), false);
    assert.ok(lightness(lifted) > 0.8, `expected a light result, got ${rgbToHex(lifted)}`);
    assert.ok(contrast(lifted, CANVAS) >= 4.5, `contrast ${contrast(lifted, CANVAS)}`);
  });

  it('lifts a muted grey but keeps it muted relative to body text', () => {
    // A #666 footer must become readable without competing with the message body.
    const footer = adaptTextForCanvas(parseColor('#666666'), false);
    const body = adaptTextForCanvas(parseColor('#222222'), false);
    assert.ok(contrast(footer, CANVAS) >= 4.5, `contrast ${contrast(footer, CANVAS)}`);
    assert.ok(contrast(footer, CANVAS) <= 8, `footer became as bright as body text: ${contrast(footer, CANVAS)}`);
    assert.ok(lightness(footer) < lightness(body), 'the footer must stay dimmer than the body');
  });

  it('keeps the author’s hue and saturation', () => {
    const [hue] = rgbToHsl(parseColor('#00a790'));
    const adapted = rgbToHsl(adaptTextForCanvas(parseColor('#00a790'), false));
    assert.ok(Math.abs(adapted[0] - hue) < 2, `hue drifted from ${hue} to ${adapted[0]}`);
    assert.ok(adapted[1] > 0.3, 'saturation was flattened');
  });

  it('never leaves adapted text mid-grey', () => {
    for (const hex of ['#767676', '#808080', '#999999', '#4d4d4d']) {
      const lifted = adaptTextForCanvas(parseColor(hex), false);
      assert.ok(lightness(lifted) >= 0.6, `${hex} lifted only to ${rgbToHex(lifted)}`);
      assert.ok(contrast(lifted, CANVAS) >= 4.5, `${hex} contrast ${contrast(lifted, CANVAS)}`);
    }
  });

  it('darkens light text that sits inside a light region', () => {
    const darkened = adaptTextForCanvas(parseColor('#cccccc'), true);
    assert.ok(lightness(darkened) <= 0.35, `expected a dark result, got ${rgbToHex(darkened)}`);
    assert.ok(contrast(darkened, parseColor('#ffffff')) >= 4.5, `contrast ${contrast(darkened, parseColor('#ffffff'))}`);
  });

  it('caps adapted text so it can never become the same shade as its canvas', () => {
    for (const hex of ['#000000', '#111111', '#fefefe', '#ffffff']) {
      const lifted = adaptTextForCanvas(parseColor(hex), false);
      const darkened = adaptTextForCanvas(parseColor(hex), true);
      assert.ok(contrast(lifted, CANVAS) >= 4.5, `${hex} lifted contrast ${contrast(lifted, CANVAS)}`);
      assert.ok(contrast(darkened, parseColor('#ffffff')) >= 4.5, `${hex} darkened contrast ${contrast(darkened, parseColor('#ffffff'))}`);
    }
  });
});

describe('text decided from a message’s own light background', () => {
  it('produces readable dark text for a white card that declares none', () => {
    for (const hex of ['#ffffff', '#f7f7f7', '#eceff1', '#fff8e1']) {
      const text = textForLightBackground(parseColor(hex));
      assert.ok(contrast(text, parseColor(hex)) >= 4.5, `${hex} contrast ${contrast(text, parseColor(hex))}`);
    }
  });

  it('keeps a hint of the card’s hue rather than always using pure black', () => {
    const onCream = textForLightBackground(parseColor('#fff8e1'));
    assert.ok(rgbToHsl(onCream)[1] > 0, 'the cream card produced a neutral grey');
  });
});

describe('deciding whether a declaration needs adapting', () => {
  it('acts only on the side that would be unreadable', () => {
    // On the dark canvas: dark text is adapted, light text is left alone.
    assert.equal(needsLifting(parseColor('#222222'), false), true);
    assert.equal(needsLifting(parseColor('#e8e6df'), false), false);
    assert.equal(needsDarkening(parseColor('#e8e6df'), false), false);
    // Inside a light region it is the other way round.
    assert.equal(needsDarkening(parseColor('#cccccc'), true), true);
    assert.equal(needsDarkening(parseColor('#222222'), true), false);
    assert.equal(needsLifting(parseColor('#222222'), true), false);
  });

  it('leaves a colour that already contrasts with its region', () => {
    // The Allegro link colour is dark-ish but sits on a white card, so it stays.
    assert.equal(needsLifting(parseColor('#00a790'), true), false);
    assert.equal(needsDarkening(parseColor('#00a790'), true), false);
  });
});

describe('what the theme text itself must satisfy', () => {
  it('needs no adaptation on the canvas it was chosen for', () => {
    assert.ok(contrast(THEME_TEXT, CANVAS) >= 4.5);
    // The frame's default text is readable on the dark canvas as-is, so it is left alone.
    assert.equal(needsLifting(THEME_TEXT, false), false);
    assert.equal(needsDarkening(THEME_TEXT, false), false);
  });

  it('would be darkened if a message declared it inside a light card', () => {
    // Not something the frame does — it sets its own dark colour on the element that
    // paints a light background — but the rule has to hold for a message that does.
    assert.equal(needsDarkening(THEME_TEXT, true), true);
  });
});
