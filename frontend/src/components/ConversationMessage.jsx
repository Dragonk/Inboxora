import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { sanitizeMessageHtml } from './MessageBodyRenderer.jsx';
import MessageDetailContent from './MessageDetailContent.jsx';
import { MessageAvatar, MessageDirection } from './MessagePresentation.jsx';
import MessageToolbar from './MessageToolbar.jsx';
import MessageHeaderModal from './MessageHeaderModal.jsx';
import { useMobile } from '../hooks/useMobile.js';
import { useStore } from '../store/index.js';
import { physicalCopyDirection, preferredAccountCopy } from '../utils/conversationDirection.js';
import { api } from '../utils/api.js';
import { conversationApi } from '../utils/conversationApi.js';

function address(value) {
  if (!value) return '';
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return value; } }
  const values = Array.isArray(value) ? value : [value];
  return values.map(item => {
    if (typeof item === 'string') return item;
    const email = item.email || item.address || '';
    return item.name && email ? `${item.name} <${email}>` : (email || item.name || '');
  }).filter(Boolean).join(', ');
}

function date(value) {
  return value ? new Date(value).toLocaleString([], {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }) : '';
}

export default function ConversationMessage({ conversationId, message, selectedCopyId, selectedAccountId, accounts, expanded, onToggle, body, status, onLoadBody, onRemoteImages, onReply, onActionComplete, onSetRead }) {
  const { t } = useTranslation();
  const isMobile = useMobile();
  const { replyDefault, aiActions, setShowAdmin, setAdminTab, blockRemoteImages, imageWhitelist } = useStore();
  const copy = preferredAccountCopy(message, selectedAccountId, selectedCopyId) || {};
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
  const subject = message.subject || copy.subject || t('message.noSubject');
  const recipient = address(copy.to);
  const summary = String(copy.snippet || '').trim();
  const accountColor = account?.color || 'var(--accent)';
  const accountLabel = account?.name || account?.email_address || account?.email || '';
  const [unsubscribeStatus, setUnsubscribeStatus] = useState(null);
  const [folders, setFolders] = useState([]);
  const [foldersLoading, setFoldersLoading] = useState(false);
  const [showHeaders, setShowHeaders] = useState(false);
  const [actionError, setActionError] = useState(null);

  const toggle = () => {
    onToggle(message.id);
    if (!expanded && !body && !status?.loading) onLoadBody(message.id);
  };
  const reply = (replyAll = false, forward = false) => {
    if (!hasAccountCopy) return;
    onReply?.({
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
  const runAction = async callback => {
    if (!hasAccountCopy) return;
    setActionError(null);
    try {
      await callback();
      await onActionComplete?.();
    } catch (error) {
      setActionError(error.message || t('common.error'));
    }
  };
  const loadFolders = async () => {
    if (!hasAccountCopy || foldersLoading || folders.length) return;
    setFoldersLoading(true);
    try {
      const result = await api.getFolders(selectedAccountId);
      setFolders(Array.isArray(result) ? result : (result.folders || []));
    } catch (error) {
      setActionError(error.message || t('common.error'));
    } finally {
      setFoldersLoading(false);
    }
  };
  const handlePrint = () => {
    const win = window.open('', '_blank');
    if (!win) return;
    const escaped = value => String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const content = bodyHtml ? sanitizeMessageHtml(bodyHtml) : `<pre>${escaped(bodyText)}</pre>`;
    win.document.write(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; base-uri 'none'"><title>${escaped(subject)}</title></head><body><h1>${escaped(subject)}</h1><p>${escaped(sender)} · ${escaped(date(message.messageDate || copy.date))}</p>${content}</body></html>`);
    win.document.close();
    win.print();
  };
  const inSpamFolder = /(^|\/)(spam|junk)(\/|$)/i.test(String(copy.folder || ''));
  const availableAiActions = body ? [{ id: 'summarize', label: t('message.summarize'), prompt: 'Summarize this email.' }, ...(aiActions || [])] : [];
  const runAiAction = action => {
    const text = bodyText || String(bodyHtml || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text || !action?.prompt) return;
    api.ai.chat([{ role: 'user', content: `${action.prompt}\n\n${text.slice(0, 6000)}` }]).catch(error => setActionError(error.message));
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
      background: 'var(--bg-secondary)',
      borderRadius: 10,
      border: '1px solid var(--border-subtle)',
      borderLeft: `3px solid ${accountColor}`,
      overflow: 'visible', position: 'relative', zIndex: expanded ? 2 : 1,
      boxShadow: 'var(--shadow-soft), inset 0 1px 0 rgba(255,255,255,0.04)',
    }}>
      {expanded && hasAccountCopy && <MessageToolbar
        isMobile={isMobile}
        defaultReplyAll={replyDefault === 'replyAll'}
        targetId={message.id}
        isRead={Boolean(copy.isRead ?? copy.is_read)}
        isStarred={Boolean(copy.isStarred ?? copy.is_starred)}
        currentFolder={copy.folder}
        folders={folders}
        foldersLoading={foldersLoading}
        onLoadFolders={loadFolders}
        onReply={() => reply()}
        onReplyAll={() => reply(true)}
        onForward={() => reply(false, true)}
        onArchive={() => runAction(() => conversationApi.archive(conversationId, actionOptions))}
        onMove={folder => runAction(() => conversationApi.move(conversationId, folder, actionOptions))}
        onSpam={!inSpamFolder ? () => runAction(() => api.markSpam(copy.id)) : undefined}
        onHam={inSpamFolder ? () => runAction(() => api.markHam(copy.id)) : undefined}
        onSetRead={isRead => runAction(() => onSetRead ? onSetRead(copy.id, isRead) : conversationApi.setRead(conversationId, isRead, actionOptions))}
        onViewHeaders={() => setShowHeaders(true)}
        onPrint={body ? handlePrint : undefined}
        aiActions={availableAiActions}
        onAiAction={runAiAction}
        onManageAiActions={() => { setAdminTab('ai-actions'); setShowAdmin(true); }}
        onStar={() => runAction(() => conversationApi.setStarred(conversationId, !(copy.isStarred ?? copy.is_starred), actionOptions))}
        onDelete={() => runAction(() => conversationApi.delete(conversationId, actionOptions))}
      />}

      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={toggleLabel}
        onClick={() => {
          if (window.getSelection?.().toString()) return;
          toggle();
        }}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggle();
          }
        }}
        data-conversation-message-toggle="true"
        style={{
          display: 'block', width: '100%', padding: 0,
          border: 0, background: 'transparent', color: 'var(--text-primary)',
          cursor: 'pointer', textAlign: 'left', userSelect: 'text',
        }}
      >
        <span style={{
          display: 'block', padding: '14px 16px 12px',
          borderBottom: '1px solid var(--border-subtle)',
          fontSize: 17, fontWeight: 600, lineHeight: 1.3,
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
              {date(message.messageDate || copy.date)}
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
      <MessageDetailContent
        physicalCopyId={copy.id}
        message={{ ...copy, id: copy.id, account_id: selectedAccountId, subject, from_email: copy.fromEmail || copy.from_email, from_name: copy.fromName || copy.from_name, list_unsubscribe: copy.listUnsubscribe ?? copy.list_unsubscribe, unsubscribed_at: copy.unsubscribedAt ?? copy.unsubscribed_at }}
        body={body}
        status={status}
        remoteImages={remoteImages}
        onLoadBody={(_, force) => onLoadBody(message.id, force)}
        onRemoteImages={() => onRemoteImages(message.id)}
        onUnsubscribe={handleUnsubscribe}
        onDownload={async (physicalCopyId, part, filename) => {
          const response = await fetch(`/api/mail/messages/${encodeURIComponent(physicalCopyId)}/attachments/${encodeURIComponent(part)}`);
          if (!response.ok) throw new Error('Download failed');
          const blob = await response.blob(); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename || 'attachment'; anchor.click(); URL.revokeObjectURL(url);
        }}
        onContextAction={(action, data, physicalCopyId) => {
          if (action === 'reply') return reply(); if (action === 'replyAll') return reply(true); if (action === 'forward') return reply(false, true);
          if (action === 'archive') return runAction(() => conversationApi.archive(conversationId, { ...actionOptions, copyId: physicalCopyId }));
          if (action === 'delete') return runAction(() => conversationApi.delete(conversationId, { ...actionOptions, copyId: physicalCopyId }));
          if (action === 'markSpam') return runAction(() => api.markSpam(physicalCopyId)); if (action === 'markHam') return runAction(() => api.markHam(physicalCopyId));
          if (action === 'moveTo' && data) return runAction(() => conversationApi.move(conversationId, data, { ...actionOptions, copyId: physicalCopyId }));
        }}
        canAccessCopy={hasAccountCopy}
        mobile={isMobile}
      />
    </div>}

    {showHeaders && <MessageHeaderModal messageId={copy.id} subject={subject} onClose={() => setShowHeaders(false)} />}
  </article>;
}
