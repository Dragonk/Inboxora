/**
 * Summarise the rows a provider status endpoint returns, for the connector status line.
 *
 * Two things here are deliberate rather than incidental:
 *
 * - Rows are de-duplicated by collection identity. The status query joins `sync_states`,
 *   whose unique key includes `coverage`, so a second row for the same collection is
 *   *permitted* by the schema — and a fan-out would silently double the total the line
 *   reports and list the collection twice. The invariant that only one row exists today
 *   rests on which code writes it, which is exactly the kind of invariant a UI should not
 *   depend on for correctness of a number.
 * - A recorded failure takes precedence over the success time, because "it worked
 *   yesterday" is no help when the last attempt failed.
 */
export interface ProviderSyncRow {
  lastSyncedAt?: string | null;
  lastErrorCode?: string | null;
  lastErrorAt?: string | null;
}

export interface ProviderSyncSummary {
  /** A locale key, or null when the caller should use its own success key. */
  key: string | null;
  values: Record<string, string>;
}

export function providerConnectorSummary<T extends ProviderSyncRow>(
  rows: readonly T[] | null | undefined,
  options: {
    /** The collection's identity, used to collapse a duplicated row. */
    id: (row: T) => string;
    /** How many records the collection holds, for the total. */
    count: (row: T) => number;
    /** The key to use for a failure the caller has no action sentence for. */
    failureKey: (code: string | null | undefined) => string;
  },
): ProviderSyncSummary | null {
  const unique = [...new Map((rows ?? []).map(row => [options.id(row), row])).values()];
  const failed = unique.find(row => row.lastErrorCode);
  if (failed) {
    // A failure always records when it happened; an absent time is shown as empty rather
    // than invented, and the caller's message decides whether to mention it.
    const when = failed.lastErrorAt ? new Date(failed.lastErrorAt).toLocaleString() : '';
    return { key: options.failureKey(failed.lastErrorCode), values: { code: String(failed.lastErrorCode), when } };
  }
  const times = unique.map(row => row.lastSyncedAt).filter((value): value is string => typeof value === 'string');
  if (!times.length) return null;
  const latest = [...times].sort().at(-1) as string;
  // The date is the freshest sync, the count is the total across the collections.
  const count = unique.reduce((total, row) => total + options.count(row), 0);
  return { key: null, values: { date: new Date(latest).toLocaleString(), count: String(count) } };
}
