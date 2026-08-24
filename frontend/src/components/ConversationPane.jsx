import { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { conversationApi } from '../utils/conversationApi.js';
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

function QuoteFold({ children }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [hasQuote, setHasQuote] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    // Detect quoted content: blockquote, .gmail_quote, .moz-quote-container, .yahoo_quoted,
    // and common text patterns ("On ... wrote:", "Dnia ... napisał:", "-----Original Message-----")
    const quotes = el.querySelectorAll('blockquote, .gmail_quote, .moz-quote-container, .yahoo_quoted');
    const hasBlockquote = quotes.length > 0;
    // Also check for plain-text quote markers in text content
    const textContent = el.textContent || '';
    const hasTextQuote = /^\s*(On .+ wrote:|Dnia .+ napisał|-----Original Message-----|-----Wiadomość oryginalna-----)/m.test(textContent);
    setHasQuote(hasBlockquote || hasTextQuote);
    // Hide only the quote elements, NOT the entire message content
    if (hasBlockquote && !expanded) {
      for (const q of quotes) q.style.display = 'none';
    }
  }, [children, expanded]);

  if (!hasQuote) {
    return <div ref={containerRef}>{children}</div>;
  }

  return (
    <div ref={containerRef}>
      {!expanded && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          style={{
            display: 'block',
            width: '100%',
            padding: '4px 8px',
            border: '1px solid var(--border)',
            borderRadius: 4,
            background: 'var(--bg-tertiary)',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            fontSize: 12,
            marginBottom: 4,
          }}
        >
          [...] {t('conversation.expandConversation')} ▾
        </button>
      )}
      {/* Show the full message content always; only quote elements are toggled */}
      {children}
    </div>
  );
}

function CopyBadge({ copy }) {
  if (!copy) return null;
  return (
    <span
      style={{
        fontSize: 10,
        padding: '1px 5px',
        borderRadius: 3,
        background: 'var(--bg-tertiary)',
        color: 'var(--text-tertiary)',
        marginLeft: 6,
      }}
    >
      {copy.folder}
    </span>
  );
}

