/** A message row as the archive view sees it. */
export interface ArchiveMessage {
  id?: string;
  thread_id?: string;
  account_id?: string;
  folder?: string;
  is_read?: boolean;
  [key: string]: unknown;
}

/** The view-defining state the archive cache key is computed from. */
export interface ArchiveViewKeyInput {
  selectedAccountId?: string | null;
  selectedFolder?: string | null;
  searchQuery?: string | null;
  threadedView?: boolean;
  unreadOnly?: boolean;
  activeCategory?: string | null;
  currentPage?: number;
  searchAllFolders?: boolean;
  activeGtdTab?: string | null;
  pageSize?: number;
  scrollMode?: string | null;
  categorizationEnabled?: boolean;
  accountCategorizationEnabled?: boolean;
  unifiedInboxAccountKey?: string | null;
  showGtdTab?: boolean;
}

/** One visible row plus the physical copies a bulk archive will act on. */
export interface ArchiveTargetGroup<T extends ArchiveMessage = ArchiveMessage> {
  row: T;
  targets: ArchiveMessage[];
}

/** The archive endpoint's response for one chunk of ids. */
export interface ArchiveChunkResponse {
  archived?: string[];
  noArchiveFolder?: string[];
}

/** The merged result of archiving every chunk. */
export interface ArchiveChunksResult {
  archived: string[];
  noArchiveFolder: string[];
  unconfirmed: string[];
  error: unknown;
}

export function findVisibleArchiveMessage(messages: ArchiveMessage[] | null | undefined, selectedMessageId: string | null | undefined, threadMessages: Record<string, ArchiveMessage[]> = {}): ArchiveMessage | null {
  if (!selectedMessageId || !Array.isArray(messages)) return null;
  const direct = messages.find(message => message?.id === selectedMessageId);
  if (direct) return direct;

  return messages.find((message) => {
    const threadId = message?.thread_id || message?.id;
    if (!threadId) return false;
    const children = threadMessages[threadId];
    return Array.isArray(children) && children.some(child => child?.id === selectedMessageId);
  }) || null;
}

export function archiveViewKey({
  selectedAccountId,
  selectedFolder,
  searchQuery,
  threadedView,
  unreadOnly,
  activeCategory,
  currentPage,
  searchAllFolders,
  activeGtdTab,
  pageSize,
  scrollMode,
  categorizationEnabled,
  accountCategorizationEnabled,
  unifiedInboxAccountKey,
  showGtdTab,
}: ArchiveViewKeyInput): string {
  return JSON.stringify([
    selectedAccountId ?? null,
    selectedFolder ?? null,
    String(searchQuery || '').trim(),
    Boolean(threadedView),
    Boolean(unreadOnly),
    activeCategory ?? null,
    Number(currentPage) || 1,
    Boolean(searchAllFolders),
    activeGtdTab ?? null,
    Number(pageSize) || null,
    scrollMode ?? null,
    Boolean(categorizationEnabled),
    Boolean(accountCategorizationEnabled),
    unifiedInboxAccountKey ?? null,
    Boolean(showGtdTab),
  ]);
}

export function archiveTargetsForFolder<T extends ArchiveMessage, R extends ArchiveMessage>(
  message: T | null | undefined,
  resolvedMessages: readonly R[] | null | undefined,
  folder: string | null | undefined,
  isThreadRow: boolean,
  accountId: string | null = null,
): Array<T | R> {
  if (!message) return [];
  if (!isThreadRow) return [message];

  const seen = new Set<string>();
  const targets = (Array.isArray(resolvedMessages) ? resolvedMessages : []).filter((candidate) => {
    if (!candidate?.id || candidate.folder !== folder || seen.has(candidate.id)) return false;
    if (accountId && candidate.account_id !== accountId) return false;
    seen.add(candidate.id);
    return true;
  });
  if (
    message.id
    && message.folder === folder
    && (!accountId || message.account_id === accountId)
    && !seen.has(message.id)
  ) {
    targets.push(message);
  }
  return targets.length > 0 ? targets : [message];
}

export async function archiveTargetGroupsForRows<T extends ArchiveMessage>(
  messages: readonly T[] | null | undefined,
  resolveMessages: (message: T) => readonly ArchiveMessage[] | Promise<readonly ArchiveMessage[]>,
  folder: string | null | undefined,
  isThreadRow: (message: T) => boolean,
  accountId: string | null = null,
  concurrency = 8,
): Promise<Array<ArchiveTargetGroup<T>>> {
  const rows = Array.isArray(messages) ? messages : [];
  const groups: Array<ArchiveTargetGroup<T>> = [];
  for (let offset = 0; offset < rows.length; offset += concurrency) {
    const batch = await Promise.all(rows.slice(offset, offset + concurrency).map(async (row) => {
      const resolved = await resolveMessages(row);
      return {
        row,
        targets: archiveTargetsForFolder(row, resolved, folder, isThreadRow(row), accountId),
      };
    }));
    groups.push(...batch);
  }
  return groups;
}

export async function archiveInChunks(
  ids: string[],
  archive: (ids: string[]) => Promise<ArchiveChunkResponse>,
  chunkSize = 500,
): Promise<ArchiveChunksResult> {
  const archived: string[] = [];
  const noArchiveFolder: string[] = [];
  for (let offset = 0; offset < ids.length; offset += chunkSize) {
    try {
      const result = await archive(ids.slice(offset, offset + chunkSize));
      archived.push(...(result.archived || []));
      noArchiveFolder.push(...(result.noArchiveFolder || []));
    } catch (error) {
      return { archived, noArchiveFolder, unconfirmed: ids.slice(offset), error };
    }
  }
  return { archived, noArchiveFolder, unconfirmed: [], error: null };
}

export function unreadCountsByAccount(messages: ArchiveMessage[] | null | undefined): Map<string, number> {
  const counts = new Map<string, number>();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message?.account_id || message.is_read) continue;
    counts.set(message.account_id, (counts.get(message.account_id) || 0) + 1);
  }
  return counts;
}

export function currentThreadLoadVersion(versions: Map<string, number>, threadId: string): number {
  return versions.get(threadId) || 0;
}

export function invalidateThreadLoad(versions: Map<string, number>, threadId: string): number {
  const next = currentThreadLoadVersion(versions, threadId) + 1;
  versions.set(threadId, next);
  return next;
}

export function isCurrentThreadLoad(versions: Map<string, number>, threadId: string, version: number): boolean {
  return currentThreadLoadVersion(versions, threadId) === version;
}

export function removeThreadCacheEntry<T>(cache: Record<string, T[]> | null | undefined, threadId: string): Record<string, T[]> {
  const next = { ...(cache || {}) };
  delete next[threadId];
  return next;
}
