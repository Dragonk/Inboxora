import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConversationLogicalMessage, ConversationReplyPayload, MessageBody, MessageBodyStatus } from './ConversationReader.tsx';
import type { StoreState } from '../store/index.ts';
import { sanitizeMessageHtml } from './MessageBodyRenderer.tsx';
import MessageDetailContent from './MessageDetailContent.tsx';
import { MessageAvatar, MessageDirection } from './MessagePresentation.tsx';
import MessageToolbar from './MessageToolbar.tsx';
import MessageHeaderModal from './MessageHeaderModal.tsx';
import { useMobile } from '../hooks/useMobile.ts';
import { useStore } from '../store/index.ts';
import { physicalCopyDirection, preferredAccountCopy } from '../utils/conversationDirection.ts';
import { api, isAbortError } from '../utils/api.ts';
import { conversationApi } from '../utils/conversationApi.ts';
import { toAppError } from '../utils/errors.ts';
import AiMarkdown from './AiMarkdown.tsx';

function address(value: unknown): string {
  if (!value) return '';
  let parsed: unknown = value;
  if (typeof value === 'string') { try { parsed = JSON.parse(value); } catch { return value; } }
  const values = Array.isArray(parsed) ? parsed : [parsed];
  return values.map(item => {
    if (typeof item === 'string') return item;
    const email = item.email || item.address || '';
    return item.name && email ? `${item.name} <${email}>` : (email || item.name || '');
  }).filter(Boolean).join(', ');
}

interface ToolbarFolder {
  path: string;
  name?: string;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toToolbarFolders(value: unknown): ToolbarFolder[] {
  const folders = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.folders)
      ? value.folders
      : [];

  return folders.flatMap(folder => {
    if (!isRecord(folder) || typeof folder.path !== 'string') return [];
    return typeof folder.name === 'string'
      ? [{ ...folder, path: folder.path, name: folder.name }]
      : [{ ...folder, path: folder.path }];
  });
}

function date(value: string | number | Date | null | undefined): string {
  return value ? new Date(value).toLocaleString([], {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }) : '';
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function timestamp(value: unknown): string | number | Date | undefined {
  return typeof value === 'string' || typeof value === 'number' || value instanceof Date ? value : undefined;
}

type DeliveryAddress = string | { email?: string | null; address?: string | null };

function deliveryAddresses(value: unknown): DeliveryAddress[] | string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;

  const addresses: DeliveryAddress[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      addresses.push(entry);
      continue;
    }
    if (!isRecord(entry)) return undefined;

    const email = entry.email === null ? null : text(entry.email);
    const address = entry.address === null ? null : text(entry.address);
    if (email === undefined && address === undefined) return undefined;
    addresses.push({ email, address });
  }
  return addresses;
}

interface ConversationCopyView {
  id?: string;
  messageId?: string;
  message_id?: string;
  canonicalMessageId?: string;
  canonical_message_id?: string;
  inReplyTo?: string;
  in_reply_to?: string;
  references?: string;
  thread_references?: string;
  replyTo?: unknown;
  reply_to?: unknown;
  accountId?: string;
  account_id?: string;
  date?: string | number | Date;
  folder?: string;
  fromEmail?: string;
  from_email?: string;
  fromName?: string;
  from_name?: string;
  hasContactPhoto?: boolean;
  isRead?: boolean;
  is_read?: boolean;
  isStarred?: boolean;
  is_starred?: boolean;
  subject?: string;
  snippet?: string;
  to?: unknown;
  cc?: unknown;
  attachments?: unknown[];
  deliveryAddresses?: DeliveryAddress[] | string;
  delivery_addresses?: unknown;
  listUnsubscribe?: string;
  list_unsubscribe?: string;
  unsubscribedAt?: unknown;
  unsubscribed_at?: unknown;
  [key: string]: unknown;
}

