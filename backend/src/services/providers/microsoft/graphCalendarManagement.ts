import { graphGet, graphPost, graphDeleteResponse, graphUrl, type GraphApiOptions } from './graphApiClient.js';

export const GRAPH_CALENDAR_MANAGEMENT_SELECT = 'id,name,isDefaultCalendar,canEdit,owner';
export type GraphCalendarProtectionReason = 'invalid_id' | 'metadata_missing' | 'identity_mismatch' | 'default_calendar' | 'not_editable' | 'owner_unverified' | 'not_owner';
export type GraphCalendarProtection =
  | { canDelete: true; calendarId: string; defaultCalendarId: string; ownerAddress: string }
  | { canDelete: false; calendarId: string; reason: GraphCalendarProtectionReason };
export interface GraphManagedCalendar { id: string; name: string | null }
export class GraphCalendarProtectionError extends Error {
  constructor(readonly reason: GraphCalendarProtectionReason) {
    super(`Graph calendar deletion refused: ${reason}`);
    this.name = 'GraphCalendarProtectionError';
  }
}
export class GraphCalendarManagementResponseError extends Error {
  constructor(readonly operation: 'create' | 'delete' = 'create') {
    super(`Graph calendar ${operation} returned no definitive confirmation; outcome is unknown`);
    this.name = 'GraphCalendarManagementResponseError';
  }
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function validId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value !== '.' && value !== '..';
}
function mailbox(value: unknown): string | null {
  // Do not guess from a display name, local account alias, missing or malformed address.
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+$/.test(value.trim()) ? value.trim().toLowerCase() : null;
}

/** Non-idempotent create; the caller must retain a durable intent and classify uncertainty. */
export async function createGraphManagedCalendar(api: GraphApiOptions, name: string): Promise<GraphManagedCalendar> {
  if (!name.trim()) throw new TypeError('Calendar name must not be empty');
  const result = record(await graphPost<unknown>(api, '/me/calendars', { name }));
  if (!result || !validId(result.id)) throw new GraphCalendarManagementResponseError();
  return { id: result.id, name: typeof result.name === 'string' ? result.name : null };
}

/** The mailbox identity MUST come from verified provider identity, never a local user-entered alias. */
export async function inspectGraphCalendarManagement(api: GraphApiOptions, calendarId: string, verifiedMailboxIdentity: string): Promise<GraphCalendarProtection> {
  const refuse = (reason: GraphCalendarProtectionReason): GraphCalendarProtection => ({ canDelete: false, calendarId, reason });
  if (!validId(calendarId)) return refuse('invalid_id');
  const identity = mailbox(verifiedMailboxIdentity);
  if (!identity) return refuse('owner_unverified');
  const metadata = record(await graphGet<unknown>(api, graphUrl(`/me/calendars/${encodeURIComponent(calendarId)}`, { $select: GRAPH_CALENDAR_MANAGEMENT_SELECT })));
  const primary = record(await graphGet<unknown>(api, graphUrl('/me/calendar', { $select: 'id' })));
  if (!metadata || !primary || !validId(metadata.id) || !validId(primary.id)) return refuse('metadata_missing');
  if (metadata.isDefaultCalendar === true || metadata.id === primary.id || calendarId === primary.id) return refuse('default_calendar');
  if (metadata.id !== calendarId) return refuse('identity_mismatch');
  if (metadata.isDefaultCalendar !== undefined && metadata.isDefaultCalendar !== false) return refuse('metadata_missing');
  if (metadata.canEdit !== true) return refuse(typeof metadata.canEdit === 'boolean' ? 'not_editable' : 'metadata_missing');
  const ownerAddress = mailbox(record(metadata.owner)?.address);
  if (!ownerAddress) return refuse('owner_unverified');
  if (ownerAddress !== identity) return refuse('not_owner');
  return { canDelete: true, calendarId, defaultCalendarId: primary.id, ownerAddress };
}

/** Fresh metadata guards precede each DELETE; API errors/unknown side effects are never retried here. */
export async function deleteGraphManagedCalendar(api: GraphApiOptions, calendarId: string, verifiedMailboxIdentity: string): Promise<void> {
  const protection = await inspectGraphCalendarManagement(api, calendarId, verifiedMailboxIdentity);
  if (!protection.canDelete) throw new GraphCalendarProtectionError(protection.reason);
  const response = await graphDeleteResponse(api, `/me/calendars/${encodeURIComponent(protection.calendarId)}`);
  if (response.status !== 204) throw new GraphCalendarManagementResponseError('delete');
}
