import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.ts';
import { useMobile } from '../hooks/useMobile.ts';
import { useBackLayer } from '../hooks/useBackNavigation.ts';
import type { ScheduledMailController } from '../hooks/useScheduledMail.ts';
import { scheduledApi, scheduledStateLabels, type ScheduledPreview, type ScheduledPreviewMessage, type ScheduledSource, type ScheduledSummary } from '../utils/scheduledMail.ts';
import { observeSentStatus } from '../utils/scheduledVisit.ts';
import { schedulePreview, userScheduleTimeZone } from '../utils/scheduleTime.ts';
import { api } from '../utils/api.ts';
import MessageBodyRenderer from './MessageBodyRenderer.tsx';
import SchedulePicker from './SchedulePicker.tsx';
import { Button, EmptyState } from './ui.tsx';
import { HeaderAction, MobileModuleHeader } from './MobileModuleHeader.tsx';
import './scheduledMail.css';

/** Both the list and the reader can expose a sent badge; the controller deduplicates their receipts. */
function QueueStatus({ row, acknowledge }: { row: ScheduledSummary; acknowledge: (id: string) => void }) {
  const { t } = useTranslation();
  const element = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (row.state !== 'sent' || !element.current) return;
    return observeSentStatus(element.current, () => acknowledge(row.id));
  }, [row.id, row.state, acknowledge]);
  return <span ref={element} className="scheduled-state" data-state={row.state}
    data-testid={`scheduled-status-${row.id}`}>{t(scheduledStateLabels[row.state])}</span>;
}
const escape = (text: string) => text.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character] ?? character);
const plain = (text: string) => `<div style="white-space:pre-wrap">${escape(text)}</div>`;
/** This is authored content, not trusted HTML. MessageBodyRenderer sanitizes the combined preview. */
function previewBody(message: ScheduledPreviewMessage): string {
  return (message.bodyIsHtml ? message.body : plain(message.body))
    + (message.editedSignature ? `<div style="margin-top:16px">${message.editedSignatureIsHtml === false
      ? plain(message.editedSignature) : message.editedSignature}</div>` : '')
    + (message.quotedBodyHtml || (message.quotedBody ? plain(message.quotedBody) : ''));
}
interface SourceBody { html?: string | null; text?: string | null; body_html?: string | null; body_text?: string | null;
  attachments?: Array<{ filename?: string | null; size?: number | null }> }
