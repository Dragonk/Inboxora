// Native-pane conversation item.  This deliberately shares the same visual tokens,
// body renderer and attachment affordances as MessagePane; the reader only supplies
// logical-message data and expansion state.
import { useTranslation } from 'react-i18next';
import MessageBodyRenderer from './MessageBodyRenderer.jsx';
import { senderColor } from '../themes.js';
import SenderAvatarImage from './SenderAvatarImage.jsx';

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
  const outgoing = message.direction === 'outgoing' || message.direction === 'self';
  const attachments = Array.isArray(body?.attachments) ? body.attachments : (Array.isArray(copy.attachments) ? copy.attachments : []);
  const sender = outgoing ? t('conversation.you') : (copy.fromName || copy.fromEmail || t('conversation.unknownSender'));
  const toggle = () => { onToggle(message.id); if (!expanded && !body && !status?.loading) onLoadBody(message.id); };
  const reply = (replyAll = false, forward = false) => onReply?.({ ...copy, logicalMessageId: message.id, selectedCopyId: copy.id, replyAll, forward, attachments });
  // A stack item intentionally has no independent card system. It shares the pane's
  // avatar, header/body tokens and renderer, with only a hairline separating messages.
  return (
    <article id={`logical-message-${message.id}`} data-logical-message-id={message.id} style={{
      borderBottom: '1px solid var(--border-subtle)', background: expanded ? 'var(--bg-primary)' : 'transparent',
    }}>
      <button type="button" aria-expanded={expanded} onClick={toggle} style={{ display: 'flex', width: '100%', padding: expanded ? '16px 28px 12px' : '10px 28px', border: 0, background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer', textAlign: 'left', gap: 10 }}>
        <span style={{ width: expanded ? 34 : 28, height: expanded ? 34 : 28, borderRadius: '50%', flexShrink: 0, background: senderColor(copy.fromEmail || sender), color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: expanded ? 14 : 12, fontWeight: 700, overflow: 'hidden', position: 'relative' }}>
          {sender[0]?.toUpperCase()}<SenderAvatarImage email={copy.fromEmail} />
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
            <strong style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><span aria-hidden="true" style={{ color: 'var(--text-tertiary)', marginRight: 5 }}>{outgoing ? '→' : '←'}</span>{sender}</strong>
            <time style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 400, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>{date(message.messageDate || copy.date)}</time>
          </span>
          {expanded ? <><span style={{ display: 'block', fontSize: 12, color: 'var(--text-tertiary)', marginTop: 3 }}>{t('message.to')} {address(copy.to)}</span><span style={{ display: 'block', marginTop: 7, fontSize: 17, fontWeight: 600, lineHeight: 1.3 }}>{message.subject || copy.subject || t('message.noSubject')}</span></> : <span style={{ display: 'block', marginTop: 2, fontSize: 12, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{message.subject || copy.subject || copy.snippet || t('message.noSubject')}</span>}
        </span>
      </button>
      {expanded && <div style={{ padding: '0 28px 22px 72px' }}>
        <div data-conversation-message-actions="true" style={{ padding: '0 0 10px', display: 'flex', gap: 6 }}>
          <button type="button" onClick={e => { e.stopPropagation(); reply(); }} style={actionStyle}>{t('message.reply')}</button>
          <button type="button" onClick={e => { e.stopPropagation(); reply(true); }} style={actionStyle}>{t('message.replyAll')}</button>
          <button type="button" onClick={e => { e.stopPropagation(); reply(false, true); }} style={actionStyle}>{t('message.forward')}</button>
        </div>
        {status?.loading && <div role="status" style={{ padding: 16, color: 'var(--text-tertiary)' }}>{t('conversation.loadingBody')}</div>}
        {status?.error && <div role="alert" style={{ padding: 16, color: 'var(--text-danger)' }}>{status.error}</div>}
        {body && <MessageBodyRenderer html={body.body_html} text={body.body_text} remoteImages={Boolean(body.remoteImages)} collapseQuotes />}
        {body?.hasBlockedRemoteImages && <button type="button" onClick={() => onRemoteImages(message.id)} style={{ ...actionStyle, marginTop: 10 }}>{t('conversation.loadImages')}</button>}
        {attachments.length > 0 && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 14 }}>{attachments.map((attachment, index) => <a key={attachment.part || index} href={body?.physical_copy_id ? `/api/mail/messages/${encodeURIComponent(body.physical_copy_id)}/attachments/${encodeURIComponent(String(attachment.part || index))}` : undefined} download={attachment.filename} style={{ ...actionStyle, textDecoration: 'none' }}>📎 {attachment.filename || attachment.name || 'attachment'}</a>)}</div>}
      </div>}
    </article>
  );
}
const actionStyle = { border: '1px solid var(--border)', borderRadius: 6, padding: '5px 9px', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12 };
