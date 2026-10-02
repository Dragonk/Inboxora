import { api } from './api.ts';
import { getAuthEpoch, isCurrentAuthEpoch } from './authEpoch.ts';

export const MCP_SCOPES = ['mail.read','mail.draft','mail.send','mail.modify','mail.delete','mail.spam','mail.unsubscribe','calendar.read','calendar.write','calendar.invite','contacts.read','contacts.write'] as const;
export type McpScope = typeof MCP_SCOPES[number];
export interface McpRestrictions { accounts: string[] | null; folders: { accountId: string; path: string }[] | null; calendars: string[] | null; addressBooks: string[] | null; }
export interface McpGrantInput { name: string; scopes: McpScope[]; restrictions: McpRestrictions; requireConfirmation: boolean; expiresInDays: number; }
export interface McpConfig { enabled: boolean; endpoint: string | null; configurationError: boolean; scopes: McpScope[]; }
export interface McpResources {
  accounts: { id: string; name: string; email_address: string }[];
  folders: { id: string; account_id: string; path: string; name: string }[];
  calendars: { id: string; name: string; source: string; read_only: boolean }[];
  addressBooks: { id: string; name: string; source: string }[];
}
export interface McpGrant extends McpGrantInput { id: string; created_at: string; expires_at: string; revoked_at: string | null; last_used_at: string | null; require_confirmation: boolean; }
export interface McpOperation { id: string; tool: string; state: string; created_at?: string; expiresAt?: string; integration_name?: string; integrationName?: string; arguments?: Record<string, unknown>; review?: Record<string, unknown> | null; result?: unknown; }
export interface McpConsent { name: string; clientId: string; scopes: McpScope[]; redirectUri: string; }
export const emptyResources: McpResources = { accounts: [], folders: [], calendars: [], addressBooks: [] };
export function newMcpGrant(name = ''): McpGrantInput {
  return { name, scopes: ['mail.read','calendar.read','contacts.read'], restrictions: { accounts: null, folders: null, calendars: null, addressBooks: null }, requireConfirmation: true, expiresInDays: 90 };
}
/** The shared API client owns session/CSRF errors. Never publish a stale secret or
 * redirect into a newly logged-in identity after this request has completed. */
export async function mcpRequest<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const epoch = getAuthEpoch();
  const result: unknown = await api.mcp.request(method, path, body);
  if (!isCurrentAuthEpoch(epoch)) throw new Error('Session changed.');
  return result as T;
}
export function safeMcpReturn(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (/^\/ai\/mcp\/authorize\?request=[A-Za-z0-9_-]{43}$/.test(value)) return value;
  if (/^\/ai\/mcp\/confirm\/[a-f0-9-]{36}$/i.test(value)) return value;
  return null;
}
const pendingKey = 'inboxora:mcp-return';
export function rememberMcpReturn(path: string): void {
  const safe = safeMcpReturn(path);
  if (safe) try { sessionStorage.setItem(pendingKey, JSON.stringify({ path: safe, expires: Date.now() + 10 * 60000 })); } catch { /* password login still preserves the URL */ }
}
export function pendingMcpReturn(): string | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(pendingKey) || 'null') as { path?: unknown; expires?: unknown } | null;
    return value && typeof value.expires === 'number' && value.expires > Date.now() ? safeMcpReturn(value.path) : null;
  } catch { return null; }
}
export function clearMcpReturn(): void { try { sessionStorage.removeItem(pendingKey); } catch { /* optional storage */ } }

export const MCP_SCOPE_KEYS: Record<McpScope, string> = {
  'mail.read': 'mcp.scopes.mail_read',
  'mail.draft': 'mcp.scopes.mail_draft',
  'mail.send': 'mcp.scopes.mail_send',
  'mail.modify': 'mcp.scopes.mail_modify',
  'mail.delete': 'mcp.scopes.mail_delete',
  'mail.spam': 'mcp.scopes.mail_spam',
  'mail.unsubscribe': 'mcp.scopes.mail_unsubscribe',
  'calendar.read': 'mcp.scopes.calendar_read',
  'calendar.write': 'mcp.scopes.calendar_write',
  'calendar.invite': 'mcp.scopes.calendar_invite',
  'contacts.read': 'mcp.scopes.contacts_read',
  'contacts.write': 'mcp.scopes.contacts_write',
};
export const MCP_RESOURCE_KEYS = { accounts: 'mcp.accounts', calendars: 'mcp.calendars', addressBooks: 'mcp.addressBooks' };
export const MCP_STATE_KEYS: Record<string, string> = {
  pending: 'mcp.states.pending',
  approved: 'mcp.states.approved',
  executing: 'mcp.states.executing',
  succeeded: 'mcp.states.succeeded',
  partial: 'mcp.states.partial',
  failed: 'mcp.states.failed',
  uncertain: 'mcp.states.uncertain',
  denied: 'mcp.states.denied',
  expired: 'mcp.states.expired',
};


export function returnFromMcpApproval(): void {
  try {
    if (window.opener && !window.opener.closed) window.opener.focus();
  } catch { /* cross-origin opener focus can be refused */ }
  try { window.close(); } catch { /* browser may disallow closing a regular tab */ }
  window.setTimeout(() => {
    if (document.visibilityState === 'hidden') return;
    if (window.history.length > 1) window.history.back();
    else window.location.replace('/');
  }, 250);
}