/** Existing message-body reads hydrate only a proven owned source/Sent copy, never the queue's edit endpoint. */
function SourcePreview({ source, epoch }: { source: ScheduledSource; epoch: number }) {
  const { t } = useTranslation();
  const [body, setBody] = useState<SourceBody | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    void api.getMessageBody(source.id).then((value: SourceBody) => {
      if (current && useStore.getState().authEpoch === epoch) setBody(value);
    }).catch(() => { if (current && useStore.getState().authEpoch === epoch) setFailed(true); });
    return () => { current = false; };
  }, [source.id, epoch]);
  if (failed) return <p className="scheduled-note">{t('queue.sourceUnavailable')}</p>;
  if (!body) return <p className="scheduled-note" role="status">{t('common.loading')}</p>;
  return <>
    <MessageBodyRenderer html={body.html ?? body.body_html ?? undefined} text={body.text ?? body.body_text ?? undefined} remoteImages={false} title={t('queue.previewTitle')} />
    {!!body.attachments?.length && <ul className="scheduled-attachments" aria-label={t('queue.attachments')}>
      {body.attachments.map((attachment, index) => <li key={index}>{attachment.filename || t('queue.attachments')}</li>)}
    </ul>}
  </>;
}
function ContextMessage({ source, epoch }: { source: ScheduledSource; epoch: number }) {
  const { i18n } = useTranslation(); const [expanded, setExpanded] = useState(false);
  return <details className="scheduled-context" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>{source.fromName || source.fromEmail} · {source.subject}
      {source.date && <> · {schedulePreview(source.date, userScheduleTimeZone(), i18n.language)}</>}</summary>
    {expanded && <div className="scheduled-context-body"><SourcePreview source={source} epoch={epoch} /></div>}
  </details>;
}
function QueueDetail({ row, controller }: { row: ScheduledSummary; controller: ScheduledMailController }) {
  const { t, i18n } = useTranslation();
  const accounts = useStore(state => state.accounts);
  const [preview, setPreview] = useState<ScheduledPreview | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const request = new AbortController();
    setPreview(null); setFailed(false);
    void scheduledApi.preview(row.id, request.signal).then(value => {
      if (!request.signal.aborted && useStore.getState().authEpoch === controller.authEpoch) setPreview(value);
    }).catch(() => { if (!request.signal.aborted && useStore.getState().authEpoch === controller.authEpoch) setFailed(true); });
    return () => request.abort();
  }, [row.id, row.revision, row.state, controller.authEpoch, controller.previewRefresh]);
  const current = preview?.id === row.id && preview.state === row.state ? preview : null;
  const message = current?.message;
  const account = accounts.find(value => value.id === row.accountId);
  const to = message?.to ?? row.to ?? [];
  const cc = message?.cc ?? row.cc ?? [];
  const sender = current?.senderEmail || row.senderEmail || account?.email_address || '';
  const mutable = ['pending', 'editing', 'failed', 'partial'].includes(row.state);
  return <>
    <div className="scheduled-actions">
      {mutable && <Button data-testid={`scheduled-edit-${row.id}`} disabled={!!controller.busy}
        onClick={() => void controller.act(row, 'edit')}>{t('queue.edit')}</Button>}
      {['pending', 'editing'].includes(row.state) && <Button data-testid={`scheduled-reschedule-${row.id}`}
        disabled={!!controller.busy} onClick={() => controller.setPicker(row)}>{t('queue.reschedule')}</Button>}
      {mutable && <Button variant="danger" data-testid={`scheduled-cancel-${row.id}`} disabled={!!controller.busy}
        onClick={() => void controller.act(row, 'cancel')}>{t('queue.cancel')}</Button>}
      {row.state === 'uncertain' && <Button data-testid={`scheduled-dismiss-${row.id}`} disabled={!!controller.busy}
        onClick={() => void controller.act(row, 'dismiss')}>{t('queue.dismiss')}</Button>}
      <QueueStatus row={row} acknowledge={controller.acknowledge} />
    </div>
    <div className="scheduled-detail-scroll" data-testid="scheduled-preview">
      <h2>{row.subject || t('queue.noSubject')}</h2>
      <dl className="scheduled-headers">
        <dt>{t('compose.from')}</dt><dd>{sender}</dd>
        <dt>{t('compose.to')}</dt><dd>{to.join(', ') || (row.recipientCount ? t('queue.recipientCount', { count: row.recipientCount }) : t('queue.recipientsUnavailable'))}</dd>
        {!!cc.length && <><dt>{t('compose.cc')}</dt><dd>{cc.join(', ')}</dd></>}
        {!!message?.bcc?.length && <><dt>{t('compose.bcc')}</dt><dd>{message.bcc.join(', ')}</dd></>}
        <dt>{t('message.date')}</dt><dd>{schedulePreview(row.scheduledAt, userScheduleTimeZone(), i18n.language)}</dd>
      </dl>
      {['uncertain', 'partial', 'dismissed'].includes(row.state) && <p className="ui-alert">
        {t(row.state === 'uncertain' ? 'queue.uncertainWarning' : row.state === 'partial' ? 'queue.partialWarning' : 'queue.dismissedWarning')}
      </p>}
      {row.errorCode && <p className="scheduled-note">{t('queue.deliveryError', { code: row.errorCode })}</p>}
      {failed ? <p role="alert" className="ui-alert">{t('queue.previewError')}</p> : !current ? <p role="status">{t('common.loading')}</p> : <>
        {!!current.context?.length && <section aria-label={t('queue.threadContext')}>
          <p className="scheduled-note">{t('queue.threadContext')}</p>
          {current.context.map(source => <ContextMessage key={source.id} source={source} epoch={controller.authEpoch} />)}
        </section>}
        {current.contextMissing && <p className="scheduled-note">{t('queue.sourceUnavailable')}</p>}
        {message ? <>
          {!!message.attachments?.length && <ul className="scheduled-attachments" aria-label={t('queue.attachments')}>
            {message.attachments.map((attachment, index) => <li key={index}>{attachment.filename} <span className="scheduled-muted">
              ({new Intl.NumberFormat(i18n.language, { style: 'unit', unit: 'kilobyte', maximumFractionDigits: 1 }).format(attachment.size / 1024)})
            </span></li>)}
          </ul>}
          <MessageBodyRenderer html={previewBody(message)} remoteImages={false} title={t('queue.previewTitle')}
            showQuotedTextLabel={t('conversation.showQuotedText')} hideQuotedTextLabel={t('conversation.hideQuotedText')} />
        </> : current.sentCopy ? <SourcePreview key={current.sentCopy.id} source={current.sentCopy} epoch={controller.authEpoch} />
          : <p className="scheduled-note">{t('queue.previewUnavailable')}</p>}
      </>}
    </div>
  </>;
}
/** A regular mail surface: the shell, navigation, and Undo worker remain mounted. */
export default function ScheduledMail({ controller }: { controller: ScheduledMailController }) {
  const { t, i18n } = useTranslation(); const mobile = useMobile();
  const accounts = useStore(state => state.accounts);
  const selected = controller.items.find(row => row.id === controller.selectedId);
  useBackLayer(controller.active && mobile && !!selected, () => controller.select(null), 30);
  return <section className="scheduled-view" data-testid="scheduled-view" aria-busy={controller.loading} aria-label={t('queue.title')}>
    {mobile ? <MobileModuleHeader title={t('queue.title')}
      leading={selected ? <HeaderAction icon="back" label={t('common.back')} data-testid="scheduled-back" onClick={() => controller.select(null)} /> : null}>
      <HeaderAction icon="sync" label={t('queue.refresh')} data-testid="scheduled-refresh" onClick={controller.refreshView} />
    </MobileModuleHeader> : <header className="scheduled-toolbar"><h1>{t('queue.title')}</h1>
      <Button data-testid="scheduled-refresh" onClick={controller.refreshView}>{t('queue.refresh')}</Button></header>}
    {controller.error && <div role="alert" className="ui-alert">{t(controller.error)}</div>}
    {controller.loadError && <div role="alert" className="ui-alert">{t('queue.loadError')}</div>}
    {controller.seenError && <div role="alert" className="ui-alert">{t('queue.seenError')}</div>}
    <div className="scheduled-layout">
      <div className={`scheduled-list${selected ? ' is-detail' : ''}`} data-testid="scheduled-list-scroll">
        {!controller.items.length && <EmptyState title={t(controller.loading ? 'common.loading' : 'queue.empty')} />}
        <ul>{controller.items.map(row => {
          const recipients = [...(row.to ?? []), ...(row.cc ?? [])];
          const account = accounts.find(value => value.id === row.accountId);
          return <li key={row.id} data-testid={`scheduled-item-${row.id}`}>
            <button type="button" className="scheduled-row" aria-pressed={controller.selectedId === row.id}
              onClick={() => controller.select(row.id)}>
              <strong>{row.subject || t('queue.noSubject')}</strong>
              <span className="scheduled-ellipsis">{recipients.join(', ') || (row.recipientCount ? t('queue.recipientCount', { count: row.recipientCount }) : t('queue.recipientsUnavailable'))}</span>
              <span className="scheduled-ellipsis scheduled-muted">{row.senderEmail || account?.email_address}</span>
              <span className="scheduled-row-foot"><time dateTime={row.scheduledAt}>{schedulePreview(row.scheduledAt, userScheduleTimeZone(), i18n.language)}</time>
                <QueueStatus row={row} acknowledge={controller.acknowledge} /></span>
            </button>
          </li>;
        })}</ul>
        {controller.hasMore && <div className="scheduled-pagination"><Button disabled={controller.loading} onClick={controller.more}
          data-testid="scheduled-load-more">{t(controller.loading ? 'common.loading' : 'queue.loadMore')}</Button></div>}
      </div>
      <div className={`scheduled-detail${selected ? '' : ' is-list'}`}>
        {selected ? <QueueDetail key={selected.id} row={selected} controller={controller} /> : <EmptyState title={t('queue.selectMessage')} />}
      </div>
    </div>
  </section>;
}
/** Global countdowns are intentionally not children of the queue view. */
export function ScheduledUndo({ controller }: { controller: ScheduledMailController }) {
  const { t } = useTranslation();
  const drawerOpen = useStore(state => state.mobileSidebarOpen);
  const mobile = useMobile();
  const [now, setNow] = useState(Date.now);
  const ticking = !controller.shown && controller.globalItems.some(row => row.mode === 'undo' && row.state === 'pending' && Date.parse(row.scheduledAt) > Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(clock);
  }, [ticking]);
  const pending = controller.globalItems.filter(row => row.mode === 'undo' && row.state === 'pending' && Date.parse(row.scheduledAt) > now);
  if (controller.shown || (mobile && drawerOpen) || !pending.length) return null;
  return <aside className="scheduled-undo" aria-label={t('queue.undo')}>
    <Button variant="ghost" onClick={controller.open}>{t('queue.title')}</Button>
    {controller.error && <p role="alert">{t(controller.error)}</p>}
    {pending.map(row => <div key={row.id}><span>{row.subject || t('queue.noSubject')} · {t('queue.countdown', {
      count: Math.max(0, Math.ceil((Date.parse(row.scheduledAt) - now) / 1000)),
    })}</span><Button data-testid={`scheduled-undo-${row.id}`} disabled={!!controller.busy}
      onClick={() => void controller.act(row, 'edit')}>{t('queue.undo')}</Button></div>)}
  </aside>;
}
/** Keep an open reschedule form stable when the responsive shell changes panes. */
export function ScheduledDialogs({ controller }: { controller: ScheduledMailController }) {
  const { t } = useTranslation();
  const row = controller.picker;
  return row && controller.active ? <SchedulePicker initialScheduledAt={row.scheduledAt} busy={!!controller.busy} error={controller.error ? t(controller.error) : undefined}
    onCancel={() => controller.setPicker(null)} onConfirm={selection => void controller.act(row, 'reschedule', selection)} /> : null;
}
