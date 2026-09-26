import type { ServiceConnection } from './ServiceSettingsView.tsx';

type SourceIdentity = Pick<ServiceConnection, 'id' | 'kind' | 'accountId'>;
type CurrentSource = { id: string };

export interface CalendarSourceRemoval { kind: 'legacy' | 'current'; id: string }

export function calendarSourceRemoval(connection: SourceIdentity, external?: CurrentSource): CalendarSourceRemoval | null {
  if (external) return { kind: 'current', id: external.id };
  if (!connection.accountId && connection.id.startsWith('collection:')
    && (connection.kind === 'caldav' || connection.kind === 'ical_url')) {
    return { kind: 'legacy', id: connection.id };
  }
  return null;
}

export function confirmCalendarSourceRemoval(api: {
  forgetLegacySource: (id: string) => Promise<unknown>;
  deleteSource: (id: string) => Promise<unknown>;
}, removal: CalendarSourceRemoval): Promise<unknown> {
  return removal.kind === 'legacy' ? api.forgetLegacySource(removal.id) : api.deleteSource(removal.id);
}

export function isLegacyCardDavSource(source: SourceIdentity, dav?: CurrentSource): boolean {
  return source.kind === 'carddav' && !dav && !source.accountId
    && (source.id.startsWith('carddav:connection:') || source.id.startsWith('carddav:book:'));
}
