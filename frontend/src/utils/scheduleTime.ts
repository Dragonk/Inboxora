export type ScheduleTimeResult = { instant: string; error?: never } | { error: 'invalidTime' | 'ambiguousTime' | 'pastTime'; instant?: never };
/** Resolve wall time using the zone's possible offsets, rejecting gaps and folds. */
export function resolveScheduleTime(wall: string, timeZone: string, now = Date.now()): ScheduleTimeResult {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(wall)) return { error: 'invalidTime' };
  const naive = Date.parse(`${wall}:00Z`);
  if (!Number.isFinite(naive) || new Date(naive).toISOString().slice(0, 16) !== wall) return { error: 'invalidTime' };
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    const wallStamp = (ms: number) => {
      const p = Object.fromEntries(formatter.formatToParts(ms).map(part => [part.type, part.value]));
      return Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
    };
    const offsets = new Set<number>();
    // Sample either side of any transition, including non-hour and date-line changes.
    for (let hours = -48; hours <= 48; hours += 6) {
      const sample = naive + hours * 3600000;
      offsets.add(wallStamp(sample) - sample);
    }
    const matches = [...offsets].map(offset => naive - offset).filter(candidate => wallStamp(candidate) === naive);
    if (matches.length === 0) return { error: 'invalidTime' };
    if (matches.length > 1) return { error: 'ambiguousTime' };
    if (matches[0] <= now) return { error: 'pastTime' };
    return { instant: new Date(matches[0]).toISOString() };
  } catch { return { error: 'invalidTime' }; }
}
export function scheduleWallTime(instant: string, timeZone: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(instant)).map(part => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
export function schedulePreview(instant: string, timeZone: string, locale?: string): string {
  return `${new Intl.DateTimeFormat(locale, { timeZone, dateStyle: 'full', timeStyle: 'long' }).format(new Date(instant))} (${timeZone}, ${new Intl.DateTimeFormat('en', { timeZone, timeZoneName: 'longOffset' }).formatToParts(new Date(instant)).find(part => part.type === 'timeZoneName')?.value})`;
}
