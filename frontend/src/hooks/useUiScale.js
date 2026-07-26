import { useStore } from '../store/index.js';

// The whole app is rendered inside a `transform: scale(fontSize/100)` wrapper whose
// transform-origin is the top-left corner (see MailApp). A CSS transform makes that
// wrapper the containing block for `position: fixed` descendants AND scales them, so a
// popover placed at coordinates taken from getBoundingClientRect() / window.inner* —
// which are already in scaled (visual) space — gets scaled a second time and drifts away
// from its anchor. The drift grows with the scale factor, which is why it only shows up
// once font scaling is raised above 100%.
//
// Dividing an applied fixed coordinate by this scale converts the visual coordinate back
// into the wrapper's layout space, so the popover lands on its anchor. It is an exact
// no-op at 100% (value / 1 === value), so the default experience is unchanged.
export function useUiScale() {
  return (useStore(s => s.fontSize) || 100) / 100;
}

// Convert one visual-space CSS coordinate (top/left/right/bottom/width/height) into the
// scaled wrapper's layout space. Non-numbers (e.g. an unset `bottom` on a popover that
// only sets `top`) pass through untouched so they stay unset rather than becoming NaN.
export function descale(value, scale) {
  return typeof value === 'number' ? value / scale : value;
}
