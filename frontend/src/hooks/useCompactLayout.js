import { useSyncExternalStore } from 'react';
import { useUiScale } from './useUiScale.js';

const subscribe = callback => {
  window.addEventListener('resize', callback);
  return () => window.removeEventListener('resize', callback);
};
const snapshot = () => window.innerWidth;

// Use layout pixels, so increasing UI scale gets the same usable single-pane
// presentation as a smaller screen without changing the saved layout preset.
export function useCompactLayout() {
  const scale = useUiScale();
  const width = useSyncExternalStore(subscribe, snapshot, () => 1440);
  return width / scale <= 1100;
}
