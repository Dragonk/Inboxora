import { useLayoutEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import { createBackNavigation } from '../utils/backNavigation.ts';

const navigation = createBackNavigation({
  history: window.history,
  listen: (handler: () => void) => {
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  },
  commit: flushSync,
});

// Priority follows the visible stacking order; equal-priority layers use LIFO.
export function useBackLayer(active: unknown, onBack: () => void, priority = 0) {
  const close = useRef(onBack);
  close.current = onBack;
  useLayoutEffect(() => {
    if (!active) return undefined;
    return navigation.register(Symbol(), () => close.current(), priority);
  }, [active, priority]);
}

export function useBackNavigation(isMobile: boolean) {
  useLayoutEffect(() => {
    const stop = navigation.start();
    window.__inboxoraHandleAndroidBack = () => navigation.back();
    return () => { stop(); delete window.__inboxoraHandleAndroidBack; };
  }, []);
  useLayoutEffect(() => { navigation.setEnabled(isMobile); }, [isMobile]);
}
