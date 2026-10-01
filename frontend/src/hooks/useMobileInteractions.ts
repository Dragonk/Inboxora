import { useSyncExternalStore } from 'react';
import { useMobile } from './useMobile.ts';

// A phone remains touch-first when rotated past the mail layout breakpoint.
const LANDSCAPE_PHONE = '(pointer: coarse) and (max-height: 767px)';
function subscribe(change: () => void) {
  const media = window.matchMedia(LANDSCAPE_PHONE);
  media.addEventListener('change', change);
  return () => media.removeEventListener('change', change);
}
function snapshot() { return window.matchMedia(LANDSCAPE_PHONE).matches; }
export function useMobileInteractions(): boolean {
  const narrow = useMobile();
  const landscapePhone = useSyncExternalStore(subscribe, snapshot, () => false);
  return narrow || landscapePhone;
}
