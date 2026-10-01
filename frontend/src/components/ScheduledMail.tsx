import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.ts';
import { useMobile } from '../hooks/useMobile.ts';
import { useBackLayer } from '../hooks/useBackNavigation.ts';
import type { ScheduledMailController } from '../hooks/useScheduledMail.ts';
import { scheduledApi, scheduledStateLabels, type ScheduledPreview, type ScheduledPreviewMessage, type ScheduledSource, type ScheduledSummary } from '../utils/scheduledMail.ts';
import { observeSentStatus } from '../utils/scheduledVisit.ts';
import { schedulePreview, userScheduleTimeZone } from '../utils/scheduleTime.ts';
import { formatDate } from '../utils/formatDate.ts';
import { api } from '../utils/api.ts';
import MessageDetailContent from './MessageDetailContent.tsx';
import MessageHeaderCard from './MessageHeaderCard.tsx';
import { MessageDirection } from './MessagePresentation.tsx';
import { MessageToolbarSurface, ToolbarButton } from './MessageToolbar.tsx';
import { MailListHeader, MailListTitle, MailRowAvatar, MailRowHeading, MailRowSender, MailRowSubject, MailRowDate, MailRowSelection, mailRowStyle, mailListPanelStyle, mailReaderPanelStyle, mailListSurfaceStyle } from './MailListPresentation.tsx';
import { downloadMailAttachment, queuedAttachmentPath, queuedPreviewAttachments } from './mailPresentationDownloads.ts';
import { LAYOUTS, normalizeLayout } from '../layouts.ts';
import SchedulePicker from './SchedulePicker.tsx';
import { Dialog, Button, EmptyState, PanelResizeHandle } from './ui.tsx';
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
type SourceBody = NonNullable<Parameters<typeof MessageDetailContent>[0]['body']>;
/** Existing message-body reads hydrate only a proven owned source/Sent copy, never the queue's edit endpoint. */
function SourcePreview({ source, epoch, refresh }: { source: ScheduledSource; epoch: number; refresh: number }) {
  const { t } = useTranslation();
  const mobile = useMobile();
  const [body, setBody] = useState<SourceBody | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const requestRef = useRef<AbortController | null>(null);
  useEffect(() => {
    const request = new AbortController();
    requestRef.current = request;
    setBody(null); setFailed(false);
    void api.getMessageBody(source.id).then((value: SourceBody) => {
      if (!request.signal.aborted && useStore.getState().authEpoch === epoch) setBody(value);
    }).catch(() => { if (!request.signal.aborted && useStore.getState().authEpoch === epoch) setFailed(true); });
    return () => request.abort();
  }, [source.id, epoch, refresh, retry]);
  return <MessageDetailContent physicalCopyId={source.id}
    message={{ id: source.id, account_id: source.accountId, from_email: source.fromEmail }}
    body={body} status={{ loading: !body && !failed, error: failed ? t('queue.sourceUnavailable') : undefined }}
    onLoadBody={() => setRetry(value => value + 1)} remoteImages={false} readOnly mobile={mobile}
    downloadErrorLabel={t('queue.actionError')}
    onDownload={async (id, part, filename) => {
      const request = requestRef.current;
      if (!request || part === undefined) throw new Error('Attachment unavailable');
      await downloadMailAttachment(`/api/mail/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(part)}`,
        filename, request.signal, () => useStore.getState().authEpoch === epoch);
    }} />;
}
function ContextMessage({ source, epoch, refresh }: { source: ScheduledSource; epoch: number; refresh: number }) {
  const { i18n } = useTranslation(); const [expanded, setExpanded] = useState(false);
  return <details className="scheduled-context" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>{source.fromName || source.fromEmail} · {source.subject}
      {source.date && <> · {schedulePreview(source.date, userScheduleTimeZone(), i18n.language)}</>}</summary>
    {expanded && <div className="scheduled-context-body"><SourcePreview source={source} epoch={epoch} refresh={refresh} /></div>}
  </details>;
}
function QueueDetail({ row, controller }: { row: ScheduledSummary; controller: ScheduledMailController }) {
  const { t, i18n } = useTranslation();
  const accounts = useStore(state => state.accounts);
  const mobile = useMobile();
  const editingHere = useStore(state => state.composing && state.composeData?.queuedMail?.id === row.id);
  const requestRef = useRef<AbortController | null>(null);
  const [preview, setPreview] = useState<{ value: ScheduledPreview; revision: number } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const request = new AbortController();
    requestRef.current = request;
    setPreview(null); setFailed(false);
    void scheduledApi.preview(row.id, request.signal).then(value => {
      if (!request.signal.aborted && useStore.getState().authEpoch === controller.authEpoch) setPreview({ value, revision: row.revision });
    }).catch(() => { if (!request.signal.aborted && useStore.getState().authEpoch === controller.authEpoch) setFailed(true); });
    return () => request.abort();
  }, [row.id, row.revision, row.state, controller.authEpoch, controller.previewRefresh]);
  const current = preview?.value.id === row.id && preview.value.state === row.state && preview.revision === row.revision ? preview.value : null;
  const message = current?.message;
  const detailBody = useMemo(() => message ? { html: previewBody(message), attachments: queuedPreviewAttachments(message.attachments ?? []) } : null, [message]);
  const account = accounts.find(value => value.id === row.accountId);
  const to = message?.to ?? row.to ?? [];
  const cc = message?.cc ?? row.cc ?? [];
  const sender = current?.senderEmail || row.senderEmail || account?.email_address || '';
  const mutable = ['pending', 'editing', 'failed', 'partial'].includes(row.state);
  return <>
    <MessageToolbarSurface className="scheduled-actions">
      {mutable && <ToolbarButton action="edit" data-testid={`scheduled-edit-${row.id}`} disabled={!!controller.busy}
        onClick={() => void controller.act(row, 'edit')}>{t('queue.edit')}</ToolbarButton>}
      {!editingHere && ['pending', 'editing'].includes(row.state) && <ToolbarButton data-testid={`scheduled-reschedule-${row.id}`}
        disabled={!!controller.busy} onClick={() => controller.setPicker(row)}>{t('queue.reschedule')}</ToolbarButton>}
      {mutable && <ToolbarButton danger data-testid={`scheduled-cancel-${row.id}`} disabled={!!controller.busy}
        onClick={() => void controller.act(row, 'cancel')}>{t('queue.cancel')}</ToolbarButton>}
      {row.state === 'uncertain' && <ToolbarButton data-testid={`scheduled-dismiss-${row.id}`} disabled={!!controller.busy}
        onClick={() => void controller.act(row, 'dismiss')}>{t('queue.dismiss')}</ToolbarButton>}
      <QueueStatus row={row} acknowledge={controller.acknowledge} />
    </MessageToolbarSurface>
    <div className="scheduled-detail-scroll" data-testid="scheduled-preview">
      <MessageHeaderCard isMobile={mobile} message={{ subject: row.subject || t('queue.noSubject'), from_email: sender,
        account_name: account?.name, account_color: account?.color,
        account_email: to.length ? undefined : row.recipientCount ? t('queue.recipientCount', { count: row.recipientCount }) : t('queue.recipientsUnavailable') }}
        toList={to.map(email => ({ email }))} ccList={cc.map(email => ({ email }))}
        date={schedulePreview(row.scheduledAt, userScheduleTimeZone(), i18n.language)}
        recipientExtras={!!message?.bcc?.length && <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2 }}>
          {t('compose.bcc')} <span style={{ color: 'var(--text-secondary)' }}>{message.bcc.join(', ')}</span>
        </div>} />
      <div className="scheduled-content">
      {['uncertain', 'partial', 'dismissed'].includes(row.state) && <p className="ui-alert">
        {t(row.state === 'uncertain' ? 'queue.uncertainWarning' : row.state === 'partial' ? 'queue.partialWarning' : 'queue.dismissedWarning')}
      </p>}
      {row.errorCode && <p className="scheduled-note">{t('queue.deliveryError', { code: row.errorCode })}</p>}
      {failed ? <p role="alert" className="ui-alert">{t('queue.previewError')} <Button onClick={controller.refreshView}>{t('common.retry')}</Button></p> : !current ? <p role="status">{t('common.loading')}</p> : <>
        {!!current.context?.length && <section aria-label={t('queue.threadContext')}>
          <p className="scheduled-note">{t('queue.threadContext')}</p>
          {current.context.map(source => <ContextMessage key={source.id} source={source} epoch={controller.authEpoch} refresh={controller.previewRefresh} />)}
        </section>}
        {current.contextMissing && <p className="scheduled-note">{t('queue.sourceUnavailable')}</p>}
        {message ? <MessageDetailContent key={`${row.id}:${row.revision}:${controller.authEpoch}`} message={{ id: row.id, account_id: row.accountId, from_email: sender }}
          body={detailBody} remoteImages={false} hideDownloadAll readOnly mobile={mobile}
          downloadErrorLabel={t('queue.actionError')}
          getAttachmentPath={part => queuedAttachmentPath(row.id, row.revision, part)}
          onDownloadAttachment={async (part, filename) => {
            const request = requestRef.current;
            if (!request) return;
            await downloadMailAttachment(queuedAttachmentPath(row.id, row.revision, part), filename, request.signal,
              () => useStore.getState().authEpoch === controller.authEpoch);
          }} /> : current.sentCopy ? <SourcePreview key={current.sentCopy.id} source={current.sentCopy} epoch={controller.authEpoch} refresh={controller.previewRefresh} />
          : <p className="scheduled-note">{t('queue.previewUnavailable')}</p>}
      </>}
      </div>
    </div>
  </>;
}
/** A regular mail surface: the shell, navigation, and Undo worker remain mounted. */
export default function ScheduledMail({ controller, direction = 'row', compact = false, onListResize }: {
  controller: ScheduledMailController; direction?: 'row' | 'column'; compact?: boolean; onListResize: (event: MouseEvent) => void;
}) {
  const { t, i18n } = useTranslation(); const mobile = useMobile();
  const accounts = useStore(state => state.accounts);
  const layout = useStore(state => state.layout);
  const showMobileAvatars = useStore(state => state.showMobileAvatars);
  const showMessagePreviews = useStore(state => state.showMessagePreviews);
  const threaded = useStore(state => state.threadedView);
  const preset = LAYOUTS[normalizeLayout(layout)];
  const narrow = direction !== 'column' && (preset.listWidth === null || preset.listWidth <= 260);
  const singlePane = mobile || compact;
  const selected = controller.items.find(row => row.id === controller.selectedId);
  const [listScrolled, setListScrolled] = useState(false);
  useBackLayer(controller.active && singlePane && !!selected, () => controller.select(null), 30);
  return <section className="scheduled-view" data-testid="scheduled-view" aria-busy={controller.loading} aria-label={t('queue.title')} data-scheduled-single-pane={singlePane}>
    {mobile && <MobileModuleHeader title={t('queue.title')}
      leading={selected ? <HeaderAction icon="back" label={t('common.back')} data-testid="scheduled-back" onClick={() => controller.select(null)} /> : null}>
      <HeaderAction icon="sync" label={t('queue.refresh')} data-testid="scheduled-refresh" onClick={controller.refreshView} />
    </MobileModuleHeader>}
    <div className="scheduled-layout" style={{ flexDirection: mobile ? 'column' : direction }}>
      <div style={{ ...mailListPanelStyle(direction, singlePane), display: singlePane && selected ? 'none' : 'flex' }}>
        <div style={mailListSurfaceStyle(mobile, direction === 'column')}>
          {!mobile && !(compact && selected) && <MailListHeader scrolled={listScrolled}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: narrow ? 6 : 10 }}>
              <MailListTitle>{t('queue.title')}</MailListTitle>
              <Button title={t('queue.refresh')} data-testid="scheduled-refresh" onClick={controller.refreshView}>{t('queue.refresh')}</Button>
            </div>
          </MailListHeader>}
          {singlePane && !selected && controller.error && <div role="alert" className="ui-alert">{t(controller.error)}</div>}
          {controller.loadError && <div role="alert" className="ui-alert">{t('queue.loadError')}</div>}
          {controller.seenError && <div role="alert" className="ui-alert">{t('queue.seenError')}</div>}
          <div className="scheduled-list" data-testid="scheduled-list-scroll" onScroll={event => setListScrolled(event.currentTarget.scrollTop > 4)}>
            {!controller.items.length && <EmptyState title={t(controller.loading ? 'common.loading' : 'queue.empty')} />}
            <ul>{controller.items.map(row => {
              const recipients = [...(row.to ?? []), ...(row.cc ?? [])];
              const account = accounts.find(value => value.id === row.accountId);
              const sender = row.senderEmail || account?.email_address;
              return <li key={row.id} data-testid={`scheduled-item-${row.id}`}>
                <button type="button" className="scheduled-row" aria-pressed={controller.selectedId === row.id}
                  style={mailRowStyle(controller.selectedId === row.id ? 'var(--accent-glow)' : 'var(--scheduled-row-background)', threaded)}
                  onClick={() => controller.select(row.id)}>
                  {controller.selectedId === row.id && <MailRowSelection color={account?.color} />}
                  {((!mobile && !narrow) || (mobile && showMobileAvatars)) && <MailRowAvatar email={sender} />}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <MailRowHeading sender={<div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1 }}>
                      <MessageDirection direction="outgoing" label={t('conversation.outgoingMessage')} />
                      <MailRowSender>{sender || account?.name || t('conversation.you')}</MailRowSender>
                    </div>}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, marginLeft: 8 }}><MailRowDate><time dateTime={row.scheduledAt} title={schedulePreview(row.scheduledAt, userScheduleTimeZone(), i18n.language)}>{formatDate(row.scheduledAt, i18n.resolvedLanguage || i18n.language)}</time></MailRowDate></div>
                    </MailRowHeading>
                    <MailRowSubject thread={threaded}>{row.subject || t('queue.noSubject')}</MailRowSubject>
                    {showMessagePreviews && <div className="scheduled-recipients">{recipients.join(', ') || (row.recipientCount ? t('queue.recipientCount', { count: row.recipientCount }) : t('queue.recipientsUnavailable'))}</div>}
                    <div className="scheduled-row-status"><QueueStatus row={row} acknowledge={controller.acknowledge} /><time dateTime={row.scheduledAt}>{new Intl.DateTimeFormat(i18n.language, { timeZone: userScheduleTimeZone(), hour: '2-digit', minute: '2-digit' }).format(new Date(row.scheduledAt))}</time></div>
                  </div>
                </button>
              </li>;
            })}</ul>
            {controller.hasMore && <div className="scheduled-pagination"><Button disabled={controller.loading} onClick={controller.more}
              data-testid="scheduled-load-more">{t(controller.loading ? 'common.loading' : 'queue.loadMore')}</Button></div>}
          </div>
        </div>
      </div>
      {!singlePane && direction === 'row' && <PanelResizeHandle testId="scheduled-list-resize" onMouseDown={onListResize} />}
      <div style={{ ...mailReaderPanelStyle, display: singlePane && !selected ? 'none' : 'flex' }}>
        {!mobile && compact && selected && <div className="tablet-reader-back" style={{ display: 'flex', justifyContent: 'space-between' }}>
          <Button variant="ghost" data-testid="scheduled-back" onClick={() => controller.select(null)}>‹ {t('common.back')}</Button>
          <Button data-testid="scheduled-refresh" onClick={controller.refreshView}>{t('queue.refresh')}</Button>
        </div>}
        {controller.error && <div role="alert" className="ui-alert">{t(controller.error)}</div>}
        {selected ? <QueueDetail key={`${selected.id}:${controller.authEpoch}`} row={selected} controller={controller} /> : <EmptyState title={t('queue.selectMessage')} />}
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
    <Button variant="ghost" onClick={() => controller.open()}>{t('queue.title')}</Button>
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
  if (!controller.active) return null;
  const confirmation = controller.confirmation;
  return <>
    {row && <SchedulePicker initialScheduledAt={row.scheduledAt} busy={!!controller.busy} error={controller.error ? t(controller.error) : undefined}
      onCancel={() => controller.setPicker(null)} onConfirm={selection => void controller.act(row, 'reschedule', selection)} />}
    {confirmation && <Dialog title={t(confirmation.kind === 'cancel' ? 'queue.cancel' : 'queue.dismiss')}
      closeLabel={t('common.close')} onClose={controller.closeConfirmation} busy={Boolean(controller.busy)} testId="scheduled-confirmation"
      footer={<><Button disabled={Boolean(controller.busy)} onClick={controller.closeConfirmation}>{t('common.cancel')}</Button>
        <Button variant="danger" disabled={Boolean(controller.busy)} onClick={() => void controller.confirm()}>{t(confirmation.kind === 'cancel' ? 'queue.cancel' : 'queue.dismiss')}</Button></>}>
      <p>{t(confirmation.kind === 'cancel' ? 'queue.cancelConfirm' : 'queue.dismissConfirm')}</p>
      {controller.error && <p role="alert">{t(controller.error)}</p>}
    </Dialog>}
  </>;
}
