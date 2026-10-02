import { query, withTransaction } from '../../db.js';
import { googleConfigFromEnv, type FetchLike, type GoogleConfig } from '../../providerAuthService.js';
import { persistConversationCopyForRow } from '../../conversationRowIngest.js';
import { gmailSearchQuery } from '../../mailSearchRemoteQuery.js';
import type { RemoteSearchResult } from '../../mailSearchRemote.js';
import { fetchGmailMessageIds, fetchGmailMessage, localMessageForGmailMessage } from './gmailMail.js';
import { applyGmailMessage, gmailFolderPathByLabelId, syncGmailMailLabelsForAccount } from './gmailMailSync.js';
import { mapConcurrent } from '../../../utils/mapConcurrent.js';

// Request MIME structure without body.data. Header-only metadata cannot tell
// whether a multipart email has attachments and would corrupt has:attachment.
function mimeFields(depth: number): string {
  return `mimeType,filename,headers,body(size,attachmentId)${depth ? `,parts(${mimeFields(depth - 1)})` : ''}`;
}
export const GMAIL_SEARCH_FIELDS = `id,threadId,labelIds,snippet,internalDate,sizeEstimate,payload(${mimeFields(12)})`;

/** Read-only provider SEARCH hydrates metadata, not sync cursors or inbox rules. */
export async function ingestGmailMailSearch(input: {
  userId: string; accountId: string; connectionId: string; query: string;
  folders: string[] | null; maxResults?: number; config?: GoogleConfig; fetchImpl?: FetchLike;
}): Promise<RemoteSearchResult> {
  const api = { userId: input.userId, connectionId: input.connectionId, config: input.config ?? googleConfigFromEnv(), fetchImpl: input.fetchImpl, signal: AbortSignal.timeout(35000) };
  let paths = await gmailFolderPathByLabelId(input);
  if (!paths.size) { await syncGmailMailLabelsForAccount({ ...input, config: api.config }); paths = await gmailFolderPathByLabelId(input); }
  const selected = input.folders === null ? [null] : [...paths].filter(([, path]) => input.folders?.includes(path)).map(([label]) => label);
  const maximum = Math.min(1000, Math.max(1, input.maxResults ?? 200));
  const rowIds = new Set<string>(); const providerIds = new Set<string>(); let truncated = false;
  const errors: string[] = [];
  for (let labelIndex = 0; labelIndex < selected.length; labelIndex++) {
    let pageToken: string | null = null;
    const seenPages = new Set<string>();
    do {
      api.signal.throwIfAborted();
      const page = await fetchGmailMessageIds(api, { labelId: selected[labelIndex], q: gmailSearchQuery(input.query), includeSpamTrash: true,
        pageToken, maxResults: Math.min(100, maximum - providerIds.size) });
      const unique = page.messages.filter((message): message is typeof message & { id: string } => typeof message.id === 'string' && !providerIds.has(message.id)).slice(0, maximum - providerIds.size);
      for (const message of unique) providerIds.add(message.id);
      const pageIds = unique.map(reference => reference.id);
      const existing = pageIds.length ? await query<{ id: string; provider_message_id: string }>(`SELECT m.id,m.provider_message_id
        FROM messages m JOIN email_accounts a ON a.id=m.account_id
        WHERE m.account_id=$1 AND a.user_id=$2 AND m.provider_message_id=ANY($3::text[])`, [input.accountId,input.userId,pageIds]) : { rows: [] };
      const existingProviderIds = new Set(existing.rows.map(row => row.provider_message_id));
      for (const row of existing.rows) rowIds.add(row.id);
      const missing = unique.filter(reference => !existingProviderIds.has(reference.id));
      await mapConcurrent(missing, 4, async reference => {
        const message = await fetchGmailMessage(api, reference.id, 'full', GMAIL_SEARCH_FIELDS);
        if (!message) { errors.push('A search result disappeared before it could be loaded.'); return; }
        const local = localMessageForGmailMessage(message, { accountId: input.accountId, pathByLabelId: paths });
        if (!local) { errors.push('A search result could not be projected.'); return; }
        const applied = await withTransaction(client => applyGmailMessage(client, { accountId: input.accountId, pathByLabelId: paths }, local));
        if (!applied) { errors.push('A search result could not be projected.'); return; }
        rowIds.add(applied.id);
        await persistConversationCopyForRow(applied.id, { id: input.accountId, user_id: input.userId });
      });
      pageToken = page.nextPageToken;
      if (pageToken && seenPages.has(pageToken)) { truncated = true; errors.push('The mail server repeated a search page.'); break; }
      if (pageToken) seenPages.add(pageToken);
      if (providerIds.size >= maximum) { truncated ||= Boolean(pageToken) || labelIndex < selected.length - 1; break; }
    } while (pageToken);
    if (providerIds.size >= maximum) break;
  }
  return { rowIds: [...rowIds], truncated: truncated || errors.length > 0, ...(errors.length ? { errors: [...new Set(errors)] } : {}) };
}
