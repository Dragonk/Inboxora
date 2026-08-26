import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import MessageBodyRenderer from './MessageBodyRenderer.jsx';
import { MessageActionBar, MessageAvatar, MessageDirection, actionStyle } from './MessagePresentation.jsx';
import { physicalCopyDirection, preferredAccountCopy } from '../utils/conversationDirection.js';
import { api } from '../utils/api.js';

function address(value) {
  if (!value) return '';
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return value; } }
  const values = Array.isArray(value) ? value : [value];
  return values.map(item => typeof item === 'string' ? item : (item.name ? `${item.name} <${item.email}>` : item.email)).filter(Boolean).join(', ');
}

function date(value) {
  return value ? new Date(value).toLocaleString([], {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }) : '';
}

function AttachmentList({ attachments, physicalCopyId }) {
  const { t } = useTranslation();
  if (!attachments.length) return null;
  return <div data-conversation-message-attachments="true" style={{ marginTop: 16 }}>
    <div style={{ fontSize: 12, color: 'var(--text-tertiary)', fontWeight: 500, marginBottom: 8 }}>
      {t('message.attachment', { count: attachments.length })}
    </div>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {attachments.map((attachment, index) => <a
        key={attachment.part || index}
        href={physicalCopyId ? `/api/mail/messages/${encodeURIComponent(physicalCopyId)}/attachments/${encodeURIComponent(String(attachment.part || index))}` : undefined}
        download={attachment.filename}
        style={{
          ...actionStyle,
          display: 'inline-flex', alignItems: 'center', gap: 7,
          border: '1px solid var(--border)', textDecoration: 'none',
          background: 'var(--bg-secondary)',
        }}
      >
        <span aria-hidden="true">📎</span>
        <span>{attachment.filename || attachment.name || t('conversation.attachment')}</span>
      </a>)}
    </div>
  </div>;
}

