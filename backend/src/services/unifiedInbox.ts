export interface UnifiedInboxAccount {
  id: string;
  include_in_unified_inbox?: boolean | null;
}

// The accounts parameter intentionally stays structurally open at this boundary:
// callers pass raw DbRow[] query results (Record<string, unknown>) whose id column is untyped.
export function resolveAccountScope(accounts: ReadonlyArray<UnifiedInboxAccount>, requestedAccountId: string | null = null) {
  const ownedIds = accounts.map((account: UnifiedInboxAccount) => account.id);
  const isSpecificAccount = requestedAccountId && ownedIds.includes(requestedAccountId);

  return {
    accountIds: isSpecificAccount
      ? [requestedAccountId]
      : accounts
        .filter((account: UnifiedInboxAccount) => account.include_in_unified_inbox !== false)
        .map((account: UnifiedInboxAccount) => account.id),
    resolvedAccountId: isSpecificAccount ? requestedAccountId : null,
  };
}
