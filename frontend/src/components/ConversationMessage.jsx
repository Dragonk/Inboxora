import { useTranslation } from 'react-i18next';
import MessageBodyRenderer from './MessageBodyRenderer.jsx';
import { MessageActionBar, MessageAvatar, MessageDirection, actionStyle, messageDirection } from './MessagePresentation.jsx';

function preferredCopy(message) {
  return [...(message.copies || [])].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))[0] || {};
}
function address(value) {
  if (!value) return '';
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return value; } }
  const values = Array.isArray(value) ? value : [value];
  return values.map(item => typeof item === 'string' ? item : (item.name ? `${item.name} <${item.email}>` : item.email)).filter(Boolean).join(', ');
}
function date(value) { return value ? new Date(value).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''; }

export default function ConversationMessage({ message, expanded, onToggle, body, status, onLoadBody, onRemoteImages, onReply }) {
  const { t } = useTranslation();
  const copy = preferredCopy(message);
  const direction = messageDirection(message.direction);
  const outgoing = direction === 'outgoing';
  const attachments = Array.isArray(body?.attachments) ? body.attachments : (Array.isArray(copy.attachments) ? copy.attachments : []);
  const sender = outgoing ? t('conversation.you') : (copy.fromName || copy.fromEmail || t('conversation.unknownSender'));
  const toggle = () => { onToggle(message.id); if (!expanded && !body && !status?.loading) onLoadBody(message.id); };
  const reply = (replyAll = false, forward = false) => onReply?.({ ...copy, logicalMessageId: message.id, selectedCopyId: copy.id, replyAll, forward, attachments });
  const subject = message.subject || copy.subject || copy.snippet || t('message.noSubject');

  return <article id={`logical-message-${message.id}`} data-logical-message-id={message.id} data-conversation-message-state={expanded ? 'expanded' : 'collapsed'} style={{ borderBottom: '1px solid var(--border-subtle)', background: expanded ? 'var(--bg-primary)' : 'transparent' }}>
    {!expanded ? <button type="button" aria-expanded="false" onClick={toggle} style={{ display: 'flex', alignItems: 'center', width: '100%', minHeight: 52, padding: '8px 16px', border: 0, background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer', textAlign: 'left', gap: 10 }}>
      <MessageAvatar email={copy.fromEmail} name={sender} size={30} />
      <MessageDirection direction={direction} label={outgoing ? t('conversation.you') : t('conversation.unknownSender')} />
      <strong style={{ fontSize: 13, maxWidth: '28%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sender}</strong>
      <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{subject}</span>
      {attachments.length > 0 && <span aria-label={t('message.attachment', { count: attachments.length })}>📎</span>}
      <time style={{ fontSize: 11, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>{date(message.messageDate || copy.date)}</time>
    </button> : <>
      <div style={{ padding: '8px 20px 0' }}>
        <MessageActionBar targetId={message.id} onReply={e => { e.stopPropagation(); reply(); }} onReplyAll={e => { e.stopPropagation(); reply(true); }} onForward={e => { e.stopPropagation(); reply(false, true); }} />
      </div>
      <button type="button" aria-expanded="true" onClick={toggle} style={{ display: 'flex', width: '100%', padding: '2px 20px 12px', border: 0, background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer', textAlign: 'left', gap: 12 }}>
        <MessageAvatar email={copy.fromEmail} name={sender} size={40} />
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: 17, fontWeight: 600, lineHeight: 1.3, marginBottom: 8 }}>{subject}</span>
          <span style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}><MessageDirection direction={direction} label={outgoing ? t('conversation.you') : t('conversation.unknownSender')} /><strong style={{ fontSize: 14 }}>{sender}</strong>{copy.fromName && copy.fromEmail && <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>&lt;{copy.fromEmail}&gt;</span>}<time style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>{date(message.messageDate || copy.date)}</time></span>
          <span style={{ display: 'block', fontSize: 12, color: 'var(--text-tertiary)', marginTop: 3 }}>{t('message.to')} {address(copy.to)}</span>
        </span>
      </button>
      <div style={{ padding: '4px 20px 22px 72px' }}>
        {status?.loading && <div role="status" style={{ padding: 16, color: 'var(--text-tertiary)' }}>{t('conversation.loadingBody')}</div>}
        {status?.error && <div role="alert" style={{ padding: 16, color: 'var(--text-danger)' }}>{status.error}</div>}
        {body && <MessageBodyRenderer html={body.body_html} text={body.body_text} remoteImages={Boolean(body.remoteImages)} collapseQuotes />}
        {body?.hasBlockedRemoteImages && <button type="button" onClick={() => onRemoteImages(message.id)} style={{ ...actionStyle, marginTop: 10 }}>{t('conversation.loadImages')}</button>}
        {attachments.length > 0 && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 14 }}>{attachments.map((attachment, index) => <a key={attachment.part || index} href={body?.physical_copy_id ? `/api/mail/messages/${encodeURIComponent(body.physical_copy_id)}/attachments/${encodeURIComponent(String(attachment.part || index))}` : undefined} download={attachment.filename} style={{ ...actionStyle, border: '1px solid var(--border)', textDecoration: 'none' }}>📎 {attachment.filename || attachment.name || 'attachment'}</a>)}</div>}
      </div>
    </>}
  </article>;
}
