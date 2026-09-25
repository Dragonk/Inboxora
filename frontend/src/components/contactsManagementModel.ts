import { summariseProviderSyncErrors, type ProviderSyncErrorLike } from '../utils/providerSyncError.ts';

interface BookIdentity {
  id: string; source: string; accountId: string | null; connectionId: string | null; accountLabel: string | null;
}

/** Labels are presentation only. Unknown external sources remain isolated. */
export function groupBooksByConnection<T extends BookIdentity>(books: readonly T[]) {
  const groups = new Map<string, { id: string; source: string; accountLabel: string | null; books: T[] }>();
  for (const book of books) {
    const identity = book.source === 'local' ? ['local']
      : book.connectionId ? ['connection', book.connectionId, book.accountId]
        : book.accountId ? ['account', book.accountId] : ['book', book.id];
    const id = JSON.stringify([book.source, ...identity]);
    const group = groups.get(id) ?? { id, source: book.source, accountLabel: book.accountLabel, books: [] };
    group.books.push(book);
    groups.set(id, group);
  }
  const order = (source: string) => source === 'local' ? 0 : ['carddav', 'dav'].includes(source) ? 1 : source === 'google' ? 2 : source === 'microsoft' ? 3 : 4;
  return [...groups.values()].sort((a, b) => order(a.source) - order(b.source) || (a.accountLabel ?? '').localeCompare(b.accountLabel ?? ''));
}

export function providerSyncAccount(book: { source?: string | null; provider?: string | null; account_id?: string | null } | undefined, provider: 'google' | 'microsoft'): string | null {
  return book?.source === provider && book.provider === provider && book.account_id?.trim() ? book.account_id : null;
}

type WritableBook = { id: string; read_only?: boolean };
export function writableContactTarget<T extends WritableBook>(books: readonly T[], id: string): T | undefined {
  return books.find(book => book.id === id && book.read_only !== true);
}
export function initialContactTarget<T extends WritableBook>(books: readonly T[], selectedId: string): T | undefined {
  return writableContactTarget(books, selectedId) ?? books.find(book => book.read_only !== true);
}

export interface AccountContactsSyncResponse {
  state?: string;
  errorCode?: string | null;
  result?: { created?: number; updated?: number; deleted?: number; incomplete?: boolean; disabled?: boolean; error?: ProviderSyncErrorLike | null; errors?: ProviderSyncErrorLike[] };
}
export function accountContactsSyncMessage(response: AccountContactsSyncResponse, provider: 'google' | 'microsoft', t: (key: string, values?: Record<string, unknown>) => string): string {
  const result = response.result ?? {};
  const errors = [result.error, ...(result.errors ?? [])].filter((error): error is ProviderSyncErrorLike => !!error);
  if ((response.state !== 'success' || result.incomplete || result.disabled) && !errors.length) {
    errors.push({ code: response.errorCode ?? (result.disabled ? 'skipped_disabled' : result.incomplete ? 'incomplete' : response.state) ?? 'PROVIDER_ERROR' });
  }
  const counts = { created: result.created ?? 0, updated: result.updated ?? 0, deleted: result.deleted ?? 0, failed: errors.length };
  const summary = summariseProviderSyncErrors({ t, provider, feature: 'contacts', errors });
  const key = provider === 'google'
    ? summary ? 'contacts.addressBooks.googleSyncPartial' : 'contacts.addressBooks.googleSyncDone'
    : summary ? 'contacts.addressBooks.microsoftSyncPartial' : 'contacts.addressBooks.microsoftSyncDone';
  return [t(key, counts), ...(summary?.all.map(error => summariseProviderSyncErrors({ t, provider, feature: 'contacts', errors: [{ code: error.code, providerStatus: error.status, missingScopes: error.missingScopes }] })?.first) ?? [])].filter(Boolean).join(' ');
}
