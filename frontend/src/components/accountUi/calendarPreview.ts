import { useEffect, useState } from 'react';
import { useStore } from '../../store/index.ts';
import { colorValue } from './model.ts';
const EVENT = 'inboxora:calendar-color-preview';
export function previewCalendarColor(calendarId: string, color: string | null, authEpoch: number): void {
  if (useStore.getState().authEpoch !== authEpoch) return;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { calendarId, color, authEpoch } }));
}
export function useCalendarColorPreview(): Readonly<Record<string, string>> {
  const epoch = useStore(state => state.authEpoch);
  const [colors, setColors] = useState<Record<string, string>>({});
  useEffect(() => {
    setColors({});
    const read = (event: Event) => {
      const detail: unknown = (event as CustomEvent<unknown>).detail;
      if (!detail || typeof detail !== 'object') return;
      const value = detail as Record<string, unknown>;
      if (value.authEpoch !== epoch || value.authEpoch !== useStore.getState().authEpoch || typeof value.calendarId !== 'string') return;
      const id = value.calendarId;
      setColors(previous => { const next = { ...previous }; const color = colorValue(value.color); if (color) next[id] = color; else delete next[id]; return next; });
    };
    window.addEventListener(EVENT, read);
    return () => window.removeEventListener(EVENT, read);
  }, [epoch]);
  return colors;
}