export default function ConversationMessage({ message, selectedCopyId, selectedAccountId, accounts, expanded, onToggle, body, status, onLoadBody, onRemoteImages, onReply }) {
  const { t } = useTranslation();
  const copy = preferredAccountCopy(message, selectedAccountId, selectedCopyId) || {};
  const account = accounts.find(item => String(item.id) === String(copy.accountId || selectedAccountId));
  const direction = physicalCopyDirection(copy, account);
  const outgoing = direction === 'outgoing';
  const attachments = Array.isArray(body?.attachments) ? body.attachments : (Array.isArray(copy.attachments) ? copy.attachments : []);
  const sender = outgoing ? t('conversation.you') : (copy.fromName || copy.fromEmail || t('conversation.unknownSender'));
  const directionLabel = direction === 'outgoing' ? t('conversation.outgoingMessage') : direction === 'incoming' ? t('conversation.incomingMessage') : undefined;
  const subject = message.subject || copy.subject || t('message.noSubject');
  const recipient = address(copy.to);
  const summary = String(copy.snippet || '').trim();
  const accountColor = account?.color || 'var(--accent)';
  const accountLabel = account?.name || account?.email_address || account?.email || '';
  const [unsubscribeStatus, setUnsubscribeStatus] = useState(null);

  const toggle = () => {
    onToggle(message.id);
    if (!expanded && !body && !status?.loading) onLoadBody(message.id);
  };
  const reply = (replyAll = false, forward = false) => onReply?.({
    ...copy,
    logicalMessageId: message.id,
    selectedCopyId: copy.id,
    replyAll,
    forward,
    attachments,
  });
  const handleUnsubscribe = async () => {
    if (!copy.id || unsubscribeStatus === 'loading') return;
    setUnsubscribeStatus('loading');
    try {
      await api.unsubscribeMessage(copy.id);
      setUnsubscribeStatus('done');
    } catch {
      setUnsubscribeStatus('error');
    }
  };
  const toggleLabel = t(expanded ? 'conversation.collapseMessage' : 'conversation.expandMessage', { sender, subject });

  return <article
    id={`logical-message-${message.id}`}
    data-logical-message-id={message.id}
    data-conversation-message-state={expanded ? 'expanded' : 'collapsed'}
    style={{
      padding: '24px 28px 0',
      background: 'var(--bg-primary)',
    }}
  >
    <div className="msg-card" style={{
      marginBottom: expanded ? 12 : 24,
      background: 'var(--bg-secondary)',
      borderRadius: 10,
      border: '1px solid var(--border-subtle)',
      borderLeft: `3px solid ${accountColor}`,
      overflow: 'hidden',
      boxShadow: 'var(--shadow-soft), inset 0 1px 0 rgba(255,255,255,0.04)',
    }}>
      {expanded && <MessageActionBar
        targetId={message.id}
        onReply={event => { event.stopPropagation(); reply(); }}
        onReplyAll={event => { event.stopPropagation(); reply(true); }}
        onForward={event => { event.stopPropagation(); reply(false, true); }}
      />}

      <button
        type="button"
        aria-expanded={expanded}
        aria-label={toggleLabel}
        onClick={toggle}
        data-conversation-message-toggle="true"
        style={{
          display: 'block', width: '100%', padding: 0,
          border: 0, background: 'transparent', color: 'var(--text-primary)',
          cursor: 'pointer', textAlign: 'left',
        }}
      >
        <span style={{
          display: 'block', padding: '14px 16px 12px',
          borderBottom: '1px solid var(--border-subtle)',
          fontSize: 17, fontWeight: 600, lineHeight: 1.3,
          fontFamily: 'var(--font-display)',
        }}>
          {subject}
        </span>

        <span style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px 16px' }}>
          <MessageAvatar email={copy.fromEmail} name={copy.fromName || sender} size={40} hasContactPhoto={copy.hasContactPhoto} />
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <MessageDirection direction={direction} label={directionLabel} />
              <strong style={{ fontSize: 14, color: 'var(--text-primary)' }}>{sender}</strong>
              {copy.fromName && copy.fromEmail && !outgoing && <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>&lt;{copy.fromEmail}&gt;</span>}
            </span>
            <span style={{ display: 'block', fontSize: 12, color: 'var(--text-tertiary)', marginTop: 3 }}>
              <span>{t('message.to')} </span>
              <span style={{ color: 'var(--text-secondary)' }}>{recipient || accountLabel}</span>
            </span>
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
      </button>
    </div>

    {expanded && <div data-conversation-message-expanded-content="true" style={{ padding: '0 0 12px' }}>
      {copy.listUnsubscribe && !copy.unsubscribedAt && unsubscribeStatus !== 'done' && <div className="msg-notice" style={{
        marginBottom: 10, padding: '9px 14px',
        background: 'var(--bg-secondary)', border: '1px solid var(--border)',
        borderLeft: '3px solid var(--text-tertiary)', borderRadius: 8,
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        fontSize: 12, color: 'var(--text-secondary)',
      }}>
        <span style={{ flex: 1 }}>{t('message.unsubscribe.info')}</span>
        <button type="button" onClick={handleUnsubscribe} disabled={unsubscribeStatus === 'loading'} style={{
          background: 'none', border: '1px solid var(--border)', borderRadius: 5,
          padding: '3px 9px', cursor: unsubscribeStatus === 'loading' ? 'default' : 'pointer',
          color: unsubscribeStatus === 'error' ? 'var(--red, #e53e3e)' : 'var(--text-primary)',
          fontSize: 11, fontWeight: 500, opacity: unsubscribeStatus === 'loading' ? 0.5 : 1,
        }}>
          {unsubscribeStatus === 'loading' ? t('common.loading') : unsubscribeStatus === 'error' ? t('message.unsubscribe.error') : t('message.unsubscribe.button')}
        </button>
      </div>}

      {status?.loading && <div role="status" style={{ padding: 16, color: 'var(--text-tertiary)' }}>{t('conversation.loadingBody')}</div>}
      {status?.error && <div role="alert" style={{ padding: 16, color: 'var(--text-danger)' }}>{status.error}</div>}
      {status?.unavailable && <div role="status" style={{ padding: 16, color: 'var(--text-tertiary)' }}>{t('conversation.noBody')}</div>}
      {body && <div className="msg-card" style={{
        position: 'relative', padding: '14px 16px 12px',
        background: 'var(--bg-primary)', borderRadius: 10,
        border: '1px solid var(--border-subtle)', overflow: 'hidden', contain: 'layout',
      }}>
        <MessageBodyRenderer html={body.body_html} text={body.body_text} remoteImages={Boolean(body.remoteImages)} collapseQuotes />
        {body.hasBlockedRemoteImages && <button type="button" onClick={() => onRemoteImages(message.id)} style={{ ...actionStyle, marginTop: 10 }}>{t('conversation.loadImages')}</button>}
        <AttachmentList attachments={attachments} physicalCopyId={body.physical_copy_id || copy.id} />
      </div>}
    </div>}
  </article>;
}
