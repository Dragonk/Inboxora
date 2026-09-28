import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.ts';
import { isCurrentAuthEpoch } from '../utils/authEpoch.ts';
import { scheduledApi, scheduledEditToDraft, type ScheduledSummary, type ScheduleSelection } from '../utils/scheduledMail.ts';
import { schedulePreview } from '../utils/scheduleTime.ts';
import { createScheduledRefresh } from '../utils/scheduledRefresh.ts';
import SchedulePicker from './SchedulePicker.tsx';
import { useBackLayer } from '../hooks/useBackNavigation.ts';

/** Display metadata and versioned actions scoped to the current unlocked auth session. */
export default function ScheduledMail() {
  const { t, i18n } = useTranslation();
  const user = useStore(state => state.user);
  const authEpoch = useStore(state => state.authEpoch);
  const isLocked = useStore(state => state.isLocked);
  const composing = useStore(state => state.composing);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ScheduledSummary[]>([]);
  const [error, setErrorKey] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [picker, setPicker] = useState<ScheduledSummary | null>(null);
  const [now, setNow] = useState(Date.now());
  const lifecycle = useRef(0);
  const operation = useRef(0);
  const refreshRef = useRef<() => void>(() => {});
  const invalidateRef = useRef<() => void>(() => {});
  useBackLayer(open, () => { setPicker(null); setOpen(false); }, 3000);

  /** Poll only within this auth lifecycle; cleanup invalidates late reads and mutations. */
  useEffect(() => {
    const generation = ++lifecycle.current;
    setItems([]); setOpen(false); setPicker(null); setBusy(null); setErrorKey('');
    if (!user || isLocked) return;
    const controller = new AbortController();
    /** Reject polling results from a closed view or a different authenticated session. */
    const current = () => lifecycle.current === generation && isCurrentAuthEpoch(authEpoch) && !useStore.getState().isLocked;
    const { refresh, invalidate } = createScheduledRefresh({
      load: () => scheduledApi.list(controller.signal),
      apply: rows => setItems(rows),
      failed: () => { if (!controller.signal.aborted) setErrorKey('queue.loadError'); },
      current,
    });
    /** Invalidate any in-flight metadata read before fetching post-mutation state. */
    const onChanged = () => { invalidate(); refresh(); };
    /** Open and refresh only while this listener still belongs to the active session. */
    const onOpen = () => { if (current()) { setOpen(true); refresh(); } };
    /** Refresh metadata when the document becomes visible after background suspension. */
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    refreshRef.current = onChanged;
    invalidateRef.current = invalidate;
    refresh();
    const poll = window.setInterval(refresh, 5000);
    const tick = window.setInterval(() => { if (current()) setNow(Date.now()); }, 1000);
    window.addEventListener('online', refresh);
    window.addEventListener('pageshow', refresh);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('inboxora:scheduled-changed', onChanged);
    window.addEventListener('inboxora:open-scheduled', onOpen);
    return () => {
      lifecycle.current = generation + 1; controller.abort();
      clearInterval(poll); clearInterval(tick);
      refreshRef.current = () => {};
      invalidateRef.current = () => {};
      window.removeEventListener('online', refresh);
      window.removeEventListener('pageshow', refresh);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('inboxora:scheduled-changed', onChanged);
      window.removeEventListener('inboxora:open-scheduled', onOpen);
    };
  }, [user, authEpoch, isLocked]);

  /** Confirm destructive actions and fence every completion against auth and operation changes. */
  const act = useCallback(async (row: ScheduledSummary, kind: 'edit' | 'cancel' | 'reschedule' | 'dismiss', selection?: ScheduleSelection) => {
    if (busy || !user || isLocked || !isCurrentAuthEpoch(authEpoch)) return;
    if (kind === 'dismiss' ? row.state !== 'uncertain' : ['uncertain', 'dismissed'].includes(row.state)) return;
    if (kind === 'edit' && useStore.getState().composing && !(row.mode === 'undo' && row.state === 'pending')) { setErrorKey('queue.composeOpen'); return; }
    if (kind === 'cancel' && !window.confirm(t('queue.cancelConfirm'))) return;
    if (kind === 'dismiss' && !window.confirm(t('queue.dismissConfirm'))) return;
    if (!isCurrentAuthEpoch(authEpoch) || useStore.getState().isLocked) return;
    const generation = lifecycle.current;
    const serial = ++operation.current;
    /** Prevent late action receipts from mutating another session or newer operation. */
    const current = () => generation === lifecycle.current && serial === operation.current && isCurrentAuthEpoch(authEpoch) && !useStore.getState().isLocked;
    setBusy(row.id); setErrorKey(''); invalidateRef.current();
    try {
      if (kind === 'edit') {
        const edit = await scheduledApi.edit(row.id, row.revision);
        if (!current()) return;
        // Another editor may have opened while the atomic server pause was pending.
        if (useStore.getState().composing) {
          useStore.getState().addNotification({ type: 'info', title: t('queue.pausedAvailable'), persistent: true });
          return;
        }
        useStore.getState().openCompose(scheduledEditToDraft(edit));
        setOpen(false);
      } else if (kind === 'dismiss') await scheduledApi.dismiss(row.id, row.revision);
      else if (kind === 'cancel') await scheduledApi.cancel(row.id, row.revision);
      else if (selection) await scheduledApi.reschedule(row.id, { revision: row.revision, ...selection });
      if (current()) setPicker(null);
    } catch (cause) {
      if (current()) setErrorKey(cause instanceof Error && cause.status === 409 ? 'queue.conflict' : 'queue.actionError');
    } finally {
      if (current()) { setBusy(null); refreshRef.current(); }
    }
  }, [authEpoch, busy, isLocked, t, user]);

  if (!user || isLocked) return null;
  const states = { pending: t('queue.states.pending'), editing: t('queue.states.editing'), preparing: t('queue.states.preparing'), sending: t('queue.states.sending'), sent: t('queue.states.sent'), partial: t('queue.states.partial'), failed: t('queue.states.failed'), uncertain: t('queue.states.uncertain'), cancelled: t('queue.states.cancelled'), dismissed: t('queue.states.dismissed') };
  const undo = items.filter(row => row.mode === 'undo' && row.state === 'pending' && Date.parse(row.scheduledAt) > now);
  return <>
    {!open && undo.length > 0 && <aside aria-label={t('queue.title')} style={{ position: 'fixed', bottom: 16, left: 16, zIndex: 11000, padding: 12, background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 10, maxWidth: 'calc(100vw - 32px)' }}>
      {undo.map(row => <div key={row.id} style={{ display: 'flex', gap: 12, alignItems: 'center' }}><span>{t('queue.countdown', { count: Math.max(0, Math.ceil((Date.parse(row.scheduledAt) - now) / 1000)) })}</span><button data-testid={`scheduled-undo-${row.id}`} disabled={!!busy} onClick={() => void act(row, 'edit')}>{t('queue.undo')}</button></div>)}
      <button onClick={() => setOpen(true)}>{t('queue.title')}</button>
      {error && <p role="alert">{t(error)}</p>}
    </aside>}
    {open && <section role="dialog" aria-modal="true" aria-label={t('queue.title')} data-testid="scheduled-view" style={{ position: 'fixed', inset: 0, zIndex: 2500, background: 'var(--bg-primary)', color: 'var(--text-primary)', padding: 20, overflow: 'auto', paddingBottom: 'calc(20px + var(--sab, 0px))' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}><h1>{t('queue.title')}</h1><button onClick={() => setOpen(false)}>{t('common.close')}</button></div>
      <button onClick={() => refreshRef.current()}>{t('queue.refresh')}</button>
      {error && <p role="alert">{t(error)}</p>}
      {!items.length && <p>{t('queue.empty')}</p>}
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {items.map(row => <li key={row.id} data-testid={`scheduled-item-${row.id}`} style={{ padding: '18px 0', borderBottom: '1px solid var(--border)' }}>
          <h2 style={{ fontSize: 18 }}>{row.subject || t('queue.noSubject')}</h2>
          <p>{states[row.state]}</p>
          <p>{schedulePreview(row.scheduledAt, row.timeZone, i18n.language)}</p>
          {row.state === 'uncertain' && <p role="alert">{t('queue.uncertainWarning')}</p>}
          {row.state === 'dismissed' && <p>{t('queue.dismissedWarning')}</p>}
          {row.state === 'partial' && <p>{t('queue.partialWarning')}</p>}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {['pending', 'editing', 'failed', 'partial'].includes(row.state) && <button data-testid={`scheduled-edit-${row.id}`} disabled={!!busy || (composing && !(row.mode === 'undo' && row.state === 'pending'))} onClick={() => void act(row, 'edit')}>{t(row.mode === 'undo' && row.state === 'pending' ? 'queue.undo' : 'queue.edit')}</button>}
            {['pending', 'editing'].includes(row.state) && <button data-testid={`scheduled-reschedule-${row.id}`} disabled={!!busy} onClick={() => setPicker(row)}>{t('queue.reschedule')}</button>}
            {row.state === 'uncertain' && <button data-testid={`scheduled-dismiss-${row.id}`} disabled={!!busy} onClick={() => void act(row, 'dismiss')}>{t('queue.dismiss')}</button>}
            {['pending', 'editing', 'failed', 'partial'].includes(row.state) && <button data-testid={`scheduled-cancel-${row.id}`} disabled={!!busy} onClick={() => void act(row, 'cancel')}>{t('queue.cancel')}</button>}
          </div>
        </li>)}
      </ul>
    </section>}
    {open && picker && <SchedulePicker initialTimeZone={picker.timeZone} initialScheduledAt={picker.scheduledAt} busy={!!busy} onCancel={() => setPicker(null)} onConfirm={selection => void act(picker, 'reschedule', selection)} />}
  </>;
}