export function conversationCopyView(value: unknown): ConversationCopyView {
  if (!isRecord(value)) return {};

  return {
    id: text(value.id),
    messageId: text(value.messageId),
    message_id: text(value.message_id),
    canonicalMessageId: text(value.canonicalMessageId),
    canonical_message_id: text(value.canonical_message_id),
    inReplyTo: text(value.inReplyTo),
    in_reply_to: text(value.in_reply_to),
    references: text(value.references),
    thread_references: text(value.thread_references),
    replyTo: value.replyTo,
    reply_to: value.reply_to,
    accountId: text(value.accountId),
    account_id: text(value.account_id),
    date: timestamp(value.date),
    folder: text(value.folder),
    fromEmail: text(value.fromEmail),
    from_email: text(value.from_email),
    fromName: text(value.fromName),
    from_name: text(value.from_name),
    hasContactPhoto: boolean(value.hasContactPhoto),
    isRead: boolean(value.isRead),
    is_read: boolean(value.is_read),
    isStarred: boolean(value.isStarred),
    is_starred: boolean(value.is_starred),
    subject: text(value.subject),
    snippet: text(value.snippet),
    to: value.to,
    cc: value.cc,
    attachments: Array.isArray(value.attachments) ? value.attachments : undefined,
    deliveryAddresses: deliveryAddresses(value.deliveryAddresses),
    delivery_addresses: value.delivery_addresses,
    listUnsubscribe: text(value.listUnsubscribe),
    list_unsubscribe: text(value.list_unsubscribe),
    unsubscribedAt: value.unsubscribedAt,
    unsubscribed_at: value.unsubscribed_at,
  };
}

