// Keep client-side navigation state pointing only at accounts that still exist.
//
// selectedAccountId is restored from localStorage at startup and was never checked against
// the account list. Deleting the account you had selected therefore left the client pinned to
// an id the server no longer knows, and localStorage made it survive reloads. The symptoms
// looked unrelated to each other and none of them named the cause: the mailbox rendered empty,
// every folder poll for the dead account returned 404 on a 60s loop, and the favicon badge read
// `byAccount[selectedAccountId] ?? 0`, so it showed nothing while other accounts genuinely had
// unread mail.
//
// Both helpers return the input unchanged when they cannot improve on it, including the same
// object reference for folders, so a no-op cannot trigger a re-render.

type AccountWithId = { id: string };

function hasAccountId(value: unknown): value is AccountWithId {
  return typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string';
}

function liveAccountIds(accounts: unknown): Set<string> | null {
  if (!Array.isArray(accounts)) return null;

  const ids = new Set<string>();
  const entries: unknown[] = accounts;
  for (const account of entries) {
    if (hasAccountId(account)) ids.add(account.id);
  }
  return ids;
}

/**
 * The account that should be selected, given the accounts that actually exist.
 * Returns null for the unified inbox, which is the right fallback: it is always valid.
 */
export function resolveSelectedAccount(accounts: unknown, selectedAccountId: string | null | undefined): string | null {
  if (!selectedAccountId) return null;                    // already the unified inbox
  const live = liveAccountIds(accounts);
  if (live === null) return selectedAccountId;            // list unknown, do not guess
  return live.has(selectedAccountId) ? selectedAccountId : null;
}

/** Drop cached folder lists belonging to accounts that no longer exist. */
export function pruneFolders<Value, Folders extends Record<string, Value> | null>(folders: Folders, accounts: unknown) {
  const live = liveAccountIds(accounts);
  if (!folders || live === null) return folders;

  const entries = Object.entries(folders);
  const kept = entries.filter(([id]) => live.has(id));
  if (kept.length === entries.length) return folders;     // unchanged: preserve identity
  return Object.fromEntries(kept);
}
