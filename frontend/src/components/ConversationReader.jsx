import { useEffect, useRef, useState, useCallback, useMemo, cloneElement } from 'react';
import { useTranslation } from 'react-i18next';
import { conversationApi } from '../utils/conversationApi.js';
import { ACTION_SCOPES, DESTRUCTIVE_SCOPES, SCOPE_I18N_KEYS } from '../hooks/useSelection.js';
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

// Format address objects/strings — NEVER [object Object]
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

function QuoteFold({ children }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [hasQuote, setHasQuote] = useState(false);
  const containerRef = useRef(null);

  return (
    <div ref={containerRef}>
      {!expanded && hasQuote && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          style={{
            display: 'block', width: '100%', padding: '4px 8px',
            border: '1px solid var(--border)', borderRadius: 4,
            background: 'var(--bg-tertiary)', color: 'var(--text-secondary)',
            cursor: 'pointer', fontSize: 12, marginBottom: 4,
          }}
        >
          [...] {t('conversation.expandConversation')} ▾
        </button>
      )}
      {cloneElement(children, {
        collapseQuotes: !expanded,
        onQuoteDetected: setHasQuote,
      })}
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

export default function ConversationReader({ conversationId, targetLogicalMessageId = null, onReply }) {
  const { t } = useTranslation();
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [expanded, setExpanded] = useState(new Set());
  const [bodies, setBodies] = useState({});
  const [bodyStatus, setBodyStatus] = useState({});
  const bodiesRef = useRef({});
  const tRef = useRef(t);
  tRef.current = t;
  const [showCopies, setShowCopies] = useState({});
  const [showHeaders, setShowHeaders] = useState({});
  const [remoteImagesEnabled, setRemoteImagesEnabled] = useState({});
  // P1-10: scope for destructive actions — explicit, never whole conversation
  const [actionScope, setActionScope] = useState('THIS_COPY');
  const [confirmModal, setConfirmModal] = useState(null);
  const [opsBusy, setOpsBusy] = useState(false);
  const [opsError, setOpsError] = useState(null);
  const inFlight = useRef(new Map());
  const requestGeneration = useRef(new Map());
  const logicalMessagesRef = useRef([]);
  const containerRef = useRef(null);

  const loadBody = useCallback(async (logicalId, force = false, remoteImages = false) => {
    if (!force && (bodiesRef.current[logicalId] || inFlight.current.has(logicalId))) return;
    const previous = inFlight.current.get(logicalId);
    previous?.abort();
    const controller = new AbortController();
    const generation = (requestGeneration.current.get(logicalId) || 0) + 1;
    requestGeneration.current.set(logicalId, generation);
    inFlight.current.set(logicalId, controller);
    setBodyStatus(prev => ({ ...prev, [logicalId]: { loading: true, error: null } }));
    try {
      const logical = logicalMessagesRef.current.find(message => message.id === logicalId);
      const selectedCopyId = logical?.selectedCopyId || null;
      const copyId = selectedCopyId || logical?.copies?.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || Number(Boolean(a.isRead)) - Number(Boolean(b.isRead)))[0]?.id || null;
      const body = await conversationApi.body(conversationId, logicalId, controller.signal, copyId, remoteImages);
      if (requestGeneration.current.get(logicalId) !== generation) return;
      bodiesRef.current[logicalId] = body;
      setBodies(prev => ({ ...prev, [logicalId]: body }));
      setBodyStatus(prev => ({ ...prev, [logicalId]: { loading: false, error: null } }));
    } catch (error) {
      if (error.name !== 'AbortError' && requestGeneration.current.get(logicalId) === generation) {
        setBodyStatus(prev => ({ ...prev, [logicalId]: { loading: false, error: error.message || tRef.current('conversation.loadBodyFailed') } }));
      }
    } finally {
      if (inFlight.current.get(logicalId) === controller) inFlight.current.delete(logicalId);
    }
  }, [conversationId]);

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, error: null, data: null });
    bodiesRef.current = {};
    setBodies({});
    setBodyStatus({});
    setExpanded(new Set());
    setShowHeaders({});
    setRemoteImagesEnabled({});
    conversationApi.detail(conversationId).then(data => {
      if (cancelled) return;
      const messages = data.logicalMessages || [];
      logicalMessagesRef.current = messages;
      const newestId = messages.at(-1)?.id;
      const unreadIds = messages
        .filter(m => m.copies?.some(c => !c.isRead))
        .map(m => m.id);
      const initialIds = new Set([newestId, ...unreadIds, targetLogicalMessageId].filter(Boolean));
      setExpanded(initialIds);
      setState({ loading: false, error: null, data });
      for (const msg of messages) {
        if (initialIds.has(msg.id)) loadBody(msg.id).catch(() => {});
      }
    }).catch(error => {
      if (!cancelled) setState({ loading: false, error: error.message || tRef.current('conversation.loadFailed'), data: null });
    });
    return () => { cancelled = true; };
  }, [conversationId, targetLogicalMessageId, loadBody]);

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

  const messages = useMemo(() => state.data?.logicalMessages || [], [state.data?.logicalMessages]);
  const actionTarget = messages.at(-1) || null;

  // P1-10: Run a destructive action with scope-aware confirmation
  const runScopedAction = useCallback(async (actionFn, scope, actionName = 'Delete') => {
    setOpsError(null);
    if (DESTRUCTIVE_SCOPES.has(scope)) {
      setConfirmModal({ action: actionName, onConfirm: async () => {
        setConfirmModal(null);
        setOpsBusy(true);
        try { await actionFn(); }
        catch (err) { setOpsError(err.message || t('conversation.loadFailed')); }
        finally { setOpsBusy(false); }
      } });
      return;
    }
    setOpsBusy(true);
    try { await actionFn(); }
    catch (err) { setOpsError(err.message || t('conversation.loadFailed')); }
    finally { setOpsBusy(false); }
  }, [t]);

  const handlePaneArchive = useCallback(() => {
    runScopedAction(() => conversationApi.archive(conversationId, { scope: actionScope, copyId: newestCopy(actionTarget)?.id || null, logicalMessageId: actionTarget?.id || null }), actionScope, 'Archive');
  }, [runScopedAction, conversationId, actionScope, actionTarget]);

  const handlePaneDelete = useCallback(() => {
    runScopedAction(() => conversationApi.delete(conversationId, { scope: actionScope, copyId: newestCopy(actionTarget)?.id || null, logicalMessageId: actionTarget?.id || null }), actionScope, 'Delete');
  }, [runScopedAction, conversationId, actionScope, actionTarget]);

  const handlePaneToggleRead = useCallback(() => {
    const isUnread = messages.some(m => m.copies?.some(c => !c.isRead));
    conversationApi.setRead(conversationId, !isUnread, { scope: actionScope, copyId: newestCopy(actionTarget)?.id || null, logicalMessageId: actionTarget?.id || null }).catch(err => {
      setOpsError(err.message || t('conversation.loadFailed'));
    });
  }, [conversationId, actionScope, messages, actionTarget, t]);

  const handlePaneToggleStar = useCallback(() => {
    const isStarred = messages.some(m => m.copies?.some(c => c.isStarred));
    conversationApi.setStarred(conversationId, !isStarred, { scope: actionScope, copyId: newestCopy(actionTarget)?.id || null, logicalMessageId: actionTarget?.id || null }).catch(err => {
      setOpsError(err.message || t('conversation.loadFailed'));
    });
  }, [conversationId, actionScope, messages, actionTarget, t]);

  const toggleExpand = useCallback((messageId) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  }, []);

  if (state.loading) {
    return <div role="status" style={{ padding: 24, textAlign: 'center', color: 'var(--text-tertiary)' }}>{t('conversation.loading')}</div>;
  }
  if (state.error) {
    return <div role="alert" style={{ padding: 16, color: 'var(--text-danger)' }}>{state.error}</div>;
  }

  const summary = state.data?.summary || {};
  const totalCopies = messages.reduce((sum, m) => sum + (m.copies?.length || 0), 0);

  return (
    <section
      ref={containerRef}
      aria-label={t('conversation.label')}
      data-conversation-id={conversationId}
      style={{ overflow: 'auto', height: '100%', width: '100%', minWidth: 0, maxWidth: 'none', padding: '0 12px' }}
    >
      {/* Conversation header */}
      <header style={{ padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>
          {summary.canonical_subject || t('conversation.noSubject')}
        </h2>
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 4 }}>
          {t('conversation.messageCount', { count: messages.length })}{' · '}
          {t('conversation.copyCount', { count: totalCopies })}
        </div>
        {/* P1-10: Scope selector for destructive actions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
            <span style={{ fontWeight: 600 }}>{t('conversation.scopeTitle')}</span>
            <select
              value={actionScope}
              onChange={e => setActionScope(e.target.value)}
              aria-label={t('conversation.scopeTitle')}
              style={{
                padding: '2px 6px', borderRadius: 4, border: '1px solid var(--border)',
                background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 12,
              }}
            >
              {ACTION_SCOPES.map(scope => (
                <option key={scope} value={scope}>{t(SCOPE_I18N_KEYS[scope])}</option>
              ))}
            </select>
          </label>
          {/* P1-12: quick action buttons in the pane header */}
          <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
            <button type="button" onClick={handlePaneToggleRead} style={paneBtnStyle} disabled={opsBusy}>
              {t('conversation.markRead')}
            </button>
            <button type="button" onClick={handlePaneToggleStar} style={paneBtnStyle} disabled={opsBusy}>
              {t('conversation.star')}
            </button>
            <button type="button" onClick={handlePaneArchive} style={paneBtnStyle} disabled={opsBusy}>
              {t('conversation.archive')}
            </button>
            <button type="button" onClick={handlePaneDelete} style={{ ...paneBtnStyle, color: 'var(--text-danger)' }} disabled={opsBusy}>
              {t('conversation.delete')}
            </button>
          </div>
        </div>
        {DESTRUCTIVE_SCOPES.has(actionScope) && (
          <div style={{ fontSize: 11, color: 'var(--text-danger)', marginTop: 4 }}>
            {t('conversation.scopeWarning')}
          </div>
        )}
      </header>

      {/* P1-10: confirmation modal for destructive scopes */}
      {confirmModal && (
        <div
          role="dialog"
          aria-label={t('conversation.confirm')}
          onClick={() => setConfirmModal(null)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
            zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div onClick={e => e.stopPropagation()} style={{
            background: 'var(--bg-primary)', borderRadius: 8, padding: 20,
            maxWidth: 400, width: '90%', boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
          }}>
            <h3 style={{ margin: 0, fontSize: 16, marginBottom: 8 }}>{t(`conversation.confirm${confirmModal.action || 'Delete'}Title`)}</h3>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 16px' }}>
              {t(`conversation.confirm${confirmModal.action || 'Delete'}Body`, { count: messages.length })}
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => setConfirmModal(null)} style={paneBtnStyle}>
                {t('conversation.cancel')}
              </button>
              <button type="button" onClick={confirmModal.onConfirm} disabled={opsBusy} style={{ ...paneBtnStyle, background: 'var(--text-danger)', color: 'var(--bg-primary)' }}>
                {opsBusy ? t('conversation.loading') : t('conversation.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Ops error toast */}
      {opsError && (
        <div role="alert" style={{
          padding: '8px 12px', background: 'var(--text-danger)', color: 'var(--bg-primary)',
          fontSize: 13, display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          borderRadius: 4, marginTop: 8,
        }}>
          <span>{opsError}</span>
          <button type="button" onClick={() => setOpsError(null)} aria-label={t('conversation.close')} style={{
            border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 16,
          }}>×</button>
        </div>
      )}

      {/* Message cards */}
      {messages.map(message => {
        const isOpen = expanded.has(message.id);
        const copy = newestCopy(message);
        const body = bodies[message.id];
        const bodyId = `logical-message-body-${message.id}`;
        const isOutgoing = message.direction === 'outgoing' || message.direction === 'self';
        const hasMultipleCopies = (message.copies?.length || 0) > 1;
        const copiesVisible = showCopies[message.id];
        const headersVisible = showHeaders[message.id];
        const imagesEnabled = remoteImagesEnabled[message.id];
        const attachments = (() => {
          const bodyAttachments = Array.isArray(body?.attachments) ? body.attachments : [];
          const copyAttachments = Array.isArray(copy?.attachments) ? copy.attachments : [];
          const atts = bodyAttachments.length ? bodyAttachments : copyAttachments;
          if (typeof atts === 'string') { try { return JSON.parse(atts); } catch { return []; } }
          return Array.isArray(atts) ? atts : [];
        })();

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
                toggleExpand(message.id);
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
                    }} aria-label={t('conversation.unread')} />
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
                    fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {copy?.snippet || message.subject || t('conversation.noSubject')}
                  </div>
                )}
              </div>
            </button>

            {/* Expanded message body */}
            {isOpen && (
              <div id={bodyId} role="region" aria-label={t('conversation.bodyLabel')} style={{ paddingLeft: 40, paddingRight: 8 }}>

                {/* Per-message action row — compact, above headers/body */}
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
                    <button
                      type="button"
                      onClick={() => setShowCopies(prev => ({ ...prev, [message.id]: !prev[message.id] }))}
                      style={{ ...paneBtnStyle, marginLeft: 'auto' }}
                    >
                      {t('conversation.copies')} ({message.copies.length})
                    </button>
                  )}
                </div>
                {/* Brief headers (always visible when expanded) */}
                <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 8, paddingBottom: 8, borderBottom: '1px solid var(--border)' }}>
                  <div><strong>{t('conversation.from')}:</strong> {formatAddress(copy?.from || { name: copy?.fromName, email: copy?.fromEmail })}</div>
                  <div><strong>{t('conversation.to')}:</strong> {formatAddressList(copy?.to)}</div>
                  {copy?.cc && <div><strong>{t('conversation.cc')}:</strong> {formatAddressList(copy?.cc)}</div>}
                  {copy?.bcc && <div><strong>{t('conversation.bcc')}:</strong> {formatAddressList(copy?.bcc)}</div>}
                  <div><strong>{t('conversation.date')}:</strong> {formatFullDate(message.messageDate)}</div>
                  {copy?.folder && <div><strong>{t('conversation.folder')}:</strong> {copy.folder}</div>}

                  {/* Full headers toggle */}
                  <button
                    type="button"
                    onClick={() => setShowHeaders(prev => ({ ...prev, [message.id]: !prev[message.id] }))}
                    style={{
                      border: 'none', background: 'transparent', cursor: 'pointer',
                      color: 'var(--accent)', fontSize: 11, padding: '4px 0', marginTop: 4,
                    }}
                  >
                    {headersVisible ? t('conversation.hideFullHeaders') : t('conversation.showFullHeaders')}
                  </button>
                  {headersVisible && body && (
                    <div style={{ marginTop: 4, padding: 8, background: 'var(--bg-secondary)', borderRadius: 4, fontSize: 11, fontFamily: 'var(--font-mono, monospace)', whiteSpace: 'pre-wrap', maxHeight: 300, overflow: 'auto' }}>
                      <div><strong>{t('conversation.physicalCopy')}:</strong> {body.physical_copy_id}</div>
                      <div><strong>{t('conversation.account')}:</strong> {body.account_id}</div>
                      <div><strong>{t('conversation.folder')}:</strong> {body.folder}</div>
                    </div>
                  )}
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
                {!body && !bodyStatus[message.id]?.loading && !bodyStatus[message.id]?.error && (
                  <button
                    type="button"
                    onClick={() => loadBody(message.id).catch(() => {})}
                    style={{
                      border: '1px solid var(--border)', borderRadius: 4, padding: '6px 12px',
                      background: 'var(--bg-tertiary)', cursor: 'pointer', fontSize: 13,
                      color: 'var(--text-secondary)',
                    }}
                  >
                    {t('conversation.loadBody')}
                  </button>
                )}

                {/* Remote images notice + toggle */}
                {body?.hasBlockedRemoteImages && !imagesEnabled && (
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8,
                    padding: '4px 8px', borderRadius: 4, background: 'var(--bg-tertiary)',
                    fontSize: 12, color: 'var(--text-tertiary)',
                  }}>
                    <span>{t('conversation.imagesBlocked')}</span>
                    <button
                      type="button"
                      onClick={() => {
                        setRemoteImagesEnabled(prev => ({ ...prev, [message.id]: true }));
                        delete bodiesRef.current[message.id];
                        setBodies(prev => { const next = { ...prev }; delete next[message.id]; return next; });
                        loadBody(message.id, true, true).catch(() => {});
                      }}
                      style={{
                        border: '1px solid var(--border)', borderRadius: 4, padding: '2px 8px',
                        background: 'transparent', cursor: 'pointer', fontSize: 12,
                        color: 'var(--accent)',
                      }}
                    >
                      {t('conversation.loadImages')}
                    </button>
                  </div>
                )}

                {body && (
                  <QuoteFold>
                    <MessageBodyRenderer
                      html={body.body_html}
                      text={body.body_text}
                      remoteImages={imagesEnabled || false}
                    />
                  </QuoteFold>
                )}

                {/* Attachments — DOWNLOADABLE */}
                {attachments.length > 0 && (
                  <div style={{ marginTop: 8, fontSize: 12 }}>
                    {attachments.map((att, i) => {
                      const filename = att.filename || att.name || att.part || 'attachment';
                      const part = att.part || att.partId || i;
                      const downloadUrl = body?.physical_copy_id
                        ? `/api/mail/messages/${encodeURIComponent(body.physical_copy_id)}/attachments/${encodeURIComponent(String(part))}`
                        : null;
                      const attachmentProps = {
                        key: i,
                        style: {
                          display: 'inline-flex', alignItems: 'center', gap: 4,
                          padding: '2px 8px', border: '1px solid var(--border)',
                          borderRadius: 4, marginRight: 4, marginBottom: 4,
                          textDecoration: 'none', color: 'var(--accent)',
                          cursor: downloadUrl ? 'pointer' : 'default',
                        },
                      };
                      const attachmentLabel = <>📎 {filename}{att.size && <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}> ({Math.round(att.size / 1024)}KB)</span>}</>;
                      return downloadUrl ? (
                        <a
                          {...attachmentProps}
                          href={downloadUrl}
                          download={filename}
                        >{attachmentLabel}</a>
                      ) : (
                        <span {...attachmentProps}>{attachmentLabel}</span>
                      );
                    })}
                  </div>
                )}

                {/* Copy details */}
                {copiesVisible && (
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
      })}
    </section>
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
