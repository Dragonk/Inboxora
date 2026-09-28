/** A concrete identity is chosen once, not recomputed when account settings refresh. */
export interface SenderAccount {
  id: string;
  default_alias_id?: string | null;
  aliases?: ReadonlyArray<{ id: string; email?: string | null }> | null;
}
export interface SenderDraft {
  accountId?: string;
  aliasId?: string | null;
  isReply?: boolean;
  isReplyAll?: boolean;
  draftUid?: number;
  draftRowId?: string;
}

export function initialComposeSender({ accounts, draft, selectedAccountId, lastUsedAccountId }: {
  accounts: readonly SenderAccount[];
  draft?: SenderDraft | null;
  selectedAccountId?: string | null;
  lastUsedAccountId?: string | null;
}): string {
  const accountId = draft?.accountId
    || (accounts.some(account => account.id === selectedAccountId) ? selectedAccountId : null)
    || (accounts.some(account => account.id === lastUsedAccountId) ? lastUsedAccountId : null)
    || accounts[0]?.id || '';
  if (!accountId) return '';
  // A saved/explicit alias must not silently fall back: the send/draft API refuses
  // unavailable aliases. Explicit null means the primary address, NOT the default.
  if (draft?.aliasId && draft.accountId) return `alias:${draft.aliasId}:${accountId}`;
  const preservePrimary = draft?.aliasId === null || draft?.isReply || draft?.isReplyAll
    || draft?.draftUid != null || !!draft?.draftRowId;
  const account = accounts.find(candidate => candidate.id === accountId);
  const defaultAlias = !preservePrimary && account?.aliases?.find(alias =>
    alias.id === account.default_alias_id && !!alias.email?.trim());
  return defaultAlias ? `alias:${defaultAlias.id}:${accountId}` : `account:${accountId}`;
}
