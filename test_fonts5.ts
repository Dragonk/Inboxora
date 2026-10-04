import { effectiveFontSet } from './frontend/src/fonts.ts';

// Test case 1: normal theme, normal font
console.log("effectiveFontSet('light', 'default'):", effectiveFontSet('light', 'default')); // expected: default

// Test case 2: normal theme, saved font is retro font
console.log("effectiveFontSet('light', 'winxp'):", effectiveFontSet('light', 'winxp')); // expected: default

// Test case 3: retro theme, normal font
console.log("effectiveFontSet('winxp', 'default'):", effectiveFontSet('winxp', 'default')); // expected: winxp

// Test case 4: retro theme, retro font
console.log("effectiveFontSet('winxp', 'winxp'):", effectiveFontSet('winxp', 'winxp')); // expected: winxp
