import { query } from './db.js';
import { providerIntegrationsEnabled } from './providerSwitches.js';
import { ingestGraphMailSearch } from './providers/microsoft/graphMailSearch.js';
import { ingestGmailMailSearch } from './providers/google/gmailMailSearch.js';
import { graphSearchQuery } from './mailSearchRemoteQuery.js';
import { digest } from '../mcp/config.js';

export interface RemoteSearchResult { rowIds: string[]; truncated: boolean; errors?: string[]; }
export interface RemoteSearchInput { userId: string; accountId: string; query: string; folders: string[] | null; maxResults: number; }
export interface RemoteSearchAccount { id: string; user_id: string; mail_transport?: string | null; provider_connection_id?: string | null; }
let imapSearch: ((input: RemoteSearchInput) => Promise<RemoteSearchResult>) | undefined;
export function registerImapMailSearch(search: (input: RemoteSearchInput) => Promise<RemoteSearchResult>): void { imapSearch = search; }
const inFlight = new Map<string, Promise<RemoteSearchResult>>();
const completed = new Map<string, { until: number; result: RemoteSearchResult }>();
/** Only provider-hit IDs are cached. Every response still applies live ownership,
 * label membership and integration restrictions in SQL before pagination. */
export async function searchRemoteAccount(account: RemoteSearchAccount, input: Omit<RemoteSearchInput, 'userId' | 'accountId'>): Promise<RemoteSearchResult> {
  if (input.folders?.length === 0) return { rowIds: [], truncated: false };
  const key = digest(JSON.stringify([account.user_id, account.id, account.mail_transport, account.provider_connection_id, input]));
  const now = Date.now(); const cached = completed.get(key);
  if (cached && cached.until > now) return cached.result;
  const pending = inFlight.get(key); if (pending) return pending;
  if (inFlight.size >= 40) return { rowIds: [], truncated: true, errors: ['Remote search capacity reached. Retry shortly.'] };
  const operation = (async (): Promise<RemoteSearchResult> => {
    if (account.mail_transport === 'microsoft_graph' || account.mail_transport === 'gmail_api') {
      if (!providerIntegrationsEnabled()) return { rowIds: [], truncated: true, errors: ['Provider integrations are disabled; only locally synchronized mail was searched.'] };
      if (!account.provider_connection_id) return { rowIds: [], truncated: true, errors: ['This native account needs to be reconnected.'] };
      const args = { userId: account.user_id, accountId: account.id, connectionId: account.provider_connection_id, maxResults: input.maxResults };
      if (account.mail_transport === 'gmail_api') return ingestGmailMailSearch({ ...args, query: input.query, folders: input.folders });
      const result = await ingestGraphMailSearch({ ...args, query: graphSearchQuery(input.query), folders: input.folders });
      return { rowIds: result.rowIds, truncated: result.truncated || result.unresolvedFolders > 0 };
    }
    if (!imapSearch) return { rowIds: [], truncated: true, errors: ['IMAP search is unavailable; only locally synchronized mail was searched.'] };
    return imapSearch({ ...input, userId: account.user_id, accountId: account.id });
  })();
  inFlight.set(key, operation);
  try {
    const result = await operation;
    for (const [id, entry] of completed) if (entry.until <= now) completed.delete(id);
    if (completed.size >= 300) completed.delete(completed.keys().next().value!);
    completed.set(key, { until: Date.now() + 15000, result });
    return result;
  } finally { inFlight.delete(key); }
}
/** Resolve exact folders before remote calls. In: aliases are evaluated by the
 * same case-insensitive full/leaf matching as the final SQL predicate. */
export async function remoteSearchFolders(accountId: string, scope: string | null, fuzzy: boolean,
  allowed: Array<{ accountId: string; path: string }> | null | undefined): Promise<string[] | null> {
  if (!scope && allowed == null) return null;
  const rows = await query<{ path: string }>('SELECT path FROM folders WHERE account_id=$1', [accountId]);
  return rows.rows.filter(folder => (!scope || (fuzzy ? folder.path.toLocaleLowerCase() === scope.toLocaleLowerCase()
    || folder.path.toLocaleLowerCase().endsWith(`/${scope.toLocaleLowerCase()}`) : folder.path === scope))
    && (allowed == null || allowed.some(item => item.accountId === accountId && item.path === folder.path))).map(folder => folder.path);
}


/** Bound the whole request, not 35 seconds per account in the worker queue.
 * In-flight, coalesced provider reads retain their own finite transport deadlines.
 * A late result never mutates the already returned partial response.
 */
export async function waitForRemoteSearch(run: () => Promise<RemoteSearchResult>, deadline: number): Promise<RemoteSearchResult> {
  const partial = (): RemoteSearchResult => ({rowIds:[],truncated:true,errors:['The remote search deadline was reached. Locally synchronized matches are shown; retry to include newly cached server results.']});
  const remaining = deadline - Date.now();
  if (remaining <= 0) return partial();
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operation = run().catch(error => {
    if (expired) console.warn('Late remote mail search failed:', error instanceof Error ? error.name : 'UnknownError');
    throw error;
  });
  try {
    return await Promise.race([operation, new Promise<RemoteSearchResult>(resolve => {
      timer = setTimeout(() => { expired = true; resolve(partial()); }, remaining);
      timer.unref();
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
