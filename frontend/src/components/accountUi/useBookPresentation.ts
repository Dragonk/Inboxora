import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../utils/api.ts';
import { useStore } from '../../store/index.ts';
import { reconcileSelection, unique, type BookIdentity } from './model.ts';
interface Preferences { selectedIds: string[] | null; collapsedSourceIds: string[] }
const DEFAULT: Preferences = { selectedIds: null, collapsedSourceIds: [] };
function parse(value: unknown): Preferences {
  if (!value || typeof value !== 'object') return DEFAULT;
  const row = value as Record<string, unknown>;
  return { selectedIds: Array.isArray(row.selectedIds) ? unique(row.selectedIds.filter((id): id is string => typeof id === 'string')) : null,
    collapsedSourceIds: Array.isArray(row.collapsedSourceIds) ? unique(row.collapsedSourceIds.filter((id): id is string => typeof id === 'string')) : [] };
}
/** One durable per-user preference. The empty set never means "all". */
export default function useBookPresentation(books: readonly BookIdentity[], booksLoaded: boolean, enabled: boolean) {
  const epoch = useStore(state => state.authEpoch);
  const [preferences, setPreferences] = useState<Preferences>(DEFAULT);
  const [ready, setReady] = useState(false); const [failed, setFailed] = useState(false);
  const scope = useRef(0); const revision = useRef(0); const confirmed = useRef<Preferences>(DEFAULT);
  const current = useRef<Preferences>(DEFAULT); const queue = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    const generation = ++scope.current; current.current = DEFAULT; confirmed.current = DEFAULT;
    queue.current = Promise.resolve(); revision.current++; setPreferences(DEFAULT); setReady(false); setFailed(false);
    if (!enabled) return;
    void api.contactPresentation.get().then((result: unknown) => {
      if (generation !== scope.current || useStore.getState().authEpoch !== epoch) return;
      const parsed = parse(result); current.current = parsed; confirmed.current = parsed; setPreferences(parsed); setReady(true);
    }).catch(() => { if (generation === scope.current && useStore.getState().authEpoch === epoch) { setFailed(true); setReady(true); } });
    const cancel = () => { scope.current++; revision.current++; };
    return cancel;
  }, [epoch, enabled]);
  const save = useCallback((patch: Partial<Preferences>) => {
    if (!enabled || !ready || useStore.getState().authEpoch !== epoch) return;
    const generation = scope.current; const request = ++revision.current;
    const next = { ...current.current, ...patch }; current.current = next; setPreferences(next); setFailed(false);
    const stillCurrent = () => generation === scope.current && useStore.getState().authEpoch === epoch;
    // Serialised field patches prevent rapid clicks from losing selections.
    queue.current = queue.current.then(async () => {
      if (!stillCurrent()) return;
      try {
        const result = parse(await api.contactPresentation.update(patch));
        if (!stillCurrent()) return;
        confirmed.current = result;
        if (request === revision.current) { current.current = result; setPreferences(result); }
      } catch {
        if (stillCurrent()) { setFailed(true); if (request === revision.current) { current.current = confirmed.current; setPreferences(confirmed.current); } }
      }
    });
  }, [enabled, epoch, ready]);
  const selectedIds = useMemo(() => reconcileSelection(preferences.selectedIds, books).filter(id => books.some(book => book.id === id && book.visible !== false)), [preferences.selectedIds, books]);
  return { selectedIds, ready: ready && booksLoaded, failed, collapsed: preferences.collapsedSourceIds,
    setSelected: (ids: string[]) => save({ selectedIds: unique(ids) }),
    setCollapsed: (id: string, collapsed: boolean) => save({ collapsedSourceIds: collapsed ? unique([...current.current.collapsedSourceIds, id]) : current.current.collapsedSourceIds.filter(sourceId => sourceId !== id) }) };
}
