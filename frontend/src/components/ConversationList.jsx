import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { conversationApi } from '../utils/conversationApi.js';

function OwnReplyMarker({ visible }) {
  const { t } = useTranslation();
  if (!visible) return null;
  return (
    <span
      role="img"
      aria-label={t('conversation.latestOwnReply')}
      title={t('conversation.latestOwnReply')}
      style={{ marginLeft: 4, color: 'var(--accent)' }}
    >
      ↩
    </span>
  );
}

function AttachmentIcon({ visible }) {
  if (!visible) return null;
  return <span aria-label="📎" title="📎" style={{ marginLeft: 4 }}>📎</span>;
}

function UnreadBadge({ count }) {
  if (!count) return null;
  return (
    <span
      style={{
        marginLeft: 6,
        fontSize: 11,
        fontWeight: 700,
        padding: '1px 7px',
        borderRadius: 10,
        background: 'var(--accent)',
        color: 'var(--bg-primary)',
        minWidth: 18,
        textAlign: 'center',
        display: 'inline-block',
      }}
    >
      {count}
    </span>
  );
}

function AccountBadge({ accounts = [] }) {
  const { t } = useTranslation();
  if (!accounts.length || accounts.length <= 1) return null;
  return (
    <span
      aria-label={t('conversation.accounts')}
      title={accounts.join(', ')}
      style={{
        marginLeft: 6,
        fontSize: 10,
        fontWeight: 600,
        padding: '1px 5px',
        borderRadius: 4,
        background: 'var(--bg-tertiary)',
        color: 'var(--text-secondary)',
      }}
    >
      {accounts.length}
    </span>
  );
}

function MenuItem({ onClick, children }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '6px 12px',
        border: 'none',
        background: 'transparent',
        cursor: 'pointer',
        fontSize: 13,
        color: 'var(--text-primary)',
      }}
    >
      {children}
    </button>
  );
}

function formatListDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now - d;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } else if (diffDays < 7) {
    return d.toLocaleDateString([], { weekday: 'short' });
  } else if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

function getParticipants(row) {
  const messages = row.logical_messages || [];
  if (!messages.length) return '';
  const names = new Set();
  for (const msg of messages) {
    const isOutgoing = msg.direction === 'outgoing' || msg.direction === 'self';
    const name = isOutgoing
      ? null
      : (msg.fromName || msg.fromEmail);
    if (name) names.add(name);
  }
  return Array.from(names).slice(0, 3).join(', ');
}

