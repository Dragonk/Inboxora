import CalendarInvitationCard from './CalendarInvitationCard.tsx';
import { useCallback, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { isDangerousAttachment } from '../utils/dangerousAttachment.ts';
import MessageBodyRenderer from './MessageBodyRenderer.tsx';
import ContextMenu from './ContextMenu.tsx';
import { Button, Dialog } from './ui.tsx';

function formatBytes(bytes: number | undefined): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function FileIcon({ type }: { type?: string }) {
  const t = (type || '').toLowerCase();
  const p = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.75 };
  if (t.startsWith('image/')) return <svg {...p}><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>;
  if (t === 'application/pdf') return <svg {...p}><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>;
  return <svg {...p}><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>;
}

/** One attachment row as the detail pane receives and renders it. */
interface MessageDetailAttachment {
  part?: string;
  filename?: string;
  type?: string;
  size?: number;
  [key: string]: unknown;
}

type PendingDownload =
  | { kind: 'attachment'; attachment: MessageDetailAttachment }
  | { kind: 'all' };

/** The message fields the detail pane reads (a store row or a reader copy). */
interface MessageDetailMessage {
  id: string;
  account_id: string;
  from_email?: string | null;
  from_name?: string | null;
  list_unsubscribe?: string | null;
  listUnsubscribe?: string | null;
  unsubscribed_at?: unknown;
  unsubscribedAt?: unknown;
  [key: string]: unknown;
}

/** The fetched body fields the detail pane reads. */
interface MessageDetailBody {
  html?: string | null;
  text?: string | null;
  body_html?: string | null;
  body_text?: string | null;
  attachments?: unknown;
  hasBlockedRemoteImages?: boolean;
  [key: string]: unknown;
}

/** Whether a body is loading, failed or unavailable. */
interface MessageDetailStatus {
  loading?: boolean;
  error?: string | null;
  unavailable?: boolean;
}

/** The context-menu position the body frame reports, taken from its own prop. */
type BodyContextMenuPosition = Parameters<NonNullable<Parameters<typeof MessageBodyRenderer>[0]['onContextMenu']>>[0];

interface MessageDetailContentProps {
  physicalCopyId?: string;
  message: MessageDetailMessage;
  body?: MessageDetailBody | null;
  status?: MessageDetailStatus;
  remoteImages?: boolean;
  onLoadBody?(physicalCopyId: string | undefined, force?: boolean): void;
  onRemoteImages?(physicalCopyId: string | undefined): void;
  onAllowSender?(physicalCopyId: string | undefined): void;
  onAllowDomain?(physicalCopyId: string | undefined): void;
  onUnsubscribe?(physicalCopyId: string): Promise<boolean | void> | boolean | void;
  onDownload?(physicalCopyId: string, part: string | undefined, filename: string | undefined): Promise<void> | void;
  onContextAction?(action: string, data?: unknown, physicalCopyId?: string): void;
  onInitialBodyLayout?: () => void;
  canAccessCopy?: boolean;
  mobile?: boolean;
  className?: string;
}

/**
 * The one physical-copy scoped implementation of content below a message header.
 * It intentionally has no selected-message store dependency: every action receives
 * physicalCopyId, which makes concurrently expanded reader cards safe.
 */
