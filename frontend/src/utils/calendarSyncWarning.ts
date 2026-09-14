type CalendarSyncSample = { uid: string; reason?: unknown };

function isCalendarSyncSample(value: unknown): value is CalendarSyncSample {
  return typeof value === 'object' && value !== null && 'uid' in value && typeof value.uid === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function calendarSyncWarning(error: unknown) {
  if (!error) return null;
  try {
    const parsed: unknown = JSON.parse(String(error));
    if (isRecord(parsed) && parsed.code === 'unsupported_events' && Number.isInteger(parsed.count) && typeof parsed.count === 'number' && parsed.count > 0) {
      const samples: unknown[] = Array.isArray(parsed.samples) ? parsed.samples : [];
      return { count: parsed.count, details: samples.slice(0, 3).filter(isCalendarSyncSample).map(item => `${item.uid}: ${String(item.reason || '')}`).join('\n') };
    }
  } catch { /* Older sources stored a semicolon-separated diagnostic. */ }
  const entries = String(error).split('; ').filter(Boolean);
  if (entries.every(entry => entry.endsWith('unsupported or malformed VEVENT'))) return { count: entries.length, details: entries.slice(0, 3).join('\n') };
  return { count: 0, details: String(error).slice(0, 2000) };
}
