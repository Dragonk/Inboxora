import { effectiveFontSet } from './frontend/src/fonts.ts';

console.log("effectiveFontSet('light', 'winxp'):", effectiveFontSet('light', 'winxp'));
console.log("effectiveFontSet('winxp', 'default'):", effectiveFontSet('winxp', 'default'));
console.log("effectiveFontSet('winxp', 'editorial'):", effectiveFontSet('winxp', 'editorial'));
