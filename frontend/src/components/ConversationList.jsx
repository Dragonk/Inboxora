import { useEffect, useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { conversationApi } from '../utils/conversationApi.js';
import { useSelection, ACTION_SCOPES, DESTRUCTIVE_SCOPES, SCOPE_I18N_KEYS } from '../hooks/useSelection.js';
import { ActionBtn } from './RowHoverActions.jsx';

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
  const { t } = useTranslation();
  if (!visible) return null;
  const label = t('conversation.attachment');
  return <span role="img" aria-label={label} title={label} style={{ marginLeft: 4 }}>📎</span>;
}

function UnreadBadge({ count }) {
  const { t } = useTranslation();
  if (!count) return null;
  return (
    <span
      role="status"
      aria-label={t('conversation.unreadCount', { count })}
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

function LogicalCountBadge({ count }) {
  const { t } = useTranslation();
  if (!count || count <= 1) return null;
  return (
    <span
      role="status"
      aria-label={t('conversation.logicalCount', { count })}
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
      {count}
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

/**
 * P1-09: Build the participant list for the collapsed parent row.
 * Includes the outgoing participant (the user) as "Ja"/"You" via t('conversation.you').
 * Dedupes participants.
 * Example: Alice → user, user → Alice should show "Alice, Ja" not just "Alice".
 *
 * @param {Object} row    conversation row from the API
 * @param {Function} t   i18next t() for the "You" label
 * @returns {string}     comma-separated participant names (max 3)
 */
function getParticipants(row, t) {
  const messages = row.logical_messages || [];
  if (!messages.length) return '';
  const names = new Set();
  let hasOutgoing = false;
  for (const msg of messages) {
    const isOutgoing = msg.direction === 'outgoing' || msg.direction === 'self';
    if (isOutgoing) {
      hasOutgoing = true;
    } else {
      const name = msg.fromName || msg.fromEmail;
      if (name) names.add(name);
    }
  }
  // Include the user (outgoing participant) as "Ja"/"You"
  if (hasOutgoing) {
    names.add(t('conversation.you'));
  }
  return Array.from(names).slice(0, 3).join(', ');
}

// ── Scope selector (P1-10) ─────────────────────────────────────
function ScopeSelector({ value, onChange, destructive }) {
  const { t } = useTranslation();
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
      <span style={{ fontWeight: 600 }}>{t('conversation.scopeTitle')}</span>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        aria-label={t('conversation.scopeTitle')}
        style={{
          padding: '4px 8px',
          borderRadius: 4,
          border: '1px solid var(--border)',
          background: 'var(--bg-primary)',
          color: 'var(--text-primary)',
          fontSize: 13,
        }}
      >
        {ACTION_SCOPES.map(scope => (
          <option key={scope} value={scope}>
            {t(SCOPE_I18N_KEYS[scope])}
          </option>
        ))}
      </select>
      {destructive && DESTRUCTIVE_SCOPES.has(value) && (
        <span style={{ fontSize: 11, color: 'var(--text-danger)' }}>
          {t('conversation.scopeWarning')}
        </span>
      )}
    </label>
  );
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
  // P1-08/09: keyboard focus is independent from mouse hover.
  // j/k/ArrowUp/ArrowDown change keyboardFocusedIndex only.
  // Mouse hover changes hoveredRow only.
  // Neither affects the other — the keyboard navigation origin is never
  // changed by mouse movement.
  const [keyboardFocusedIndex, setKeyboardFocusedIndex] = useState(-1);
  // P1-10: default scope for destructive actions — explicit, never whole conversation
  const [actionScope, setActionScope] = useState('THIS_COPY');
  // P1-11: multi-select state via shared hook
  const {
    selectedIds, selectionModeActive, setSelectionModeActive,
    clearSelection, enterSelectionMode, handleRowToggleSelect, handleRangeSelect,
    selectAll,
  } = useSelection(row => row.conversation_id);
  // P1-12: hover actions — track hovered row (mouse only, does NOT change keyboard focus)
  const [hoveredRow, setHoveredRow] = useState(null);
  // P1-11: long-press timer for mobile
  const longPressTimer = useRef(null);
  const longPressTriggered = useRef(false);
  const listRef = useRef(null);
  // P1-11: context menu positioning ref (for viewport flip/clamp)

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

  const refreshList = useCallback(async () => {
    const data = await conversationApi.list(params);
    setRows(data.conversations || []);
    setNextCursor(data.nextCursor || null);
  }, [params]);

  const runOp = useCallback(async (fn, successModal) => {
    setOpsBusy(true);
    setOpsError(null);
    try {
      const result = await fn();
      if (successModal) {
        setModal({ type: 'info', title: successModal, body: JSON.stringify(result, null, 2) });
      }
      await refreshList();
    } catch (err) {
      setOpsError(err.message || t('conversation.loadFailed'));
    } finally {
      setOpsBusy(false);
    }
  }, [refreshList, t]);

  // P1-10: confirmation dialog for destructive scopes
  const confirmDestructive = useCallback((title, body, onConfirm) => {
    setModal({
      type: 'confirm',
      title,
      body,
      onConfirm,
    });
  }, []);

  const runDestructiveAction = useCallback(async (actionName, fn, scope) => {
    const isDestructiveScope = DESTRUCTIVE_SCOPES.has(scope);
    if (isDestructiveScope) {
      const title = t(`conversation.confirm${actionName}Title`, { count: selectedIds.size || 1 });
      const body = t(`conversation.confirm${actionName}Body`, { count: selectedIds.size || 1 });
      confirmDestructive(title, body, async () => {
        closeModal();
        await runOp(fn);
      });
    } else {
      await runOp(fn);
    }
  }, [confirmDestructive, closeModal, runOp, selectedIds.size, t]);

  // ── P1-12: Hover/quick action handlers ────────────────────────
  // A list row can represent a folder/account-filtered physical copy. Always
  // carry the displayed copy identity for THIS_COPY and other copy scopes;
  // the backend must never guess a different globally-latest copy.
  const rowActionOptions = useCallback((row) => ({
    scope: actionScope,
    copyId: row.latestCopyId || null,
    logicalMessageId: row.logical_message_id || null,
  }), [actionScope]);

  const handleQuickArchive = useCallback((row) => {
    runDestructiveAction('Archive', () => conversationApi.archive(row.conversation_id, rowActionOptions(row)), actionScope);
  }, [runDestructiveAction, actionScope, rowActionOptions]);

  const handleQuickDelete = useCallback((row) => {
    runDestructiveAction('Delete', () => conversationApi.delete(row.conversation_id, rowActionOptions(row)), actionScope);
  }, [runDestructiveAction, actionScope, rowActionOptions]);

  const handleQuickToggleRead = useCallback((row) => {
    const isUnread = (row.unread_count || 0) > 0;
    runOp(() => conversationApi.setRead(row.conversation_id, !isUnread, rowActionOptions(row)));
  }, [runOp, rowActionOptions]);

  const handleQuickToggleStar = useCallback((row) => {
    const isStarred = Boolean(row.starred || row.is_starred || (row.logical_messages || []).some(message => message.starred));
    runOp(() => conversationApi.setStarred(row.conversation_id, !isStarred, rowActionOptions(row)));
  }, [runOp, rowActionOptions]);

  // ── P1-11: Bulk action handlers ───────────────────────────────
  // Bulk endpoints only accept conversation IDs, so THIS_COPY would otherwise
  // resolve the backend's global latest copy instead of the copy represented by
  // each (possibly folder/account-filtered) list row. Preserve row identity by
  // using the copy-aware single-row endpoint for that scope.
  const selectedRows = rows.filter(row => selectedIds.has(row.conversation_id));
  const runBulkAction = useCallback((bulkFn, singleFn) => {
    const ids = selectedRows.map(row => row.conversation_id);
    if (actionScope !== 'THIS_COPY') return bulkFn(ids, { scope: actionScope });
    return selectedRows.reduce(
      (promise, row) => promise.then(() => singleFn(row.conversation_id, {
        scope: actionScope,
        copyId: row.latestCopyId || null,
      })),
      Promise.resolve(),
    );
  }, [selectedRows, actionScope]);

  const handleBulkArchive = useCallback(() => {
    runDestructiveAction('Archive', () => runBulkAction(
      (ids, options) => conversationApi.bulkArchive(ids, options),
      (id, options) => conversationApi.archive(id, options),
    ), actionScope);
  }, [runBulkAction, runDestructiveAction, actionScope]);

  const handleBulkDelete = useCallback(() => {
    runDestructiveAction('Delete', () => runBulkAction(
      (ids, options) => conversationApi.bulkDelete(ids, options),
      (id, options) => conversationApi.delete(id, options),
    ), actionScope);
  }, [runBulkAction, runDestructiveAction, actionScope]);

  const handleBulkToggleRead = useCallback((makeRead) => {
    runOp(() => runBulkAction(
      (ids, options) => conversationApi.bulkSetRead(ids, makeRead, options),
      (id, options) => conversationApi.setRead(id, makeRead, options),
    ));
  }, [runBulkAction, runOp]);

  const handleBulkMove = useCallback(() => {
    const targetFolder = window.prompt(t('conversation.moveToConversationPrompt'));
    if (!targetFolder) return;
    runOp(() => runBulkAction(
      (ids, options) => conversationApi.move(ids, targetFolder.trim(), options),
      (id, options) => conversationApi.move(id, targetFolder.trim(), options),
    ));
  }, [runBulkAction, runOp, t]);

  // ── P1-11: Selection click handling (Ctrl/Cmd+click, Shift+range) ─
  const handleRowClick = useCallback((e, row) => {
    if (longPressTriggered.current) {
      longPressTriggered.current = false;
      e.stopPropagation();
      e.preventDefault();
      return;
    }
    // Checkbox or Ctrl/Cmd+click → toggle selection
    if (e.target.closest('[data-selection-checkbox]') || e.ctrlKey || e.metaKey) {
      e.stopPropagation();
      e.preventDefault();
      if (!selectionModeActive) {
        enterSelectionMode(row.conversation_id);
      } else {
        handleRowToggleSelect(row.conversation_id, rows);
      }
      return;
    }
    // Shift+click → range select
    if (e.shiftKey && selectionModeActive) {
      e.stopPropagation();
      e.preventDefault();
      handleRangeSelect(row.conversation_id, rows);
      return;
    }
    // Normal click: if in selection mode, toggle; else expand
    if (selectionModeActive) {
      e.stopPropagation();
      handleRowToggleSelect(row.conversation_id, rows);
      return;
    }
    toggleExpand(row.conversation_id);
  }, [selectionModeActive, enterSelectionMode, handleRowToggleSelect, handleRangeSelect, rows, toggleExpand]);

  // ── P1-11: Mobile long-press to enter selection mode ───────────
  const handleTouchStart = useCallback((row) => {
    longPressTriggered.current = false;
    longPressTimer.current = setTimeout(() => {
      longPressTriggered.current = true;
      enterSelectionMode(row.conversation_id);
    }, 500);
  }, [enterSelectionMode]);

  const handleTouchEnd = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

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

  // Keyboard navigation: j/k to move focus, Enter to expand, Escape to close
  const handleKeyDown = useCallback((e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      setKeyboardFocusedIndex(prev => Math.min(prev + 1, rows.length - 1));
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      setKeyboardFocusedIndex(prev => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter' && keyboardFocusedIndex >= 0) {
      if (e.currentTarget !== listRef.current) return;
      e.preventDefault();
      const row = rows[keyboardFocusedIndex];
      if (row) toggleExpand(row.conversation_id);
    } else if (e.key === 'Escape') {
      if (selectionModeActive) {
        clearSelection();
      } else {
        setExpanded(null);
        setMenuOpen(null);
        setModal(null);
      }
    } else if (e.key === 'a' && (e.ctrlKey || e.metaKey) && !selectionModeActive) {
      // Ctrl/Cmd+A → select all (page)
      e.preventDefault();
      selectAll(rows);
      setSelectionModeActive(true);
    }
  }, [rows, keyboardFocusedIndex, toggleExpand, selectionModeActive, clearSelection, selectAll, setSelectionModeActive]);

  // Scroll focused row into view
  useEffect(() => {
    if (keyboardFocusedIndex >= 0 && listRef.current) {
      const items = listRef.current.querySelectorAll('[role="listitem"]');
      items[keyboardFocusedIndex]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [keyboardFocusedIndex]);

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
    <div
      ref={listRef}
      role="list"
      aria-label={t('conversation.listLabel')}
      aria-activedescendant={keyboardFocusedIndex >= 0 && rows[keyboardFocusedIndex] ? `conv-row-${rows[keyboardFocusedIndex].conversation_id}` : undefined}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      style={{ overflow: 'auto', height: '100%', outline: 'none' }}
    >
      {/* P1-10: Scope selector — always visible at top */}
      <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <ScopeSelector value={actionScope} onChange={setActionScope} destructive />
        {/* P1-11: Select-all / clear controls */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginLeft: 'auto' }}>
          {!selectionModeActive ? (
            <button type="button" onClick={() => { selectAll(rows); setSelectionModeActive(true); }} style={smallBtnStyle}>
              {t('conversation.selectAll')}
            </button>
          ) : (
            <>
              <button type="button" onClick={() => { selectAll(rows); }} style={smallBtnStyle}>
                {t('conversation.selectPage')}
              </button>
              <button type="button" onClick={clearSelection} style={smallBtnStyle}>
                {t('conversation.deselectAll')}
              </button>
            </>
          )}
        </div>
      </div>

      {/* P1-11: Bulk action toolbar when in selection mode */}
      {selectionModeActive && selectedIds.size > 0 && (
        <div
          role="toolbar"
          aria-label={t('conversation.bulkActions')}
          style={{
            padding: '6px 8px',
            borderBottom: '1px solid var(--border)',
            background: 'var(--bg-secondary)',
            display: 'flex',
            gap: 6,
            alignItems: 'center',
            flexWrap: 'wrap',
            position: 'sticky',
            top: 0,
            zIndex: 10,
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600, marginRight: 8 }}>
            {t('conversation.selectedCount', { count: selectedIds.size })}
          </span>
          <button type="button" onClick={() => handleBulkToggleRead(true)} style={smallBtnStyle}>
            {t('conversation.markRead')}
          </button>
          <button type="button" onClick={() => handleBulkToggleRead(false)} style={smallBtnStyle}>
            {t('conversation.markUnread')}
          </button>
          <button type="button" onClick={handleBulkArchive} style={smallBtnStyle}>
            {t('conversation.archive')}
          </button>
          <button type="button" onClick={handleBulkMove} style={smallBtnStyle}>
            {t('conversation.move')}
          </button>
          <button
            type="button"
            onClick={handleBulkDelete}
            style={{ ...smallBtnStyle, color: 'var(--text-danger)' }}
          >
            {t('conversation.delete')}
          </button>
          <button type="button" onClick={clearSelection} style={{ ...smallBtnStyle, marginLeft: 'auto' }}>
            {t('conversation.exitSelection')}
          </button>
        </div>
      )}

      {rows.map((row, rowIndex) => {
        const isOpen = expanded === row.conversation_id;
        const unreadCount = row.unread_count || 0;
        const participants = getParticipants(row, t);
        const hasAttachments = row.has_attachments || false;
        const latestDate = row.sort_date || row.last_message_at;
        const accounts = (row.logical_messages || [])
          .map(m => m.accountId).filter((v, i, a) => v && a.indexOf(v) === i);
        const messages = row.logical_messages || [];
        const latestMessage = messages[messages.length - 1];
        const latestSnippet = latestMessage?.snippet || '';
        const isFocused = keyboardFocusedIndex === rowIndex;
        const isSelected = selectedIds.has(row.conversation_id);
        // P1-13: logical_message_count from the API
        const logicalCount = row.logical_message_count || messages.length || 0;
        const isStarred = Boolean(row.starred || row.is_starred || (row.logical_messages || []).some(message => message.starred || message.isStarred));
        const isHovered = hoveredRow === row.conversation_id;

        return (
          <div
            key={row.conversation_id}
            id={`conv-row-${row.conversation_id}`}
            role="listitem"
            aria-label={`${row.canonical_subject || t('conversation.noSubject')}, ${t('conversation.messageCount', { count: row.logical_message_count || messages.length || 1 })}`}
            style={{
              borderBottom: '1px solid var(--border)',
              background: isSelected
                ? 'var(--bg-tertiary)'
                : (isOpen ? 'var(--bg-secondary)' : (isFocused ? 'var(--bg-tertiary)' : 'transparent')),
              position: 'relative',
            }}
            onMouseEnter={() => { setHoveredRow(row.conversation_id); }}
            onMouseLeave={() => setHoveredRow(null)}
            onTouchStart={() => handleTouchStart(row)}
            onTouchEnd={handleTouchEnd}
            onTouchMove={handleTouchEnd}
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
              onClick={(e) => handleRowClick(e, row, rowIndex)}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  toggleExpand(row.conversation_id);
                }
              }}
              tabIndex={0}
              role="button"
              data-testid={`conversation-expand-${row.conversation_id}`}
              aria-expanded={isOpen}
              aria-label={`${isOpen ? t('conversation.collapseConversation') : t('conversation.expandConversation')}: ${row.canonical_subject || t('conversation.noSubject')}`}
            >
              {/* P1-11: Selection checkbox (visible in selection mode) */}
              {selectionModeActive && (
                <input
                  type="checkbox"
                  data-selection-checkbox
                  checked={isSelected}
                  onChange={() => handleRowToggleSelect(row.conversation_id, rows)}
                  onClick={e => e.stopPropagation()}
                  style={{ flexShrink: 0, marginRight: 6, cursor: 'pointer' }}
                  aria-label={t('conversation.selectConversationAria')}
                />
              )}

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
                  {isStarred && (
                    <span aria-label={t('conversation.star')} title={t('conversation.star')} style={{ color: 'var(--amber, #f59e0b)', fontSize: 12 }}>★</span>
                  )}
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
                {latestSnippet && (
                  <div style={{
                    fontSize: 12,
                    color: 'var(--text-tertiary)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    marginTop: 1,
                    opacity: 0.8,
                  }}>
                    {latestSnippet}
                  </div>
                )}
              </div>

              <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', marginLeft: 8 }}>
                {/* P1-13: logical_message_count badge (not physical copy count) */}
                <LogicalCountBadge count={logicalCount} />
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

            {/* P1-12: Hover quick actions (desktop only, reuse upstream ActionBtn) */}
            {!selectionModeActive && isHovered && !isOpen && (
              <div style={{
                position: 'absolute',
                right: 40,
                top: '50%',
                transform: 'translateY(-50%)',
                display: 'flex',
                alignItems: 'center',
                gap: 2,
                background: 'var(--bg-primary)',
                borderRadius: 5,
                padding: '1px 2px',
                boxShadow: '0 1px 4px rgba(0,0,0,0.1)',
                zIndex: 5,
              }}>
                <ActionBtn
                  title={unreadCount > 0 ? t('conversation.markUnread') : t('conversation.markRead')}
                  onClick={e => { e.stopPropagation(); handleQuickToggleRead(row); }}
                >
                  {unreadCount > 0 ? '✉' : '▢'}
                </ActionBtn>
                <ActionBtn
                  title={isStarred ? t('conversation.unstar') : t('conversation.star')}
                  onClick={e => { e.stopPropagation(); handleQuickToggleStar(row); }}
                >
                  <span style={{ color: isStarred ? 'var(--amber, #f59e0b)' : 'currentColor', fontSize: 13 }}>
                    {isStarred ? '★' : '☆'}
                  </span>
                </ActionBtn>
                <ActionBtn
                  title={t('conversation.archive')}
                  onClick={e => { e.stopPropagation(); handleQuickArchive(row); }}
                >
                  📦
                </ActionBtn>
                <ActionBtn
                  title={t('conversation.delete')}
                  onClick={e => { e.stopPropagation(); handleQuickDelete(row); }}
                >
                  🗑
                </ActionBtn>
              </div>
            )}

            {/* Context menu dropdown */}
            {menuOpen === row.conversation_id && (
              <>
                <div
                  onClick={() => setMenuOpen(null)}
                  aria-label={t('conversation.close')}
                  style={{ position: 'fixed', inset: 0, zIndex: 999, border: 'none', background: 'transparent', padding: 0, cursor: 'default' }}
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
                  <div style={{ borderTop: '1px solid var(--border)', margin: '4px 0' }} />
                  <MenuItem onClick={() => handleQuickToggleRead(row)}>{t('conversation.markRead')}</MenuItem>
                  <MenuItem onClick={() => handleQuickToggleStar(row)}>{t('conversation.star')}</MenuItem>
                  <MenuItem onClick={() => handleQuickArchive(row)}>{t('conversation.archive')}</MenuItem>
                  <MenuItem onClick={() => handleQuickDelete(row)}>{t('conversation.delete')}</MenuItem>
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

      {/* P1-10: Confirmation dialog for destructive scopes */}
      {modal?.type === 'confirm' && (
        <div
          role="dialog"
          aria-label={modal.title}
          onClick={closeModal}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
            zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: 'var(--bg-primary)', borderRadius: 8, padding: 20,
              maxWidth: 400, width: '90%', boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
            }}
          >
            <h3 style={{ margin: 0, fontSize: 16, marginBottom: 8 }}>{modal.title}</h3>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 16px' }}>{modal.body}</p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" onClick={closeModal} style={smallBtnStyle}>
                {t('conversation.cancel')}
              </button>
              <button
                type="button"
                onClick={modal.onConfirm}
                disabled={opsBusy}
                style={{ ...smallBtnStyle, background: 'var(--text-danger)', color: 'var(--bg-primary)' }}
              >
                {opsBusy ? t('conversation.loading') : t('conversation.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Diagnostics / info modal */}
      {modal?.type === 'info' && (
        <div
          role="dialog"
          aria-label={modal.title}
          onClick={closeModal}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
            zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center',
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

const smallBtnStyle = {
  border: '1px solid var(--border)',
  borderRadius: 4,
  padding: '4px 10px',
  background: 'var(--bg-primary)',
  color: 'var(--text-primary)',
  cursor: 'pointer',
  fontSize: 13,
};