export default function ConversationList({ params = {}, onOpenMessage }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState([]);
  const [expanded, setExpanded] = useState(null);
  const [nextCursor, setNextCursor] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [menuOpen, setMenuOpen] = useState(null);
  const [modal, setModal] = useState(null);
  const [opsError, setOpsError] = useState(null);
  const [opsBusy, setOpsBusy] = useState(false);

  const paramsKey = JSON.stringify(params);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setExpanded(null);
    setLoading(true);
    conversationApi.list(params).then(data => {
      if (!cancelled) {
        setRows(data.conversations || []);
        setNextCursor(data.nextCursor || null);
      }
    }).catch(err => {
      if (!cancelled) setError(err.message || t('conversation.loadFailed'));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [paramsKey, t]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await conversationApi.list({ ...params, cursor: nextCursor });
      setRows(prev => [...prev, ...(data.conversations || [])]);
      setNextCursor(data.nextCursor || null);
    } catch (err) {
      setError(err.message || t('conversation.loadFailed'));
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, params, t]);

  const toggleExpand = useCallback((conversationId) => {
    setExpanded(prev => (prev === conversationId ? null : conversationId));
  }, []);

  const closeModal = useCallback(() => {
    setModal(null);
    setOpsError(null);
  }, []);

  const runOp = useCallback(async (fn, successModal) => {
    setOpsBusy(true);
    setOpsError(null);
    try {
      const result = await fn();
      if (successModal) {
        setModal({ type: 'info', title: successModal, body: JSON.stringify(result, null, 2) });
      }
      // Refresh list after successful mutation
      const data = await conversationApi.list(params);
      setRows(data.conversations || []);
      setNextCursor(data.nextCursor || null);
    } catch (err) {
      setOpsError(err.message || t('conversation.loadFailed'));
    } finally {
      setOpsBusy(false);
    }
  }, [params, t]);

  const handleDiagnostics = useCallback((row) => {
    setMenuOpen(null);
    runOp(
      () => conversationApi.diagnostics(row.conversation_id),
      t('conversation.diagnosticsTitle'),
    );
  }, [runOp, t]);

  const handleMerge = useCallback((row) => {
    setMenuOpen(null);
    const targetId = window.prompt(t('conversation.mergeTargetPrompt'));
    if (!targetId) return;
    runOp(() => conversationApi.merge(row.conversation_id, targetId.trim()));
  }, [runOp, t]);

  const handleSplit = useCallback((row, includeReplies) => {
    setMenuOpen(null);
    const lmId = (row.logical_messages || [])[0]?.id;
    if (!lmId) return;
    runOp(() => conversationApi.split(row.conversation_id, lmId, { includeReplies }));
  }, [runOp]);

  const handleMove = useCallback((row) => {
    setMenuOpen(null);
    const lmId = (row.logical_messages || [])[0]?.id;
    if (!lmId) return;
    const targetId = window.prompt(t('conversation.moveToConversationPrompt'));
    if (!targetId) return;
    runOp(() => conversationApi.moveLogicalMessage(row.conversation_id, lmId, targetId.trim()));
  }, [runOp, t]);

  const handleLock = useCallback((row) => {
    setMenuOpen(null);
    runOp(() => conversationApi.lock(row.conversation_id));
  }, [runOp]);

  const handleUnlock = useCallback((row) => {
    setMenuOpen(null);
    runOp(() => conversationApi.unlock(row.conversation_id));
  }, [runOp]);

  const handleForceInclude = useCallback((row) => {
    setMenuOpen(null);
    const lmId = (row.logical_messages || [])[0]?.id;
    if (!lmId) return;
    runOp(() => conversationApi.forceInclude(row.conversation_id, lmId));
  }, [runOp]);

  const handleForceExclude = useCallback((row) => {
    setMenuOpen(null);
    const lmId = (row.logical_messages || [])[0]?.id;
    if (!lmId) return;
    runOp(() => conversationApi.forceExclude(row.conversation_id, lmId));
  }, [runOp]);

  if (error) {
    return <div role="alert" style={{ padding: 16, color: 'var(--text-danger)' }}>{error}</div>;
  }

  if (!rows.length) {
    return (
      <div role="status" style={{ padding: 24, textAlign: 'center', color: 'var(--text-tertiary)' }}>
        {loading
          ? t('conversation.loading')
          : (
            <>
              <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>
                {t('conversation.noConversations')}
              </div>
              <div style={{ fontSize: 13 }}>
                {t('conversation.noConversationsDesc')}
              </div>
            </>
          )}
      </div>
    );
  }

  return (
    <div role="list" aria-label={t('conversation.listLabel')} style={{ overflow: 'auto', height: '100%' }}>
      {rows.map(row => {
        const isOpen = expanded === row.conversation_id;
        const unreadCount = row.unread_count || 0;
        const participants = getParticipants(row);
        const hasAttachments = row.has_attachments || false;
        const latestDate = row.sort_date || row.last_message_at;
        const accounts = (row.logical_messages || [])
          .map(m => m.accountId).filter((v, i, a) => v && a.indexOf(v) === i);

        return (
          <div
            key={row.conversation_id}
            role="listitem"
            style={{
              borderBottom: '1px solid var(--border)',
              background: isOpen ? 'var(--bg-secondary)' : 'transparent',
            }}
          >
            {/* Collapsed conversation row */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                minHeight: 48,
                padding: '0 8px',
                cursor: 'pointer',
                fontWeight: unreadCount > 0 ? 600 : 400,
              }}
              onClick={() => toggleExpand(row.conversation_id)}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  toggleExpand(row.conversation_id);
                }
              }}
              tabIndex={0}
              role="button"
              aria-expanded={isOpen}
              aria-label={`${isOpen ? t('conversation.collapseConversation') : t('conversation.expandConversation')}: ${row.canonical_subject || t('conversation.noSubject')}`}
            >
              <span
                style={{
                  width: 24,
                  textAlign: 'center',
                  flexShrink: 0,
                  fontSize: 12,
                  color: 'var(--text-tertiary)',
                }}
              >
                {isOpen ? '▾' : '▸'}
              </span>

              <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 14,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}>
                  <span style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    flex: 1,
                  }}>
                    {row.canonical_subject || t('conversation.noSubject')}
                  </span>
                  <AttachmentIcon visible={hasAttachments} />
                  <OwnReplyMarker visible={row.latest_message_is_mine} />
                </div>
                {participants && (
                  <div style={{
                    fontSize: 12,
                    color: 'var(--text-tertiary)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    marginTop: 1,
                  }}>
                    {participants}
                  </div>
                )}
              </div>

              <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', marginLeft: 8 }}>
                <AccountBadge accounts={accounts} />
                <UnreadBadge count={unreadCount} />
                <span style={{
                  fontSize: 12,
                  color: 'var(--text-tertiary)',
                  marginLeft: 8,
                  minWidth: 50,
                  textAlign: 'right',
                }}>
                  {formatListDate(latestDate)}
                </span>
                <button
                  type="button"
                  aria-label={t('conversation.manualActions')}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpen(prev => (prev === row.conversation_id ? null : row.conversation_id));
                  }}
                  style={{
                    flexShrink: 0,
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    padding: '2px 4px',
                    fontSize: 16,
                    color: 'var(--text-tertiary)',
                    lineHeight: 1,
                  }}
                >
                  ⋮
                </button>
              </div>
            </div>

            {/* Context menu dropdown */}
            {menuOpen === row.conversation_id && (
              <>
                <div
                  onClick={() => setMenuOpen(null)}
                  style={{ position: 'fixed', inset: 0, zIndex: 999 }}
                />
                <div
                  role="menu"
                  aria-label={t('conversation.manualActions')}
                  style={{
                    position: 'absolute',
                    right: 8,
                    zIndex: 1000,
                    background: 'var(--bg-primary)',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                    minWidth: 220,
                    padding: '4px 0',
                  }}
                >
                  <MenuItem onClick={() => handleDiagnostics(row)}>{t('conversation.whyGrouped')}</MenuItem>
                  <MenuItem onClick={() => handleMerge(row)}>{t('conversation.mergeConversations')}</MenuItem>
                  <MenuItem onClick={() => handleSplit(row, false)}>{t('conversation.splitMessageOnly')}</MenuItem>
                  <MenuItem onClick={() => handleSplit(row, true)}>{t('conversation.splitMessageAndReplies')}</MenuItem>
                  <MenuItem onClick={() => handleMove(row)}>{t('conversation.moveToConversation')}</MenuItem>
                  {row.manually_locked
                    ? <MenuItem onClick={() => handleUnlock(row)}>{t('conversation.unlockConversation')}</MenuItem>
                    : <MenuItem onClick={() => handleLock(row)}>{t('conversation.lock')}</MenuItem>}
                  <MenuItem onClick={() => handleForceInclude(row)}>{t('conversation.forceInclude')}</MenuItem>
                  <MenuItem onClick={() => handleForceExclude(row)}>{t('conversation.forceExclude')}</MenuItem>
                </div>
              </>
            )}

            {/* Expanded logical messages (full conversation, not folder-scoped) */}
            {isOpen && (
              <div
                role="group"
                aria-label={t('conversation.messagesLabel')}
                style={{ paddingLeft: 32, paddingRight: 8 }}
              >
                {(row.logical_messages || []).map(message => {
                  const isOutgoing = message.direction === 'outgoing' || message.direction === 'self';
                  const sender = isOutgoing
                    ? t('conversation.you')
                    : (message.fromName || message.fromEmail || t('conversation.unknownSender'));
                  const msgUnread = message.unread;

                  return (
                    <button
                      key={message.id}
                      type="button"
                      data-logical-message-id={message.id}
                      onClick={() => onOpenMessage?.({
                        ...row,
                        conversation_id: row.conversation_id,
                        logical_message_id: message.id,
                        latestCopyId: message.latestCopyId,
                      })}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        minHeight: 40,
                        width: '100%',
                        textAlign: 'left',
                        padding: '4px 8px',
                        border: 'none',
                        background: 'transparent',
                        cursor: 'pointer',
                        fontWeight: msgUnread ? 600 : 400,
                        color: 'var(--text-primary)',
                        fontSize: 13,
                      }}
                    >
                      <span style={{
                        flexShrink: 0,
                        width: 100,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        color: isOutgoing ? 'var(--accent)' : 'var(--text-primary)',
                        fontWeight: isOutgoing ? 600 : 400,
                      }}>
                        {sender}
                      </span>
                      <span style={{
                        flex: 1,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        marginLeft: 8,
                      }}>
                        {message.snippet || message.subject || t('conversation.noSubject')}
                      </span>
                      {message.hasAttachments && <AttachmentIcon visible />}
                      {message.isLatest && row.latest_message_is_mine && <OwnReplyMarker visible />}
                      <span style={{
                        flexShrink: 0,
                        fontSize: 11,
                        color: 'var(--text-tertiary)',
                        marginLeft: 8,
                      }}>
                        {formatListDate(message.messageDate)}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {nextCursor && (
        <button
          type="button"
          onClick={loadMore}
          disabled={loadingMore}
          style={{
            display: 'block',
            width: '100%',
            padding: 12,
            border: 'none',
            background: 'transparent',
            color: 'var(--accent)',
            cursor: loadingMore ? 'wait' : 'pointer',
            fontSize: 13,
          }}
        >
          {loadingMore ? t('conversation.loading') : t('conversation.loadMore')}
        </button>
      )}

      {/* Ops error toast */}
      {opsError && (
        <div role="alert" style={{
          position: 'sticky',
          bottom: 0,
          padding: '8px 16px',
          background: 'var(--text-danger)',
          color: 'var(--bg-primary)',
          fontSize: 13,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}>
          <span>{opsError}</span>
          <button type="button" onClick={() => setOpsError(null)} aria-label={t('conversation.close')} style={{
            border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 16,
          }}>
            ×
          </button>
        </div>
      )}

      {/* Diagnostics / info modal */}
      {modal && (
        <div
          role="dialog"
          aria-label={modal.title}
          onClick={closeModal}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.4)',
            zIndex: 2000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--bg-primary)',
              borderRadius: 8,
              padding: 20,
              maxWidth: 600,
              width: '90%',
              maxHeight: '80vh',
              overflow: 'auto',
              boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h3 style={{ margin: 0, fontSize: 16 }}>{modal.title}</h3>
              <button type="button" onClick={closeModal} aria-label={t('conversation.close')} style={{
                border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 20, color: 'var(--text-secondary)',
              }}>
                ×
              </button>
            </div>
            <pre style={{
              whiteSpace: 'pre-wrap',
              fontSize: 12,
              fontFamily: 'var(--font-mono, monospace)',
              color: 'var(--text-primary)',
              margin: 0,
            }}>
              {modal.body}
            </pre>
            {opsBusy && (
              <div style={{ marginTop: 12, fontSize: 13, color: 'var(--text-tertiary)' }}>
                {t('conversation.loading')}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
