import { query } from './db.js';
export async function mailIndexDiagnostics(userId: string, accountId: string, imapRunning: boolean) {
  const result = await query<{ last_folder_sync: string | null; last_sync: string | null; reindex_requested_at: string | null; reindex_completed_at: string | null; reindex_error: string | null; mail_transport: string | null; folders: number; messages: number }>(`
    SELECT a.last_folder_sync, a.last_sync, a.reindex_requested_at, a.reindex_completed_at, a.reindex_error, a.mail_transport,
      (SELECT COUNT(*)::int FROM folders WHERE account_id = a.id) AS folders,
      (SELECT COUNT(*)::int FROM messages WHERE account_id = a.id AND is_deleted = false) AS messages
    FROM email_accounts a WHERE a.id = $1 AND a.user_id = $2`, [accountId, userId]);
  const account = result.rows[0];
  if (!account) return null;
  const states = await query<{ coverage: string; last_success_at: string | null; last_error_code: string | null; running: boolean; incomplete: boolean; reindex_started_at: string | null; reindex_finished_at: string | null }>(`
    SELECT coverage, last_success_at, last_error_code, COALESCE(lease_expires_at > NOW(), false) AS running,
      (cursor IS NULL OR page_checkpoint IS NOT NULL) AS incomplete, reindex_started_at, reindex_finished_at
    FROM sync_states s WHERE user_id = $1 AND account_id = $2 AND feature = 'mail'
      AND EXISTS (SELECT 1 FROM email_accounts a WHERE a.id=s.account_id AND a.user_id=s.user_id
        AND a.provider_connection_id=s.connection_id)
      AND (s.collection_id IS NULL OR EXISTS (SELECT 1 FROM integration_collections c
        WHERE c.id=s.collection_id AND c.user_id=s.user_id AND c.connection_id=s.connection_id AND c.enabled))`, [userId, accountId]);
  const native = ['gmail_api', 'microsoft_graph'].includes(account.mail_transport || '');
  const messages = states.rows.filter(state => ['messages', 'history'].includes(state.coverage));
  const folders = states.rows.filter(state => ['folders', 'labels'].includes(state.coverage));
  const after = (left: string | null, right: string | null) => Boolean(left && (!right || new Date(left).getTime() >= new Date(right).getTime()));
  const pending = native ? Boolean(account.reindex_requested_at && (!messages.length || messages.some(state =>
    !after(state.reindex_started_at, account.reindex_requested_at) || !after(state.reindex_finished_at, state.reindex_started_at))))
    : Boolean(account.reindex_requested_at && !after(account.reindex_completed_at, account.reindex_requested_at));
  const failed = native ? messages.some(state => state.last_error_code) || (pending && Boolean(account.reindex_error)) : Boolean(account.reindex_error);
  const running = native ? messages.some(state => state.running) : imapRunning;
  const lastFolderSync = folders.map(state => state.last_success_at).filter((value): value is string => Boolean(value))
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] || account.last_folder_sync;
  return { status: running ? 'running' : failed ? 'failed' : pending ? 'pending' : (native ? messages.length > 0 && messages.every(state => !state.incomplete) : Boolean(account.last_sync)) ? 'ready' : 'unknown',
    messages: account.messages, folders: account.folders, lastFolderSync, requestedAt: account.reindex_requested_at };
}
