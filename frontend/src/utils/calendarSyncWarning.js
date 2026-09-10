export function calendarSyncWarning(error) {
  if (!error) return null;
  try {
    const parsed = JSON.parse(error);
    if (parsed.code === 'unsupported_events' && Number.isInteger(parsed.count) && parsed.count > 0) {
      return { count: parsed.count, details: (Array.isArray(parsed.samples) ? parsed.samples : []).slice(0, 3).filter(item => item && typeof item.uid === 'string').map(item => `${item.uid}: ${item.reason || ''}`).join('\n') };
    }
  } catch { /* Older sources stored a semicolon-separated diagnostic. */ }
  const entries = String(error).split('; ').filter(Boolean);
  if (entries.every(entry => entry.endsWith('unsupported or malformed VEVENT'))) return { count: entries.length, details: entries.slice(0, 3).join('\n') };
  return { count: 0, details: String(error).slice(0, 2000) };
}
