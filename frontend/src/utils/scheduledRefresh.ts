/** Coalesce reads without starving slow responses; mutation invalidation fences stale snapshots. */
export function createScheduledRefresh<T>({ load, apply, failed, current }: {
  load: () => Promise<T>; apply: (value: T) => void; failed: () => void; current: () => boolean;
}) {
  let active = false;
  let queued = false;
  let revision = 0;
  const refresh = () => {
    if (!current()) return;
    if (active) { queued = true; return; }
    active = true;
    const startedRevision = revision;
    void load().then(value => {
      if (current() && startedRevision === revision) apply(value);
    }).catch(() => {
      if (current() && startedRevision === revision) failed();
    }).finally(() => {
      active = false;
      if (queued && current()) { queued = false; refresh(); }
    });
  };
  const invalidate = () => { revision += 1; };
  return { refresh, invalidate };
}
