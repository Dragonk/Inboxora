/** A request belongs to the navigation which started it, not merely its React effect. */
export interface MailViewScope {
  authEpoch: number;
  selectedAccountId: string | null;
  selectedFolder: string;
  messagesRefreshToken: number;
}
export function mailViewScopeMatches(current: MailViewScope & { isLocked?: boolean }, expected: MailViewScope): boolean {
  return !current.isLocked && current.authEpoch === expected.authEpoch
    && current.selectedAccountId === expected.selectedAccountId
    && current.selectedFolder === expected.selectedFolder
    && current.messagesRefreshToken === expected.messagesRefreshToken;
}

/** Rollbacks may restore rows only to the mailbox which currently displays them. */
export function messageMatchesMailbox(row: { account_id?: unknown; folder?: unknown; folder_paths?: unknown; is_archived?: unknown },
  state: { selectedAccountId: string | null; selectedFolder: string; accounts: readonly { id: string; enabled?: boolean; include_in_unified_inbox?: boolean }[] }): boolean {
  if (state.selectedAccountId && row.account_id !== state.selectedAccountId) return false;
  if (!state.selectedAccountId) {
    const account = state.accounts.find(account => account.id === row.account_id);
    if (account?.enabled === false || account?.include_in_unified_inbox === false) return false;
  }
  const folder = state.selectedAccountId ? state.selectedFolder : 'INBOX';
  if (folder === 'Archive') return row.folder === folder || row.is_archived === true;
  if (row.is_archived === true) return false;
  return row.folder === undefined || row.folder === folder
    || (Array.isArray(row.folder_paths) && row.folder_paths.includes(folder));
}