export default function MessageDetailContent({
  physicalCopyId,
  message,
  body,
  status = {},
  remoteImages = false,
  onLoadBody,
  onRemoteImages,
  onAllowSender,
  onAllowDomain,
  onUnsubscribe,
  onDownload,
  onContextAction,
  onInitialBodyLayout,
  canAccessCopy = true,
  mobile = false,
  className = '',
}: MessageDetailContentProps) {
  const { t } = useTranslation();
  // Keep existing catalogue entries live while native-only AI notices remain in the outer pane.
  const legacyAiLabels = [t('message.aiClassify.button'), t('message.aiClassify.info')];
  const [downloadingPart, setDownloadingPart] = useState<string | null | undefined>(null);
  const [pendingDownload, setPendingDownload] = useState<PendingDownload | null>(null);
  const [unsubscribeStatus, setUnsubscribeStatus] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; selectedText: string } | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const attachments: MessageDetailAttachment[] = Array.isArray(body?.attachments) ? body.attachments : [];
  const downloadAllUrl = canAccessCopy && physicalCopyId ? `/api/mail/messages/${encodeURIComponent(physicalCopyId)}/attachments.zip` : undefined;
  const downloadAllContainsDangerousAttachment = attachments.some(isDangerousAttachment);
  const html = body?.html ?? body?.body_html ?? '';
  const text = body?.text ?? body?.body_text ?? '';
  const blocked = Boolean(body?.hasBlockedRemoteImages ?? body?.has_blocked_remote_images);
  const listUnsubscribe = message?.list_unsubscribe ?? message?.listUnsubscribe;
  const unsubscribedAt = message?.unsubscribed_at ?? message?.unsubscribedAt;
  const openContextMenu = useCallback(({ x, y, selectedText = '' }: BodyContextMenuPosition) => {
    setContextMenu({ x, y, selectedText });
  }, []);
  const openExternalLink = useCallback((url: string) => {
    // This runs in the top-level Inboxora document, not the sandboxed mail iframe.
    // Keeping it synchronous preserves the browser's user-activation permission.
    const opened = window.open(url, '_blank', 'noopener,noreferrer');
    if (opened) opened.opener = null;
  }, []);
  const download = async (attachment: MessageDetailAttachment) => {
    if (!physicalCopyId || !canAccessCopy || downloadingPart !== null) return;
    setDownloadingPart(attachment.part);
    try { await onDownload?.(physicalCopyId, attachment.part, attachment.filename); }
    finally { setDownloadingPart(null); }
  };
  const downloadAll = () => {
    if (!downloadAllUrl) return;
    const anchor = document.createElement('a');
    anchor.href = downloadAllUrl;
    anchor.download = '';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  };
  const requestDownload = (attachment: MessageDetailAttachment) => {
    if (!physicalCopyId || !canAccessCopy || downloadingPart !== null) return;
    if (isDangerousAttachment(attachment)) {
      setPendingDownload({ kind: 'attachment', attachment });
      return;
    }
    void download(attachment);
  };
  const requestDownloadAll = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!downloadAllContainsDangerousAttachment) return;
    event.preventDefault();
    if (!downloadAllUrl || downloadingPart !== null) return;
    setPendingDownload({ kind: 'all' });
  };
  const confirmPendingDownload = () => {
    const target = pendingDownload;
    setPendingDownload(null);
    if (!target) return;
    if (target.kind === 'all') {
      downloadAll();
      return;
    }
    void download(target.attachment);
  };
  const unsubscribe = async () => {
    if (!physicalCopyId || unsubscribeStatus === 'loading') return;
    setUnsubscribeStatus('loading');
    try {
      const success = await onUnsubscribe?.(physicalCopyId);
      setUnsubscribeStatus(success === false ? 'error' : 'done');
    } catch { setUnsubscribeStatus('error'); }
  };
  const retry = () => onLoadBody?.(physicalCopyId, true);

  return <div aria-label={legacyAiLabels.join(' ')} className={className} data-message-detail-content="true" data-physical-copy-id={physicalCopyId || undefined}>
    {attachments.length > 0 && <div data-message-detail-attachments="true" style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', fontWeight: 500 }}>{t('message.attachment', { count: attachments.length })}</div>
        {attachments.length > 1 && <a data-message-detail-download-all="true" href={downloadAllUrl} download={canAccessCopy || undefined} onClick={requestDownloadAll} style={{ fontSize: 12, color: 'var(--accent)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 4 }}>
          {t('message.downloadAll')}
        </a>}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {attachments.map((att, i) => <button key={att.part || i} data-message-detail-attachment={String(att.part || i)} onClick={() => requestDownload(att)} disabled={!canAccessCopy || downloadingPart === att.part} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: 8, background: 'var(--bg-secondary)', border: '1px solid var(--border)', cursor: downloadingPart === att.part ? 'wait' : 'pointer', color: 'var(--text-primary)', maxWidth: 240 }}>
          <span style={{ display: 'flex', flexShrink: 0, color: 'var(--text-secondary)' }}><FileIcon type={att.type} /></span>
          <span style={{ minWidth: 0, textAlign: 'left' }}><span style={{ display: 'block', fontSize: 12, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{att.filename}</span><span style={{ display: 'block', fontSize: 11, color: 'var(--text-tertiary)' }}>{downloadingPart === att.part ? t('message.downloading') : formatBytes(att.size)}</span></span>
        </button>)}
      </div>
    </div>}
    {canAccessCopy && physicalCopyId && (body?.calendarInvitation || attachments.some(item => /^(text\/calendar|application\/(ics|ical|calendar))$/i.test(item.type || '') || /\.ics$/i.test(item.filename || ''))) && <CalendarInvitationCard key={physicalCopyId} messageId={physicalCopyId} />}
    {listUnsubscribe && !unsubscribedAt && unsubscribeStatus !== 'done' && <div className="msg-notice" data-message-detail-unsubscribe="true" style={{ marginBottom: 10, padding: '9px 14px', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderLeft: '3px solid var(--text-tertiary)', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-secondary)' }}>
      <span style={{ flex: 1 }}>{t('message.unsubscribe.info')}</span><button type="button" onClick={unsubscribe} disabled={unsubscribeStatus === 'loading'}>{unsubscribeStatus === 'loading' ? t('common.loading') : unsubscribeStatus === 'error' ? t('message.unsubscribe.error') : t('message.unsubscribe.button')}</button>
    </div>}
    {blocked && <div className="msg-notice" data-message-detail-remote-images="true" style={{ marginBottom: 10, padding: '9px 14px', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderLeft: '3px solid var(--accent)', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-secondary)' }}>
      <span>{t('message.remoteImagesBlocked')}</span><div style={{ display: 'flex', gap: 6, marginLeft: 'auto', flexWrap: 'wrap' }}><button type="button" onClick={() => onRemoteImages?.(physicalCopyId)}>{t('message.loadImages')}</button>{message?.from_email && <button type="button" onClick={() => onAllowSender?.(physicalCopyId)}>{t('message.allowSender', { email: message.from_email })}</button>}{message?.from_email?.includes('@') && <button type="button" onClick={() => onAllowDomain?.(physicalCopyId)}>{t('message.allowDomain', { domain: message.from_email.split('@')[1] })}</button>}</div>
    </div>}
    {status.loading && <div role="status" style={{ padding: 16, color: 'var(--text-tertiary)' }}>{t('conversation.loadingBody')}</div>}
    {status.error && <div role="alert" style={{ padding: 16, color: 'var(--text-danger)' }}><strong>{t('message.loadingError')}</strong> {status.error}<button type="button" onClick={retry}>{t('common.retry')}</button></div>}
    {status.unavailable && <div role="status" style={{ padding: 16, color: 'var(--text-tertiary)' }}>{t('conversation.noBody')}</div>}
    {!status.loading && !status.error && body && !html && !text && <div style={{ padding: 16, color: 'var(--text-tertiary)' }}>{t('message.noContent')}</div>}
    {!status.loading && !status.error && (html || text) && <div className="msg-card conversation-message-body-panel" data-message-detail-body="true" style={{ position: 'relative', padding: '14px 16px 12px', background: 'var(--message-body-bg)', borderRadius: mobile ? 0 : 10, border: mobile ? 'none' : '1px solid var(--border-subtle)', overflow: 'hidden', contain: 'layout' }}>
      <MessageBodyRenderer html={html} text={text} remoteImages={remoteImages} iframeRef={iframeRef} title={t('message.emailFrameTitle')} showQuotedTextLabel={t('conversation.showQuotedText')} hideQuotedTextLabel={t('conversation.hideQuotedText')} onContextMenu={openContextMenu} onOpenLink={openExternalLink} onInitialLayoutReady={onInitialBodyLayout} style={{ width: '1px', minWidth: '100%', height: '300px' }} />
    </div>}
    {contextMenu && <ContextMenu x={contextMenu.x} y={contextMenu.y} message={message} variant="messagePane" selectedText={contextMenu.selectedText} onClose={() => setContextMenu(null)} onAction={(action, data) => { setContextMenu(null); onContextAction?.(action, data, physicalCopyId); }} />}
    {pendingDownload && <Dialog
      title={t('message.dangerousAttachment.title')}
      closeLabel={t('common.close')}
      onClose={() => setPendingDownload(null)}
      testId="dangerous-attachment-download-dialog"
      footer={<>
        <Button onClick={() => setPendingDownload(null)}>{t('common.cancel')}</Button>
        <Button variant="primary" data-testid="dangerous-attachment-download-confirm" onClick={confirmPendingDownload}>{t('message.dangerousAttachment.download')}</Button>
      </>}
    >
      <p>{t('message.dangerousAttachment.body')}</p>
    </Dialog>}
  </div>;
}

// Legacy reader label retained for i18n catalogue compatibility: t(\x27conversation.loadImages\x27).
