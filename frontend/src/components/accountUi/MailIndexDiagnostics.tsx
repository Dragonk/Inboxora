import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../utils/api.ts';
import { intlLocale } from '../../utils/intlLocale.ts';
import { useStore } from '../../store/index.ts';
import { Button } from '../ui.tsx';
import { Notice } from './AccountUi.tsx';
interface IndexStatus { status: 'running' | 'pending' | 'failed' | 'ready' | 'unknown'; messages: number; folders: number; lastFolderSync: string | null }
const labels = { running: 'settingsIndex.running', pending: 'settingsIndex.pending', failed: 'accountUi.statusFailed', ready: 'accountUi.statusReady', unknown: 'accountUi.statusUnknown' } as const;
export default function MailIndexDiagnostics({ accountId, onSyncFolders, onReindex, onReconnect }: {
  accountId: string; onSyncFolders: () => Promise<void>; onReindex: () => Promise<void>; onReconnect: () => Promise<void>;
}) {
  const { t, i18n } = useTranslation(); const epoch = useStore(state => state.authEpoch);
  const [status, setStatus] = useState<IndexStatus | null>(null); const [failed, setFailed] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);
  const [busy, setBusy] = useState(false); const life = useRef({ generation: 0, request: 0 }); const lock = useRef<symbol | null>(null);
  const load = useCallback(async () => {
    const generation = life.current.generation; const request = ++life.current.request;
    const current = () => generation === life.current.generation && request === life.current.request && useStore.getState().authEpoch === epoch;
    try { const value: IndexStatus = await api.get(`/accounts/${encodeURIComponent(accountId)}/index-status`);
      if (current()) { setStatus(value); setFailed(false); }
    } catch { if (current()) setFailed(true); }
  }, [accountId, epoch]);
  useEffect(() => { const scope = life.current; scope.generation++; lock.current = null; setBusy(false); setStatus(null); setFailed(false); setActionFailed(false); void load(); const poll = window.setInterval(() => void load(), 5000);
    return () => { scope.generation++; window.clearInterval(poll); }; }, [load]);
  const run = async (action: () => Promise<void>) => {
    if (lock.current !== null || useStore.getState().authEpoch !== epoch) return;
    const generation = life.current.generation;
    const current = () => generation === life.current.generation && useStore.getState().authEpoch === epoch;
    const owner = Symbol(); lock.current = owner; setBusy(true); setActionFailed(false);
    try { await action(); if (current()) await load(); }
    catch { if (current()) setActionFailed(true); }
    finally { if (lock.current === owner) { lock.current = null; if (current()) setBusy(false); } }
  };
  const date = status?.lastFolderSync && Number.isFinite(Date.parse(status.lastFolderSync))
    ? new Intl.DateTimeFormat(intlLocale(i18n.resolvedLanguage || i18n.language), { dateStyle: 'short', timeStyle: 'short' }).format(new Date(status.lastFolderSync)) : t('common.never');
  return <section className="au-section" data-testid="mail-index-diagnostics">
    <div className="au-actions"><Button disabled={busy} onClick={() => void run(onSyncFolders)}>{t('admin.accounts.syncFolders')}</Button>
      <Button disabled={busy || status?.status === 'running' || status?.status === 'pending'} onClick={() => void run(onReindex)}>{t('admin.accounts.reindex')}</Button>
      <Button disabled={busy} onClick={() => void run(onReconnect)}>{t('admin.accounts.services.reconnect')}</Button></div>
    {actionFailed && <Notice danger>{t('accountUi.operationFailed')}</Notice>}
    {failed && <Notice danger>{t('accountUi.operationFailed')}<Button onClick={() => void load()}>{t('common.retry')}</Button></Notice>}
    <dl className="au-meta"><dt>{t('settingsIndex.status')}</dt><dd role="status">{t(status ? labels[status.status] : 'common.loading')}</dd>
      <dt>{t('settingsIndex.messages')}</dt><dd>{status?.messages ?? '—'}</dd><dt>{t('settingsIndex.folders')}</dt><dd>{status?.folders ?? '—'}</dd>
      <dt>{t('settingsIndex.folderSync')}</dt><dd>{date}</dd></dl>
  </section>;
}
