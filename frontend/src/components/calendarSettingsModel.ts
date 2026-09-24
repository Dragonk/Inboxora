export interface CalendarRow {
  id: string;
  name?: string | null;
  color?: string | null;
  source?: string | null;
  read_only?: boolean | null;
  owner_user_id?: string | null;
  display_visible?: boolean | null;
  custom_name?: boolean | null;
  dav_mode?: string | null;
  collection_id?: string | null;
  [key: string]: unknown;
}
export interface CalendarPresentationSource {
  id: string; kind: string; label: string; accountId: string | null;
  identityLabel: string | null; featureEnabled: boolean; canSync: boolean; collapsed: boolean;
}
export interface CalendarPresentationCalendar {
  id: string; sourceId: string; displayName: string; readOnly: boolean; selected: boolean; sidebarHidden: boolean;
}
export interface CalendarPresentation {
  sources?: CalendarPresentationSource[];
  calendars?: CalendarPresentationCalendar[];
  groups?: Array<CalendarPresentationSource & { calendars: CalendarPresentationCalendar[] }>;
}
export function calendarSourceCategory(source: CalendarPresentationSource): 'local' | 'external' | 'google' | 'microsoft' | 'system' {
  if (source.kind === 'local' || source.kind === 'google' || source.kind === 'microsoft' || source.kind === 'system') return source.kind;
  return 'external';
}
export function calendarSidebarGroups(presentation: CalendarPresentation | null, calendars: CalendarRow[]) {
  const order = { local: 0, external: 1, google: 2, microsoft: 3, system: 4 } as const;
  return (presentation?.groups ?? []).map(group => ({
    ...group, category: calendarSourceCategory(group),
    rows: group.calendars.map(view => ({ view, calendar: calendars.find(calendar => calendar.id === view.id) }))
      .filter((item): item is { view: CalendarPresentationCalendar; calendar: CalendarRow } => item.calendar !== undefined),
  })).sort((left, right) => order[left.category] - order[right.category] || left.label.localeCompare(right.label));
}
/** Management visibility is deliberately independent of event selection. */
export async function setCalendarSidebarHidden(
  update: (id: string, hidden: boolean) => Promise<unknown>, id: string, hidden: boolean,
) { await update(id, hidden); }
export function canManageLocalCalendar(calendar: CalendarRow) {
  return calendar.source === 'local' && !calendar.read_only && Boolean(calendar.owner_user_id);
}