export default function ConversationPane({ conversationId, targetLogicalMessageId = null, onReply }) {
  const { t } = useTranslation();
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [expanded, setExpanded] = useState(new Set());
  const [bodies, setBodies] = useState({});
  const [bodyStatus, setBodyStatus] = useState({});
  const [showCopies, setShowCopies] = useState({}); // per logicalMessageId
  const inFlight = useRef(new Map());
  const containerRef = useRef(null);

  const loadBody = useCallback(async (logicalId, force = false) => {
    if (!force && (bodies[logicalId] || inFlight.current.has(logicalId))) return;
    const controller = new AbortController();
    inFlight.current.set(logicalId, controller);
    setBodyStatus(prev => ({ ...prev, [logicalId]: { loading: true, error: null } }));
    try {
      const body = await conversationApi.body(conversationId, logicalId, controller.signal);
      setBodies(prev => ({ ...prev, [logicalId]: body }));
      setBodyStatus(prev => ({ ...prev, [logicalId]: { loading: false, error: null } }));
    } catch (error) {
      if (error.name !== 'AbortError') {
        setBodyStatus(prev => ({ ...prev, [logicalId]: { loading: false, error: error.message || t('conversation.loadBodyFailed') } }));
      }
    } finally {
      inFlight.current.delete(logicalId);
    }
  }, [conversationId, bodies, t]);

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, error: null, data: null });
    setBodies({});
    setBodyStatus({});
    conversationApi.detail(conversationId).then(data => {
      if (cancelled) return;
      const messages = data.logicalMessages || [];
      // Auto-expand: newest, unread, deep-linked target
      const newestId = messages.at(-1)?.id;
      const unreadIds = messages
        .filter(m => m.copies?.some(c => !c.isRead))
        .map(m => m.id);
      const initialIds = new Set([newestId, ...unreadIds, targetLogicalMessageId].filter(Boolean));
      setExpanded(initialIds);
      setState({ loading: false, error: null, data });
      // Auto-load body for expanded messages
      for (const msg of messages) {
        if (initialIds.has(msg.id)) loadBody(msg.id).catch(() => {});
      }
    }).catch(error => {
      if (!cancelled) setState({ loading: false, error: error.message || t('conversation.loadFailed'), data: null });
    });
    return () => { cancelled = true; };
  }, [conversationId, targetLogicalMessageId, t, loadBody]);

  // Abort all in-flight requests when conversation changes
  useEffect(() => () => {
    for (const controller of inFlight.current.values()) controller.abort();
    inFlight.current.clear();
  }, [conversationId]);

  // Scroll to target logical message on deep link
  useEffect(() => {
    if (targetLogicalMessageId && state.data && !state.loading) {
      const el = document.getElementById(`logical-message-${targetLogicalMessageId}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [targetLogicalMessageId, state.data, state.loading]);

  if (state.loading) {
    return <div role="status" style={{ padding: 24, textAlign: 'center', color: 'var(--text-tertiary)' }}>{t('conversation.loading')}</div>;
  }
  if (state.error) {
    return <div role="alert" style={{ padding: 16, color: 'var(--text-danger)' }}>{state.error}</div>;
  }

  const messages = state.data?.logicalMessages || [];
  const summary = state.data?.summary || {};

  return (
    <section
      ref={containerRef}
      aria-label={t('conversation.label')}
      data-conversation-id={conversationId}
      style={{ overflow: 'auto', height: '100%', padding: '0 12px' }}
    >
      {/* Conversation header */}
      <header style={{ padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>
          {summary.canonical_subject || t('conversation.noSubject')}
        </h2>
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 4 }}>
          {t('conversation.messageCount', { count: messages.length })}{' · '}
          {t('conversation.copyCount', { count: messages.reduce((sum, m) => sum + (m.copies?.length || 0), 0) })}
        </div>
      </header>

      {/* Message cards */}
      {messages.map(message => {
        const isOpen = expanded.has(message.id);
        const copy = newestCopy(message);
        const body = bodies[message.id];
        const bodyId = `logical-message-body-${message.id}`;
        const isOutgoing = message.direction === 'outgoing' || message.direction === 'self';
        const hasMultipleCopies = (message.copies?.length || 0) > 1;
        const copiesVisible = showCopies[message.id];

        return (
          <article
            key={message.id}
            id={`logical-message-${message.id}`}
            data-logical-message-id={message.id}
            style={{
              borderBottom: '1px solid var(--border)',
              padding: '8px 0',
            }}
          >
            {/* Collapsed/expanded toggle */}
            <button
              type="button"
              aria-expanded={isOpen}
              aria-controls={bodyId}
              onClick={() => {
                setExpanded(prev => {
                  const next = new Set(prev);
                  if (next.has(message.id)) next.delete(message.id);
                  else next.add(message.id);
                  return next;
                });
                if (!body && !isOpen) loadBody(message.id).catch(() => {});
              }}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                minHeight: 44,
                width: '100%',
                textAlign: 'left',
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                padding: '4px 0',
                color: 'var(--text-primary)',
              }}
            >
              <span style={{
                width: 32,
                height: 32,
                borderRadius: '50%',
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 13,
                fontWeight: 600,
                marginRight: 8,
                background: isOutgoing ? 'var(--accent)' : 'var(--bg-tertiary)',
                color: isOutgoing ? 'var(--bg-primary)' : 'var(--text-secondary)',
              }}>
                {(copy?.fromName || copy?.fromEmail || '?')[0]?.toUpperCase()}
              </span>

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <strong style={{
                    fontSize: 13,
                    color: isOutgoing ? 'var(--accent)' : 'var(--text-primary)',
                  }}>
                    {isOutgoing ? t('conversation.you') : (copy?.fromName || copy?.fromEmail || t('conversation.unknownSender'))}
                  </strong>
                  {hasMultipleCopies && <CopyBadge copy={copy} />}
                  {copy?.isRead === false && (
                    <span style={{
                      width: 8, height: 8, borderRadius: '50%',
                      background: 'var(--accent)', flexShrink: 0,
                    }} aria-label="unread" />
                  )}
                  <span style={{
                    flex: 1, fontSize: 12, color: 'var(--text-tertiary)',
                    textAlign: 'right', flexShrink: 0,
                  }}>
                    {formatFullDate(message.messageDate)}
                  </span>
                </div>
                {!isOpen && (
                  <div style={{
                    fontSize: 12,
                    color: 'var(--text-tertiary)',
                    marginTop: 2,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {copy?.snippet || message.subject || t('conversation.noSubject')}
                  </div>
                )}
              </div>
            </button>

            {/* Expanded message body */}
            {isOpen && (
              <div id={bodyId} role="region" aria-label={t('conversation.bodyLabel')} style={{ paddingLeft: 40, paddingRight: 8 }}>
                {/* Full headers when expanded */}
                <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 8, paddingBottom: 8, borderBottom: '1px solid var(--border)' }}>
                  {copy?.to && <div><strong>To:</strong> {Array.isArray(copy.to) ? copy.to.join(', ') : copy.to}</div>}
                  {copy?.cc?.length > 0 && <div><strong>Cc:</strong> {Array.isArray(copy.cc) ? copy.cc.join(', ') : copy.cc}</div>}
                  {copy?.fromEmail && <div><strong>From:</strong> {copy.fromName ? `${copy.fromName} <${copy.fromEmail}>` : copy.fromEmail}</div>}
                </div>

                {/* Body loading/error/content */}
                {bodyStatus[message.id]?.loading && (
                  <div role="status" style={{ padding: 12, color: 'var(--text-tertiary)' }}>
                    {t('conversation.loadingBody')}
                  </div>
                )}
                {bodyStatus[message.id]?.error && (
                  <div role="alert" style={{ padding: 12, color: 'var(--text-danger)' }}>
                    {bodyStatus[message.id].error}
                    <button type="button" onClick={() => loadBody(message.id, true)} style={{ marginLeft: 8 }}>
                      {t('conversation.retryLoading')}
                    </button>
                  </div>
                )}
                {body && (
                  <QuoteFold>
                    <MessageBodyRenderer html={body.body_html} text={body.body_text} copyId={body.physical_copy_id} accountId={body.account_id} />
                  </QuoteFold>
                )}

                {/* Attachments */}
                {copy?.attachments?.length > 0 && (
                  <div style={{ marginTop: 8, fontSize: 12 }}>
                    {copy.attachments.map((att, i) => (
                      <span key={i} style={{
                        display: 'inline-block',
                        padding: '2px 8px',
                        border: '1px solid var(--border)',
                        borderRadius: 4,
                        marginRight: 4,
                        marginBottom: 4,
                      }}>
                        📎 {att.filename || att.name || 'attachment'}
                      </span>
                    ))}
                  </div>
                )}

                {/* Action buttons */}
                <div style={{ display: 'flex', gap: 8, marginTop: 8, paddingBottom: 4 }}>
                  <button type="button" onClick={() => onReply?.({ ...copy, copies: message.copies, logicalMessageId: message.id })}>
                    {t('conversation.reply')}
                  </button>
                  <button type="button" onClick={() => onReply?.({ ...copy, copies: message.copies, logicalMessageId: message.id, replyAll: true })}>
                    {t('conversation.replyAll')}
                  </button>
                  <button type="button" onClick={() => onReply?.({ ...copy, copies: message.copies, logicalMessageId: message.id, forward: true })}>
                    {t('conversation.forward')}
                  </button>
                  {hasMultipleCopies && (
                    <button
                      type="button"
                      onClick={() => setShowCopies(prev => ({ ...prev, [message.id]: !prev[message.id] }))}
                      style={{ marginLeft: 'auto' }}
                    >
                      {t('conversation.copies')} ({message.copies.length})
                    </button>
                  )}
                </div>

                {/* Copy details */}
                {copiesVisible && (
                  <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-tertiary)' }}>
                    {message.copies.map((c, i) => (
                      <div key={i} style={{ padding: '2px 0' }}>
                        <CopyBadge copy={c} /> {c.accountId?.slice(0, 8)} — {c.folder}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </article>
        );
      })}
    </section>
  );
}
