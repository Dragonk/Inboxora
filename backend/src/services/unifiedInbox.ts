export interface UnifiedInboxAccount {
  id: string;
  include_in_unified_inbox?: boolean | null;
}

/** An explicit unavailable account never widens to the unified inbox. */
export function resolveAccountScope(accounts: ReadonlyArray<UnifiedInboxAccount>, requestedAccountId: string | null = null) {
  if (requestedAccountId) {
    return {
      accountIds: accounts.some(account => account.id === requestedAccountId) ? [requestedAccountId] : [],
      resolvedAccountId: requestedAccountId,
    };
  }
  return {
    accountIds: accounts.filter(account => account.include_in_unified_inbox !== false).map(account => account.id),
    resolvedAccountId: null,
  };
}
