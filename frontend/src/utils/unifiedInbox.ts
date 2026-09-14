/** The account fields the unified-inbox helpers read. */
type UnifiedInboxAccountLike = {
  id: string;
  enabled?: boolean;
  include_in_unified_inbox?: boolean;
  [key: string]: unknown;
};

export function isAccountInUnifiedInbox(account: UnifiedInboxAccountLike | undefined) {
  return !!account?.enabled && account.include_in_unified_inbox !== false;
}

export function accountAffectsUnifiedInbox(accounts: UnifiedInboxAccountLike[], accountId: string): boolean {
  const account = accounts.find(candidate => candidate.id === accountId);
  return isAccountInUnifiedInbox(account);
}

export function unifiedUnreadTotal(byAccount: Record<string, number>, accounts: UnifiedInboxAccountLike[]): number {
  return accounts.reduce((total, account) => (
    isAccountInUnifiedInbox(account)
      ? total + (Number(byAccount[account.id]) || 0)
      : total
  ), 0);
}