/** One logical message rendered inside the conversation. */
interface ConversationMessageProps {
  conversationId: string;
  message: ConversationLogicalMessage;
  selectedCopyId: string | null | undefined;
  selectedAccountId: string | null | undefined;
  accounts: StoreState['accounts'];
  expanded: boolean;
  onToggle: (id: string) => void;
  body: MessageBody | null | undefined;
  status: MessageBodyStatus | null | undefined;
  onLoadBody: (logicalId: string, force?: boolean, remoteImages?: boolean) => void;
  onRemoteImages: (id: string) => void;
  onReply: (message: ConversationReplyPayload, all?: boolean) => void;
  onActionComplete: (mutation: { logicalMessageId?: string; copyId?: string; [key: string]: unknown }) => Promise<void>;
  onSetRead: (copyId: string, read: boolean) => void;
  onInitialBodyLayout?: (copyId: string) => void;
}
export default function ConversationMessage({ conversationId, message, selectedCopyId, selectedAccountId, accounts, expanded, onToggle, body, status, onLoadBody, onRemoteImages, onReply, onActionComplete, onSetRead, onInitialBodyLayout }: ConversationMessageProps) {
  const { t } = useTranslation();
  const isMobile = useMobile();
  const { replyDefault, aiActions, setShowAdmin, setAdminTab, blockRemoteImages, imageWhitelist } = useStore();
  const copy = conversationCopyView(preferredAccountCopy(message, selectedAccountId, selectedCopyId));
  const messageSubject = text(message.subject);
  const messageDate = timestamp(message.messageDate);
  const initialBodyLayoutRef = useRef(onInitialBodyLayout);
  initialBodyLayoutRef.current = onInitialBodyLayout;
  const handleInitialBodyLayout = useCallback(() => {
    const onInitialLayout = initialBodyLayoutRef.current;
    const copyId = copy.id;
    if (onInitialLayout && copyId) onInitialLayout(copyId);
  }, [copy.id]);
  const account = accounts.find(item => String(item.id) === String(selectedAccountId));
  const hasAccountCopy = Boolean(copy.id && account && selectedAccountId
    && String(copy.accountId ?? copy.account_id) === String(selectedAccountId));
  const direction = physicalCopyDirection(copy, account);
  const outgoing = direction === 'outgoing';
  const attachments = Array.isArray(body?.attachments) ? body.attachments : (Array.isArray(copy.attachments) ? copy.attachments : []);
  const bodyHtml = body?.html ?? body?.body_html ?? null;
  const bodyText = body?.text ?? body?.body_text ?? null;
  const senderEmail = String(copy.fromEmail || copy.from_email || '').toLowerCase();
  const senderDomain = senderEmail.includes('@') ? senderEmail.split('@').pop() : '';
  const senderAllowsImages = (imageWhitelist?.addresses || []).some(value => String(value).toLowerCase() === senderEmail)
    || (imageWhitelist?.domains || []).some(value => String(value).toLowerCase() === senderDomain);
  const remoteImages = Boolean(body?.remoteImages ?? body?.remote_images) || !blockRemoteImages || senderAllowsImages;
  const sender = outgoing ? t('conversation.you') : (copy.fromName || copy.fromEmail || t('conversation.unknownSender'));
  const directionLabel = direction === 'outgoing' ? t('conversation.outgoingMessage') : direction === 'incoming' ? t('conversation.incomingMessage') : undefined;
  const subject = messageSubject || copy.subject || t('message.noSubject');
  const detailMessage = (() => {
    const copyId = copy.id;
    if (!copyId || !selectedAccountId) return null;
    return {
      ...copy,
      id: copyId,
      account_id: selectedAccountId,
      subject,
      from_email: copy.fromEmail || copy.from_email,
      from_name: copy.fromName || copy.from_name,
      list_unsubscribe: copy.listUnsubscribe ?? copy.list_unsubscribe,
      unsubscribed_at: copy.unsubscribedAt ?? copy.unsubscribed_at,
    };
  })();
  const recipient = address(copy.to);
  const summary = String(copy.snippet || '').trim();
  const accountColor = account?.color || 'var(--accent)';
  const accountLabel = account?.name || account?.email_address || '';
  const [unsubscribeStatus, setUnsubscribeStatus] = useState<string | null>(null);
  const [folders, setFolders] = useState<ToolbarFolder[]>([]);
  const [foldersLoading, setFoldersLoading] = useState(false);
  const [showHeaders, setShowHeaders] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [aiResults, setAiResults] = useState<Record<string, { status: 'loading' | 'done' | 'error'; text: string; label: string }>>({});
  const aiAbortRefs = useRef<Record<string, AbortController | undefined>>({});
  useEffect(() => () => {
    Object.values(aiAbortRefs.current).forEach(controller => controller?.abort());
  }, []);

  const toggle = () => {
    onToggle(message.id);
    if (!expanded && !body && !status?.loading) onLoadBody(message.id);
  };
  const reply = (replyAll = false, forward = false) => {
    if (!hasAccountCopy || !copy.id || !selectedAccountId) return;
    onReply({
      ...copy,
      logicalMessageId: message.id,
      selectedCopyId: copy.id,
      accountId: selectedAccountId,
      conversationId,
      replyAll,
      forward,
      attachments,
    });
  };
  const handleUnsubscribe = async () => {
    if (!copy.id || unsubscribeStatus === 'loading') return;
    setUnsubscribeStatus('loading');
    try {
      const result = await api.unsubscribeMessage(copy.id);
      const succeeded = result.type === 'one-click' || result.type === 'url' || result.type === 'mailto';
      if (!succeeded) { setUnsubscribeStatus('error'); return false; }
      if (result.type === 'url' && result.url) window.open(result.url, '_blank', 'noopener,noreferrer');
      else if (result.type === 'mailto' && result.mailto) window.open(result.mailto, '_blank', 'noopener,noreferrer');
      setUnsubscribeStatus('done');
      return true;
    } catch {
      setUnsubscribeStatus('error');
      return false;
    }
  };

  const actionOptions = { scope: 'THIS_COPY', copyId: copy.id, logicalMessageId: message.id };
  const runAction = async (callback: () => void, action: string, actionState: Record<string, unknown> = {}) => {
    if (!hasAccountCopy) return;
    setActionError(null);
    try {
      await callback();
      await onActionComplete({
        action,
        copyId: copy.id,
        logicalMessageId: message.id,
        ...actionState,
      });
    } catch (error) {
      setActionError(toAppError(error).message || t('common.error'));
    }
  };
  const loadFolders = async () => {
    if (!hasAccountCopy || foldersLoading || folders.length) return;
    setFoldersLoading(true);
    try {
      if (!selectedAccountId) return;
      const result = await api.getFolders(selectedAccountId);
      setFolders(toToolbarFolders(result));
    } catch (error) {
      setActionError(toAppError(error).message || t('common.error'));
    } finally {
      setFoldersLoading(false);
    }
  };
  const handlePrint = () => {
    const win = window.open('', '_blank');
    if (!win) return;
    const escaped = (value: unknown) => String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const content = bodyHtml ? sanitizeMessageHtml(bodyHtml) : `<pre>${escaped(bodyText)}</pre>`;
    win.document.write(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; base-uri 'none'"><title>${escaped(subject)}</title></head><body><h1>${escaped(subject)}</h1><p>${escaped(sender)} · ${escaped(date(messageDate || copy.date))}</p>${content}</body></html>`);
    win.document.close();
    win.print();
  };
  const inSpamFolder = /(^|\/)(spam|junk)(\/|$)/i.test(String(copy.folder || ''));
  const availableAiActions = body ? [{ id: 'summarize', label: t('message.summarize'), prompt: 'Summarize this email.' }, ...(aiActions || [])] : [];
  const runAiAction = async (action: { id: string; [key: string]: unknown }) => {
    const text = bodyText || String(bodyHtml || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const prompt = typeof action.prompt === 'string' ? action.prompt : '';
    if (!text || !prompt || !action.id) return;

    const key = action.id;
    const label = typeof action.label === 'string' ? action.label : key;
    aiAbortRefs.current[key]?.abort();
    const controller = new AbortController();
    aiAbortRefs.current[key] = controller;
    setAiResults(results => ({ ...results, [key]: { status: 'loading', text: '', label } }));
    try {
      const result = await api.ai.chat([{ role: 'user', content: `${prompt}\n\n${text.slice(0, 6000)}` }], {
        signal: controller.signal,
        onDelta: partial => setAiResults(results => ({ ...results, [key]: { status: 'loading', text: partial, label } })),
      });
      setAiResults(results => ({ ...results, [key]: { status: 'done', text: result, label } }));
    } catch (error) {
      if (isAbortError(error)) return;
      setAiResults(results => ({ ...results, [key]: { status: 'error', text: toAppError(error).message, label } }));
    }
  };

  const toggleLabel = t(expanded ? 'conversation.collapseMessage' : 'conversation.expandMessage', { sender, subject });

  return <article
    id={`logical-message-${message.id}`}
    data-physical-copy-id={copy.id || undefined}
    data-logical-message-id={message._ceMatched === false ? undefined : message.id}
    data-conversation-message-state={expanded ? 'expanded' : 'collapsed'}
    style={{
      // Mobile: match native MessagePane single-message padding (12px 0 0) so the
      // reader fills the pane width without desktop-style 28px side margins.
      // Desktop: keep the approved card mock-up spacing.
      padding: isMobile ? '12px 0 0' : '24px 28px 0',
      background: 'var(--bg-primary)',
    }}
  >
    <div className="msg-card" style={{
      marginBottom: expanded ? 12 : 24,
      background: 'var(--bg-elevated)',
      borderRadius: 10,
      border: '1px solid var(--border-subtle)',
      borderLeft: `3px solid ${accountColor}`,
      overflow: 'visible', position: 'relative', zIndex: expanded ? 2 : 1,
      boxShadow: 'var(--shadow-soft), inset 0 1px 0 rgba(255,255,255,0.04)',
    }}>
      {expanded && hasAccountCopy && <MessageToolbar
        folderMappings={account?.folder_mappings}
        isMobile={isMobile}
        defaultReplyAll={replyDefault === 'replyAll'}
        targetId={message.id}
        scrollAnchorId={copy.id}
        isRead={Boolean(copy.isRead ?? copy.is_read)}
        isStarred={Boolean(copy.isStarred ?? copy.is_starred)}
        currentFolder={copy.folder}
        folders={folders}
        foldersLoading={foldersLoading}
        onLoadFolders={loadFolders}
        onReply={() => reply()}
        onReplyAll={() => reply(true)}
        onForward={() => reply(false, true)}
        onArchive={() => runAction(() => conversationApi.archive(conversationId, actionOptions), 'archive')}
        onMove={folder => runAction(() => conversationApi.move(conversationId, folder, actionOptions), 'move')}
        onSpam={!inSpamFolder ? () => {
          const copyId = copy.id;
          if (!copyId) return;
          return runAction(() => api.markSpam(copyId), 'spam');
        } : undefined}
        onHam={inSpamFolder ? () => {
          const copyId = copy.id;
          if (!copyId) return;
          return runAction(() => api.markHam(copyId), 'ham');
        } : undefined}
        onSetRead={isRead => {
          const copyId = copy.id;
          if (!copyId) return;
          return runAction(() => onSetRead(copyId, isRead), 'read', { isRead });
        }}
        onViewHeaders={() => setShowHeaders(true)}
        onPrint={body ? handlePrint : undefined}
        aiActions={availableAiActions}
        onAiAction={action => { void runAiAction(action); }}
        onManageAiActions={() => { setAdminTab('ai-actions'); setShowAdmin(true); }}
        onStar={() => {
          const isStarred = !(copy.isStarred ?? copy.is_starred);
          return runAction(() => conversationApi.setStarred(conversationId, isStarred, actionOptions), 'star', { isStarred });
        }}
        onDelete={() => runAction(() => conversationApi.delete(conversationId, actionOptions), 'delete')}
      />}

      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={toggleLabel}
        onClick={() => {
          const selection = window.getSelection();
          if (selection !== null && selection.toString()) return;
          toggle();
        }}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggle();
          }
        }}
        data-conversation-message-toggle="true"
        data-conversation-message-header={copy.id || undefined}
        style={{
          display: 'block', width: '100%', padding: 0,
          border: 0, background: 'transparent', color: 'var(--text-primary)',
          cursor: 'pointer', textAlign: 'left', userSelect: 'text',
        }}
      >
        <span style={{
          display: 'block', padding: '14px 16px 12px',
          borderBottom: '1px solid var(--border-subtle)',
          fontSize: 19, fontWeight: 600, lineHeight: 1.3,
          fontFamily: 'var(--font-display)',
        }}>
          <span data-conversation-message-subject="true" data-unread={String(!(copy.isRead ?? copy.is_read))} style={{ fontWeight: (copy.isRead ?? copy.is_read) ? 400 : 700 }}>{subject}</span>
        </span>

        <span style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px 16px' }}>
          <MessageAvatar email={copy.fromEmail} name={copy.fromName || sender} size={40} hasContactPhoto={copy.hasContactPhoto} />
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <MessageDirection direction={direction} label={directionLabel} />
              <strong style={{ fontSize: 14, color: 'var(--text-primary)', userSelect: 'text' }}>{sender}</strong>
              {copy.fromEmail && (outgoing || copy.fromName) && <span title={copy.fromEmail} style={{ fontSize: 12, color: 'var(--text-tertiary)', userSelect: 'text' }}>{outgoing ? copy.fromEmail : `<${copy.fromEmail}>`}</span>}
            </span>
            <span style={{ display: 'block', fontSize: 12, color: 'var(--text-tertiary)', marginTop: 3 }}>
              <span>{t('message.to')} </span>
              <span title={recipient || accountLabel} style={{ color: 'var(--text-secondary)', userSelect: 'text' }}>{recipient || accountLabel}</span>
            </span>
            {address(copy.cc) && <span style={{ display: 'block', fontSize: 12, color: 'var(--text-tertiary)', marginTop: 3 }}>
              <span>{t('message.cc', { defaultValue: 'Cc' })} </span>
              <span title={address(copy.cc)} style={{ color: 'var(--text-secondary)', userSelect: 'text' }}>{address(copy.cc)}</span>
            </span>}
            {!expanded && summary && <span data-conversation-message-snippet="true" style={{
              display: 'block', fontSize: 12, color: 'var(--text-tertiary)', marginTop: 3,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              <span>{t('conversation.summary')} </span>
              <span style={{ color: 'var(--text-secondary)' }}>{summary}</span>
            </span>}
          </span>
          <span style={{ flexShrink: 0, textAlign: 'right' }}>
            <time style={{ display: 'block', fontSize: 12, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
              {date(messageDate || copy.date)}
            </time>
            {accountLabel && <span style={{
              fontSize: 11, marginTop: 4, display: 'flex', alignItems: 'center',
              gap: 4, justifyContent: 'flex-end', color: 'var(--text-tertiary)',
            }}>
              <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%', background: accountColor }} />
              {accountLabel}
            </span>}
          </span>
        </span>
      </div>
    </div>

    {actionError && <div role="alert" style={{ padding: '8px 12px', color: 'var(--red)' }}>{actionError}</div>}
    {expanded && <div data-conversation-message-expanded-content="true" style={{ padding: '0 0 12px' }}>
      {Object.entries(aiResults).map(([key, result]) => (
        <section key={key} data-testid="conversation-ai-result" data-ai-action-id={key} style={{ margin: '0 12px 12px', padding: '12px 14px', border: '1px solid var(--border)', borderLeft: '3px solid var(--accent)', borderRadius: 8, background: 'var(--bg-secondary)' }}>
          <strong style={{ display: 'block', fontSize: 12, color: 'var(--accent)', marginBottom: 6 }}>{result.label}</strong>
          {result.status === 'loading' && <span role="status" style={{ color: 'var(--text-tertiary)', fontStyle: 'italic', whiteSpace: 'pre-wrap' }}>{result.text || t('compose.toolbar.aiGenerating')}</span>}
          {result.status === 'error' && <span role="alert" style={{ color: 'var(--red)', whiteSpace: 'pre-wrap' }}>{t('compose.toolbar.aiError', { message: result.text })}</span>}
          {result.status === 'done' && <AiMarkdown markdown={result.text} />}
        </section>
      ))}
      {!hasAccountCopy && <div role="status" style={{ padding: 16, color: 'var(--text-tertiary)' }}>{t('conversation.noBody')}</div>}
      {copy.id && detailMessage && <MessageDetailContent
        physicalCopyId={copy.id}
        message={detailMessage}
        body={body}
        status={status === null ? undefined : status}
        remoteImages={remoteImages}
        onLoadBody={(_: unknown, force?: boolean) => onLoadBody(message.id, force)}
        onRemoteImages={() => onRemoteImages(message.id)}
        onUnsubscribe={handleUnsubscribe}
        onDownload={async (physicalCopyId: string, part: string, filename: string) => {
          const response = await fetch(`/api/mail/messages/${encodeURIComponent(physicalCopyId)}/attachments/${encodeURIComponent(part)}`);
          if (!response.ok) throw new Error('Download failed');
          const blob = await response.blob(); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename || 'attachment'; anchor.click(); URL.revokeObjectURL(url);
        }}
        onContextAction={(action: string, data: string, physicalCopyId: string) => {
          if (action === 'reply') return reply(); if (action === 'replyAll') return reply(true); if (action === 'forward') return reply(false, true);
          if (action === 'archive') return runAction(() => conversationApi.archive(conversationId, { ...actionOptions, copyId: physicalCopyId }), 'archive', { copyId: physicalCopyId });
          if (action === 'delete') return runAction(() => conversationApi.delete(conversationId, { ...actionOptions, copyId: physicalCopyId }), 'delete', { copyId: physicalCopyId });
          if (action === 'markSpam') return runAction(() => api.markSpam(physicalCopyId), 'spam'); if (action === 'markHam') return runAction(() => api.markHam(physicalCopyId), 'ham');
          if (action === 'moveTo' && data) return runAction(() => conversationApi.move(conversationId, data, { ...actionOptions, copyId: physicalCopyId }), 'move', { copyId: physicalCopyId });
        }}
        onInitialBodyLayout={handleInitialBodyLayout}
        canAccessCopy={hasAccountCopy}
        mobile={isMobile}
      />}
    </div>}

    {showHeaders && copy.id && <MessageHeaderModal messageId={copy.id} subject={subject} onClose={() => setShowHeaders(false)} />}
  </article>;
}
