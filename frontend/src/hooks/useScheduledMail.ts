import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.ts';
import { scheduledApi, scheduledEditToDraft, type ScheduledSummary, type ScheduleSelection } from '../utils/scheduledMail.ts';
import { createScheduledRefresh } from '../utils/scheduledRefresh.ts';
import { mergeScheduledVisit } from '../utils/scheduledVisit.ts';
import { toAppError } from '../utils/errors.ts';

interface Visit {
  items: ScheduledSummary[]; pages: number; acknowledged: Set<string>; pending: Set<string>; failed: Set<string>;
  current: () => boolean; refresh: () => void; invalidate: () => void;
}
/** Mounted once in the app shell: navigating or resizing cannot stop Undo or reset a queue visit. */
export function useScheduledMail() {
  const { t } = useTranslation();
  const userId = useStore(state => state.user?.id);
  const authEpoch = useStore(state => state.authEpoch);
  const locked = useStore(state => state.isLocked);
  const shown = useStore(state => state.showScheduled);
  const admin = useStore(state => state.showAdmin);
  const active = Boolean(userId && !locked && shown && !admin);
  const [globalItems, setGlobalItems] = useState<ScheduledSummary[]>([]);
  const [items, setItems] = useState<ScheduledSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [picker, setPicker] = useState<ScheduledSummary | null>(null);
  const [error, setErrorKey] = useState('');
  const [loadError, setLoadError] = useState(false);
  const [seenError, setSeenError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [previewRefresh, setPreviewRefresh] = useState(0);
  const visit = useRef<Visit | null>(null);
  const refreshGlobal = useRef(() => {});
  const invalidateGlobal = useRef(() => {});
  const operation = useRef(0);
  const open = useCallback(() => {
    const state = useStore.getState();
    if (!state.user || state.isLocked) return;
    state.setShowAdmin(false); state.setShowScheduled(true);
  }, []);
  const refresh = useCallback(() => { refreshGlobal.current(); visit.current?.refresh(); }, []);
  const invalidate = useCallback(() => { invalidateGlobal.current(); visit.current?.invalidate(); }, []);
  const refreshView = useCallback(() => { setPreviewRefresh(value => value + 1); refresh(); }, [refresh]);

  useLayoutEffect(() => {
    const controller = new AbortController();
    const current = () => !controller.signal.aborted && useStore.getState().authEpoch === authEpoch
      && useStore.getState().user?.id === userId && !useStore.getState().isLocked;
    operation.current++; busyRef.current = false; setBusy(null); setErrorKey(''); setGlobalItems([]);
    if (!userId || locked) return () => controller.abort();
    const feed = createScheduledRefresh({ load: () => scheduledApi.list(controller.signal),
      apply: setGlobalItems, failed: () => {}, current });
    refreshGlobal.current = feed.refresh; invalidateGlobal.current = feed.invalidate;
    const changed = () => { invalidate(); refresh(); };
    const visible = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('inboxora:open-scheduled', open);
    window.addEventListener('inboxora:scheduled-changed', changed);
    window.addEventListener('online', refresh); window.addEventListener('pageshow', refresh);
    document.addEventListener('visibilitychange', visible);
    feed.refresh();
    const poll = window.setInterval(refresh, 5000);
    const endSession = () => { controller.abort(); operation.current++; busyRef.current = false; };
    return () => {
      endSession();
      refreshGlobal.current = () => {}; invalidateGlobal.current = () => {};
      window.clearInterval(poll);
      window.removeEventListener('inboxora:open-scheduled', open);
      window.removeEventListener('inboxora:scheduled-changed', changed);
      window.removeEventListener('online', refresh); window.removeEventListener('pageshow', refresh);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [authEpoch, userId, locked, open, refresh, invalidate]);

  useLayoutEffect(() => {
    setItems([]); setSelectedId(null); setPicker(null); setLoadError(false); setSeenError(false); setHasMore(false);
    if (!active) { visit.current = null; setLoading(false); return; }
    const controller = new AbortController();
    const current = () => !controller.signal.aborted && visit.current === currentVisit
      && useStore.getState().authEpoch === authEpoch && useStore.getState().user?.id === userId
      && useStore.getState().showScheduled && !useStore.getState().showAdmin && !useStore.getState().isLocked;
    const currentVisit: Visit = { items: [], pages: 1, acknowledged: new Set(), pending: new Set(), failed: new Set(),
      current, refresh: () => {}, invalidate: () => {} };
    visit.current = currentVisit;
    const feed = createScheduledRefresh({ current,
      load: async () => {
        const fresh: ScheduledSummary[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < currentVisit.pages; page++) {
          const result = await scheduledApi.page(controller.signal, cursor);
          fresh.push(...result.items); cursor = result.nextCursor ?? undefined;
          if (!cursor || !current()) break;
        }
        return { fresh, hasMore: Boolean(cursor) };
      },
      apply: result => {
        currentVisit.items = mergeScheduledVisit(currentVisit.items, result.fresh);
        setItems(currentVisit.items); setHasMore(result.hasMore); setLoading(false); setLoadError(false);
      }, failed: () => { setLoading(false); setLoadError(true); },
    });
    currentVisit.refresh = feed.refresh; currentVisit.invalidate = feed.invalidate;
    setLoading(true); feed.refresh();
    return () => { controller.abort(); if (visit.current === currentVisit) visit.current = null; };
  }, [active, authEpoch, userId]);

  const acknowledge = useCallback((id: string) => {
    const currentVisit = visit.current;
    if (!currentVisit?.current() || currentVisit.acknowledged.has(id) || currentVisit.pending.has(id)
      || !currentVisit.items.some(row => row.id === id && row.state === 'sent')) return;
    currentVisit.pending.add(id);
    void scheduledApi.seen(id).then(() => {
      if (!currentVisit.current()) return;
      currentVisit.acknowledged.add(id); currentVisit.failed.delete(id);
      setSeenError(currentVisit.failed.size > 0);
    }).catch(() => {
      if (!currentVisit.current()) return;
      currentVisit.failed.add(id); setSeenError(true);
    }).finally(() => { currentVisit.pending.delete(id); });
  }, []);
  const more = () => {
    const currentVisit = visit.current;
    if (!currentVisit?.current() || loading || !hasMore) return;
    currentVisit.pages++; setLoading(true); currentVisit.invalidate(); currentVisit.refresh();
  };
  const act = async (row: ScheduledSummary, kind: 'edit' | 'cancel' | 'reschedule' | 'dismiss', selection?: ScheduleSelection) => {
    const state = useStore.getState();
    if (busyRef.current || !state.user || state.isLocked || state.authEpoch !== authEpoch) return;
    if (kind === 'dismiss' && row.state !== 'uncertain') return;
    if (kind === 'edit' && state.composing && !(row.mode === 'undo' && row.state === 'pending')) {
      setErrorKey('queue.composeOpen'); return;
    }
    if ((kind === 'cancel' || kind === 'dismiss') && !window.confirm(t(kind === 'cancel' ? 'queue.cancelConfirm' : 'queue.dismissConfirm'))) return;
    const serial = ++operation.current;
    const current = () => operation.current === serial && useStore.getState().authEpoch === authEpoch
      && useStore.getState().user?.id === userId && !useStore.getState().isLocked;
    busyRef.current = true; setBusy(row.id); setErrorKey(''); invalidate();
    try {
      if (kind === 'edit') {
        const edit = await scheduledApi.edit(row.id, row.revision);
        if (!current()) return;
        const latest = useStore.getState();
        if (latest.composing) latest.addNotification({ type: 'info', title: t('queue.undo'), message: t('queue.pausedAvailable'), duration: 15000 });
        else latest.openCompose(scheduledEditToDraft(edit));
      } else if (kind === 'cancel') await scheduledApi.cancel(row.id, row.revision);
      else if (kind === 'dismiss') await scheduledApi.dismiss(row.id, row.revision);
      else if (selection) await scheduledApi.reschedule(row.id, { revision: row.revision, ...selection });
      if (current()) setPicker(null);
    } catch (caught) {
      if (current()) setErrorKey(toAppError(caught).status === 409 ? 'queue.conflict' : 'queue.actionError');
    } finally {
      if (current()) { busyRef.current = false; setBusy(null); invalidate(); refresh(); }
    }
  };
  return { active, shown, authEpoch, items, globalItems, selectedId, select: setSelectedId, picker, setPicker: (row: ScheduledSummary | null) => { setErrorKey(''); setPicker(row); },
    error, loadError, seenError, loading, hasMore, busy, previewRefresh, refreshView, refresh, more, acknowledge, act, open };
}
export type ScheduledMailController = ReturnType<typeof useScheduledMail>;
