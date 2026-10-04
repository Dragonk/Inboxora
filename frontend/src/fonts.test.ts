import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FONT_SETS, THEME_FONT, isRetroFont, isThemeFont } from './fonts.ts';

describe('fonts', () => {
  describe('isThemeFont', () => {
    it('returns true for valid THEME_FONT keys', () => {
      assert.strictEqual(isThemeFont('winxp'), true);
      assert.strictEqual(isThemeFont('win9x'), true);
    });

    it('returns false for invalid string keys', () => {
      assert.strictEqual(isThemeFont('default'), false);
      assert.strictEqual(isThemeFont('ubuntu'), false);
      assert.strictEqual(isThemeFont(''), false);
    });

    it('returns false for non-string inputs', () => {
      assert.strictEqual(isThemeFont(null), false);
      assert.strictEqual(isThemeFont(undefined), false);
      assert.strictEqual(isThemeFont(123), false);
      assert.strictEqual(isThemeFont({}), false);
      assert.strictEqual(isThemeFont([]), false);
      assert.strictEqual(isThemeFont(() => {}), false);
    });
  });

  describe('isRetroFont', () => {
    it('returns true for known retro fonts', () => {
      for (const font of Object.values(THEME_FONT)) {
        assert.equal(isRetroFont(font), true, `Expected ${font} to be a retro font`);
      }
    });

    it('returns false for standard fonts and unknown values', () => {
      const retroFonts = new Set<string>(Object.values(THEME_FONT));
      for (const font of Object.keys(FONT_SETS)) {
        if (retroFonts.has(font)) continue;
        assert.equal(isRetroFont(font), false, `Expected standard font ${font} to not be a retro font`);
      }

      assert.equal(isRetroFont('default'), false);
      assert.equal(isRetroFont('editorial'), false);
      assert.equal(isRetroFont(''), false);
      assert.equal(isRetroFont('random'), false);
    });
  });
});
