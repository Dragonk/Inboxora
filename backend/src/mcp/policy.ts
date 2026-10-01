import { z } from 'zod';
import { query } from '../services/db.js';

export const SCOPES = [
  'mail.read', 'mail.draft', 'mail.send', 'mail.modify', 'mail.delete', 'mail.spam', 'mail.unsubscribe',
  'calendar.read', 'calendar.write', 'calendar.invite', 'contacts.read', 'contacts.write',
] as const;
export type Scope = typeof SCOPES[number];
export const READ_SCOPES: Scope[] = ['mail.read', 'calendar.read', 'contacts.read'];
export const restrictionsSchema = z.object({
  accounts: z.array(z.uuid()).max(200).nullable().default(null),
  folders: z.array(z.object({ accountId: z.uuid(), path: z.string().min(1).max(1024) }).strict()).max(500).nullable().default(null),
  calendars: z.array(z.uuid()).max(500).nullable().default(null),
  addressBooks: z.array(z.uuid()).max(500).nullable().default(null),
}).strict();
export type Restrictions = z.infer<typeof restrictionsSchema>;
export const grantSchema = z.object({
  name: z.string().trim().min(1).max(120),
  scopes: z.array(z.enum(SCOPES)).min(1).max(SCOPES.length).transform(value => [...new Set(value)]),
  restrictions: restrictionsSchema.default({ accounts: null, folders: null, calendars: null, addressBooks: null }),
  requireConfirmation: z.boolean().default(true),
  expiresInDays: z.number().int().min(1).max(365).default(90),
}).strict();
export type GrantInput = z.infer<typeof grantSchema>;
export interface Grant {
  id: string; user_id: string; client_id: string | null; name: string;
  scopes: Scope[]; restrictions: Restrictions; require_confirmation: boolean;
  expires_at: Date | string; revoked_at: Date | string | null;
}
export class McpError extends Error {
  constructor(public code: string, message: string, public status = 403) { super(message); }
}
export function requireScope(grant: Grant, scope: Scope): void {
  if (!grant.scopes.includes(scope)) throw new McpError('SCOPE_REQUIRED', `This integration needs the ${scope} permission.`);
}
export function allowedId(ids: string[] | null, id: string): boolean { return ids === null || ids.includes(id); }
export function allowedFolder(restrictions: Restrictions, accountId: string, folder: string): boolean {
  return allowedId(restrictions.accounts, accountId) && (restrictions.folders === null
    || restrictions.folders.some(item => item.accountId === accountId && item.path === folder));
}
export async function validateOwnedRestrictions(userId: string, restrictions: Restrictions): Promise<void> {
  for (const [table, ids] of [
    ['email_accounts', restrictions.accounts], ['calendars', restrictions.calendars], ['address_books', restrictions.addressBooks],
  ] as const) {
    if (ids === null || ids.length === 0) continue;
    const unique = [...new Set(ids)];
    const owned = await query<{ id: string }>(`SELECT id FROM ${table} WHERE user_id=$1 AND id=ANY($2::uuid[])`, [userId, unique]);
    if (owned.rows.length !== unique.length) throw new McpError('RESOURCE_UNAVAILABLE', 'One or more selected resources are unavailable.');
  }
  if (restrictions.folders) {
    const folders = await query<{ account_id: string; path: string }>(`SELECT f.account_id,f.path FROM folders f
      JOIN email_accounts a ON a.id=f.account_id WHERE a.user_id=$1`, [userId]);
    if (restrictions.folders.some(item => !allowedId(restrictions.accounts, item.accountId)
      || !folders.rows.some(folder => folder.account_id === item.accountId && folder.path === item.path))) {
      throw new McpError('RESOURCE_UNAVAILABLE', 'One or more selected folders are unavailable.');
    }
  }
}
export async function liveGrant(id: string, userId?: string, ceiling?: readonly string[]): Promise<Grant> {
  const result = await query<Grant>(`SELECT id,user_id,client_id,name,scopes,restrictions,require_confirmation,expires_at,revoked_at
    FROM mcp_grants WHERE id=$1 AND revoked_at IS NULL AND expires_at>NOW()
      AND ($2::uuid IS NULL OR user_id=$2)`, [id, userId ?? null]);
  const grant = result.rows[0];
  if (!grant) throw new McpError('GRANT_REVOKED', 'This integration has expired or has been revoked.', 401);
  grant.restrictions = restrictionsSchema.parse(grant.restrictions);
  if (ceiling) grant.scopes = grant.scopes.filter(scope => ceiling.includes(scope));
  return grant;
}
export async function requireAccount(grant: Grant, accountId: string): Promise<void> {
  if (!allowedId(grant.restrictions.accounts, accountId)) throw new McpError('RESOURCE_FORBIDDEN', 'This account is outside the integration permissions.');
  const result = await query('SELECT id FROM email_accounts WHERE id=$1 AND user_id=$2 AND enabled=true', [accountId, grant.user_id]);
  if (!result.rows.length) throw new McpError('RESOURCE_UNAVAILABLE', 'Account not found.', 404);
}
export async function requireMessage(grant: Grant, messageId: string): Promise<{ id: string; account_id: string; folder: string }> {
  const result = await query<{ id: string; account_id: string; folder: string }>(`SELECT m.id,m.account_id,m.folder FROM messages m
    JOIN email_accounts a ON a.id=m.account_id WHERE m.id=$1 AND a.user_id=$2 AND a.enabled=true AND m.is_deleted=false`, [messageId, grant.user_id]);
  const message = result.rows[0];
  if (!message) throw new McpError('RESOURCE_UNAVAILABLE', 'Message not found.', 404);
  if (!allowedFolder(grant.restrictions, message.account_id, message.folder)) throw new McpError('RESOURCE_FORBIDDEN', 'This message is outside the integration permissions.');
  return message;
}
export async function requireCalendar(grant: Grant, id: string): Promise<void> {
  if (!allowedId(grant.restrictions.calendars, id)) throw new McpError('RESOURCE_FORBIDDEN', 'This calendar is outside the integration permissions.');
  const result = await query('SELECT id FROM calendars WHERE id=$1 AND user_id=$2 AND owner_user_id=$2', [id, grant.user_id]);
  if (!result.rows.length) throw new McpError('RESOURCE_UNAVAILABLE', 'Calendar not found.', 404);
}
export async function requireBook(grant: Grant, id: string): Promise<void> {
  if (!allowedId(grant.restrictions.addressBooks, id)) throw new McpError('RESOURCE_FORBIDDEN', 'This address book is outside the integration permissions.');
  const result = await query('SELECT id FROM address_books WHERE id=$1 AND user_id=$2', [id, grant.user_id]);
  if (!result.rows.length) throw new McpError('RESOURCE_UNAVAILABLE', 'Address book not found.', 404);
}
