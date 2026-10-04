import { effectiveFontSet } from './frontend/src/fonts.ts';

console.log("effectiveFontSet('dark', 'winxp'):", effectiveFontSet('dark', 'winxp'));
console.log("effectiveFontSet('light', 'winxp'):", effectiveFontSet('light', 'winxp'));
console.log("effectiveFontSet('win9x', 'default'):", effectiveFontSet('win9x', 'default'));
console.log("effectiveFontSet('win9x', 'winxp'):", effectiveFontSet('win9x', 'winxp'));
