import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isRetroFont, THEME_FONT, FONT_SETS } from './fonts';

describe('fonts', () => {
  describe('isRetroFont', () => {
    it('returns true for known retro fonts', () => {
      // THEME_FONT only contains retro fonts in this codebase (e.g. winxp, win9x)
      for (const font of Object.values(THEME_FONT)) {
        assert.equal(isRetroFont(font), true, `Expected ${font} to be a retro font`);
      }

      // Explicit test cases
      assert.equal(isRetroFont('winxp'), true);
      assert.equal(isRetroFont('win9x'), true);
    });

    it('returns false for standard fonts and random strings', () => {
      // Test all standard font sets (exclude the retro ones)
      for (const font of Object.keys(FONT_SETS)) {
        if (Object.values(THEME_FONT).includes(font)) continue;
        assert.equal(isRetroFont(font), false, `Expected standard font ${font} to not be a retro font`);
      }

      // Explicit test cases
      assert.equal(isRetroFont('default'), false);
      assert.equal(isRetroFont('editorial'), false);
      assert.equal(isRetroFont(''), false);
      assert.equal(isRetroFont('random'), false);
    });
  });
});
