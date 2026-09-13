import { useSyncExternalStore } from 'react';

const MOBILE_QUERY = '(max-width: 767px)';

function subscribe(onChange) {
  const media = window.matchMedia(MOBILE_QUERY);
  // Mobile browsers can apply the viewport meta tag after the first render
  // without emitting a MediaQueryList change event. ResizeObserver supplies
  // an initial post-layout notification and also covers that transition.
  const observer = new ResizeObserver(onChange);
  observer.observe(document.documentElement);
  const postViewportTimer = window.setTimeout(onChange, 100);
  media.addEventListener('change', onChange);
  return () => {
    observer.disconnect();
    window.clearTimeout(postViewportTimer);
    media.removeEventListener('change', onChange);
  };
}

function getSnapshot() {
  return window.matchMedia(MOBILE_QUERY).matches;
}

export function useMobile() {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
