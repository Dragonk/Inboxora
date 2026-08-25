// ConversationMessage — a single logical message rendered inside the native
// MessagePane when mode="conversation". NOT a standalone pane; it is an inline
// subcomponent that shares MessagePane's root container, scroll, width and
// resize infrastructure. One per logical message in the conversation.
//
// Collapsed: compact header (avatar, sender, date, snippet, unread dot).
// Expanded: per-message actions (Reply/ReplyAll/Forward), headers, body
// (lazy-loaded via conversationApi.body), attachments, copies.
import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import MessageBodyRenderer from './MessageBodyRenderer.jsx';

function newestCopy(message) {
  return [...(message.copies || [])].sort((a, b) =>
    String(b.date || '').localeCompare(String(a.date || '')) ||
    Number(Boolean(a.isRead)) - Number(Boolean(b.isRead))
  )[0] || null;
}

function formatFullDate(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleString([], {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function formatAddress(addr) {
  if (!addr) return '';
  if (typeof addr === 'string') return addr;
  if (addr.name && addr.email) return `${addr.name} <${addr.email}>`;
  if (addr.email) return addr.email;
  if (addr.address) return addr.address;
  if (addr.name) return addr.name;
  return String(addr);
}

function formatAddressList(addrs) {
  if (!addrs) return '';
  if (typeof addrs === 'string') {
    try { addrs = JSON.parse(addrs); } catch { return addrs; }
  }
  if (!Array.isArray(addrs)) return formatAddress(addrs);
  return addrs.map(formatAddress).join(', ');
}

function CopyBadge({ copy }) {
  if (!copy) return null;
  return (
    <span style={{
      fontSize: 10, padding: '1px 5px', borderRadius: 3,
      background: 'var(--bg-tertiary)', color: 'var(--text-tertiary)', marginLeft: 6,
    }}>
      {copy.folder}
    </span>
  );
}

const paneBtnStyle = {
  border: '1px solid var(--border)',
  borderRadius: 4,
  padding: '4px 10px',
  background: 'var(--bg-primary)',
  color: 'var(--text-primary)',
  cursor: 'pointer',
  fontSize: 12,
};

export default function ConversationMessage({ message, onReply, bodyData, bodyStatus, onLoadBody, onRemoteImages }) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [showCopies, setShowCopies] = useState(false);
  const [showHeaders, setShowHeaders] = useState(false);
  const [imagesEnabled, setImagesEnabled] = useState(false);
  const body = bodyData?.[message.id];
  const status = bodyStatus?.[message.id];
  const copy = newestCopy(message);
  const isOutgoing = message.direction === 'outgoing' || message.direction === 'self';
  const hasMultipleCopies = (message.copies?.length || 0) > 1;
  const bodyId = `logical-message-body-${message.id}`;

  const handleToggle = useCallback(() => {
    const next = !isOpen;
    setIsOpen(next);
    if (next && !body && !status?.loading && !status?.error) {
      onLoadBody(message.id);
    }
  }, [isOpen, body, status, onLoadBody, message.id]);

  const attachments = (() => {
    const bodyAttachments = Array.isArray(body?.attachments) ? body.attachments : [];
    const copyAttachments = Array.isArray(copy?.attachments) ? copy.attachments : [];
    const atts = bodyAttachments.length ? bodyAttachments : copyAttachments;
    if (typeof atts === 'string') { try { return JSON.parse(atts); } catch { return []; } }
    return Array.isArray(atts) ? atts : [];
  })();

  return (
    <article
      id={`logical-message-${message.id}`}
      data-logical-message-id={message.id}
      style={{ borderBottom: '1px solid var(--border)', padding: '8px 0' }}
    >
      {/* Collapsed/expanded toggle */}
      <button
        type="button"
        aria-expanded={isOpen}
        aria-controls={bodyId}
        onClick={handleToggle}
        style={{
          display: 'flex', alignItems: 'flex-start', minHeight: 44, width: '100%',
          textAlign: 'left', border: 'none', background: 'transparent',
          cursor: 'pointer', padding: '4px 0', color: 'var(--text-primary)',
        }}
      >
        <span style={{
          width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 13, fontWeight: 600, marginRight: 8,
          background: isOutgoing ? 'var(--accent)' : 'var(--bg-tertiary)',
          color: isOutgoing ? 'var(--bg-primary)' : 'var(--text-secondary)',
        }}>
          {(copy?.fromName || copy?.fromEmail || '?')[0]?.toUpperCase()}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }} aria-hidden="true">{isOutgoing ? '→' : '←'}</span>
            <strong style={{ fontSize: 13, color: isOutgoing ? 'var(--accent)' : 'var(--text-primary)' }}>
              {isOutgoing ? t('conversation.you') : (copy?.fromName || copy?.fromEmail || t('conversation.unknownSender'))}
            </strong>
            {hasMultipleCopies && <CopyBadge copy={copy} />}
            {copy?.isRead === false && (
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--accent)', flexShrink: 0 }} aria-label={t('conversation.unread')} />
            )}
            <span style={{ flex: 1, fontSize: 12, color: 'var(--text-tertiary)', textAlign: 'right', flexShrink: 0 }}>
              {formatFullDate(message.messageDate)}
            </span>
          </div>
          {!isOpen && (
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {copy?.snippet || message.subject || t('conversation.noSubject')}
            </div>
          )}
        </div>
      </button>

      {/* Expanded message body */}
      {isOpen && (
        <div id={bodyId} role="region" aria-label={t('conversation.bodyLabel')} style={{ paddingLeft: 40, paddingRight: 8 }}>
          {/* Per-message action row */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 8, flexWrap: 'wrap' }}>
            <button type="button" onClick={() => onReply?.({ ...copy, copies: message.copies, logicalMessageId: message.id, selectedCopyId: copy?.id, attachments: copy?.attachments || body?.attachments || [] })} style={paneBtnStyle}>
              {t('conversation.reply')}
            </button>
            <button type="button" onClick={() => onReply?.({ ...copy, copies: message.copies, logicalMessageId: message.id, selectedCopyId: copy?.id, attachments: copy?.attachments || body?.attachments || [], replyAll: true })} style={paneBtnStyle}>
              {t('conversation.replyAll')}
            </button>
            <button type="button" onClick={() => onReply?.({ ...copy, copies: message.copies, logicalMessageId: message.id, selectedCopyId: copy?.id, attachments: copy?.attachments || body?.attachments || [], forward: true })} style={paneBtnStyle}>
              {t('conversation.forward')}
            </button>
            {hasMultipleCopies && (
              <button type="button" onClick={() => setShowCopies(prev => !prev)} style={{ ...paneBtnStyle, marginLeft: 'auto' }}>
                {t('conversation.copies')} ({message.copies.length})
              </button>
            )}
          </div>

          {/* Brief headers */}
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 8, paddingBottom: 8, borderBottom: '1px solid var(--border)' }}>
            <div><strong>{t('conversation.from')}:</strong> {formatAddress(copy?.from || { name: copy?.fromName, email: copy?.fromEmail })}</div>
            <div><strong>{t('conversation.to')}:</strong> {formatAddressList(copy?.to)}</div>
            {copy?.cc && <div><strong>{t('conversation.cc')}:</strong> {formatAddressList(copy?.cc)}</div>}
            <div><strong>{t('conversation.date')}:</strong> {formatFullDate(message.messageDate)}</div>
            {copy?.folder && <div><strong>{t('conversation.folder')}:</strong> {copy.folder}</div>}
            <button type="button" onClick={() => setShowHeaders(prev => !prev)} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--accent)', fontSize: 11, padding: '4px 0', marginTop: 4 }}>
              {showHeaders ? t('conversation.hideFullHeaders') : t('conversation.showFullHeaders')}
            </button>
          </div>

          {/* Body loading/error/content */}
          {status?.loading && <div role="status" style={{ padding: 12, color: 'var(--text-tertiary)' }}>{t('conversation.loadingBody')}</div>}
          {status?.error && (
            <div role="alert" style={{ padding: 12, color: 'var(--text-danger)' }}>
              {status.error}
              <button type="button" onClick={() => onLoadBody(message.id, true)} style={{ marginLeft: 8 }}>{t('conversation.retryLoading')}</button>
            </div>
          )}
          {!body && !status?.loading && !status?.error && (
            <button type="button" onClick={() => onLoadBody(message.id)} style={{ border: '1px solid var(--border)', borderRadius: 4, padding: '6px 12px', background: 'var(--bg-tertiary)', cursor: 'pointer', fontSize: 13, color: 'var(--text-secondary)' }}>
              {t('conversation.loadBody')}
            </button>
          )}

          {/* Remote images */}
          {body?.hasBlockedRemoteImages && !imagesEnabled && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, padding: '4px 8px', borderRadius: 4, background: 'var(--bg-tertiary)', fontSize: 12, color: 'var(--text-tertiary)' }}>
              <span>{t('conversation.imagesBlocked')}</span>
              <button type="button" onClick={() => { setImagesEnabled(true); onRemoteImages?.(message.id); }} style={{ border: '1px solid var(--border)', borderRadius: 4, padding: '2px 8px', background: 'transparent', cursor: 'pointer', fontSize: 12, color: 'var(--accent)' }}>
                {t('conversation.loadImages')}
              </button>
            </div>
          )}

          {body && (
            <MessageBodyRenderer
              html={body.body_html}
              text={body.body_text}
              remoteImages={imagesEnabled || false}
              collapseQuotes
              onQuoteDetected={() => {}}
            />
          )}

          {/* Attachments */}
          {attachments.length > 0 && (
            <div style={{ marginTop: 8, fontSize: 12 }}>
              {attachments.map((att, i) => {
                const filename = att.filename || att.name || att.part || 'attachment';
                const part = att.part || att.partId || i;
                const downloadUrl = body?.physical_copy_id
                  ? `/api/mail/messages/${encodeURIComponent(body.physical_copy_id)}/attachments/${encodeURIComponent(String(part))}`
                  : null;
                return downloadUrl ? (
                  <a key={i} href={downloadUrl} download={filename} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', border: '1px solid var(--border)', borderRadius: 4, marginRight: 4, marginBottom: 4, textDecoration: 'none', color: 'var(--accent)', cursor: 'pointer' }}>
                    📎 {filename}{att.size && <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}> ({Math.round(att.size / 1024)}KB)</span>}
                  </a>
                ) : (
                  <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', border: '1px solid var(--border)', borderRadius: 4, marginRight: 4, marginBottom: 4 }}>
                    📎 {filename}
                  </span>
                );
              })}
            </div>
          )}

          {/* Copy details */}
          {showCopies && (
            <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-tertiary)' }}>
              {message.copies.map((c, i) => (
                <div key={i} style={{ padding: '2px 0' }}>
                  <CopyBadge copy={c} /> {c.accountId?.slice(0, 8)} — {c.folder}
                  {c.isRead === false && <span style={{ marginLeft: 4, color: 'var(--accent)' }}>●</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </article>
  );
}
