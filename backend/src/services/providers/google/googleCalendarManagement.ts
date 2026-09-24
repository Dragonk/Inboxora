import { googleApiJson, googleApiRequest, classifyGoogleError, googleUrl, type GoogleApiOptions } from './googleApiClient.js';
import { GOOGLE_CALENDAR_API_BASE } from './googleCalendar.js';

export type GoogleCalendarProtectionReason = 'invalid_id' | 'metadata_missing' | 'identity_mismatch' | 'primary_calendar' | 'not_owner';
export type GoogleCalendarProtection =
  | { canDelete: true; calendarId: string; primaryCalendarId: string }
  | { canDelete: false; calendarId: string; reason: GoogleCalendarProtectionReason };
export interface GoogleManagedCalendar { id: string; summary: string | null }
export class GoogleCalendarProtectionError extends Error {
  constructor(readonly reason: GoogleCalendarProtectionReason) {
    super(`Google calendar deletion refused: ${reason}`);
    this.name = 'GoogleCalendarProtectionError';
  }
}
export class GoogleCalendarManagementResponseError extends Error {
  constructor(readonly operation: 'create' | 'delete' = 'create') {
    super(`Google calendar ${operation} returned no definitive confirmation; outcome is unknown`);
    this.name = 'GoogleCalendarManagementResponseError';
  }
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function validId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value !== '.' && value !== '..';
}
const url = (path: string) => googleUrl(GOOGLE_CALENDAR_API_BASE, path, {});

/** A non-idempotent upstream create. Callers must journal intent and uncertain outcomes. */
export async function createGoogleManagedCalendar(api: GoogleApiOptions, name: string): Promise<GoogleManagedCalendar> {
  if (!name.trim()) throw new TypeError('Calendar name must not be empty');
  const response = await googleApiRequest(api, url('/calendars'), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ summary: name }),
  });
  if (!response.ok) throw classifyGoogleError(response.status, await response.json().catch(() => null), response.headers);
  if (response.status !== 200 && response.status !== 201) throw new GoogleCalendarManagementResponseError();
  const result = record(await response.json().catch(() => null));
  if (!result || !validId(result.id)) throw new GoogleCalendarManagementResponseError();
  return { id: result.id, summary: typeof result.summary === 'string' ? result.summary : null };
}

/** Canonical primary identity, not a name or omitted `primary` flag, protects the primary calendar. */
export async function inspectGoogleCalendarManagement(api: GoogleApiOptions, calendarId: string): Promise<GoogleCalendarProtection> {
  const refuse = (reason: GoogleCalendarProtectionReason): GoogleCalendarProtection => ({ canDelete: false, calendarId, reason });
  if (!validId(calendarId)) return refuse('invalid_id');
  const metadata = record(await googleApiJson<unknown>(api, url(`/users/me/calendarList/${encodeURIComponent(calendarId)}`), { method: 'GET' }));
  const primary = record(await googleApiJson<unknown>(api, url('/calendars/primary'), { method: 'GET' }));
  if (!metadata || !primary || !validId(metadata.id) || !validId(primary.id)) return refuse('metadata_missing');
  if (metadata.primary === true || metadata.id === primary.id || calendarId === primary.id) return refuse('primary_calendar');
  if (metadata.id !== calendarId) return refuse('identity_mismatch');
  if ((metadata.primary !== undefined && metadata.primary !== false) || metadata.deleted === true) return refuse('metadata_missing');
  if (metadata.accessRole !== 'owner') return refuse(typeof metadata.accessRole === 'string' ? 'not_owner' : 'metadata_missing');
  return { canDelete: true, calendarId, primaryCalendarId: primary.id };
}

/** Always re-read guards. This deletes the collection itself, never a CalendarList subscription. */
export async function deleteGoogleManagedCalendar(api: GoogleApiOptions, calendarId: string): Promise<void> {
  const protection = await inspectGoogleCalendarManagement(api, calendarId);
  if (!protection.canDelete) throw new GoogleCalendarProtectionError(protection.reason);
  const response = await googleApiRequest(api, url(`/calendars/${encodeURIComponent(protection.calendarId)}`), { method: 'DELETE' });
  if (!response.ok) throw classifyGoogleError(response.status, await response.json().catch(() => null), response.headers);
  if (response.status !== 204) throw new GoogleCalendarManagementResponseError('delete');
}
