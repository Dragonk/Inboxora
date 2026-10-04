import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isThemeFont} from './fonts.ts';

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
