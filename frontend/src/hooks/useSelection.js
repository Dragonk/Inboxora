import { useState, useCallback, useRef } from 'react';

/**
 * useSelection — shared multi-select primitives extracted from MessageList.
 *
 * Used by both the flat MessageList and the Conversation Engine v2
 * ConversationList so that selection state management (toggle, range select,
 * select-all, clear, Ctrl/Cmd+click, Shift+range) is defined once.
 *
 * @param {Function} getItemId  (item) => id  — defaults to item => item.id
 * @returns {{ selectedIds, setSelectedIds, toggleSelect, selectAll, clearSelection,
 *            handleRowToggleSelect, handleRangeSelect, lastSelectIdxRef }}
 */
export function useSelection(getItemId = item => item.id) {
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [selectionModeActive, setSelectionModeActive] = useState(false);
  const lastSelectIdxRef = useRef(-1);

  const toggleSelect = useCallback((id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback((items) => {
    setSelectedIds(new Set(items.map(getItemId)));
  }, [getItemId]);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setSelectionModeActive(false);
    lastSelectIdxRef.current = -1;
  }, []);

  const enterSelectionMode = useCallback((id) => {
    setSelectionModeActive(true);
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  // Non-shift row checkbox toggle — tracks anchor for range select.
  // `items` is the ordered list for index resolution.
  const handleRowToggleSelect = useCallback((id, items) => {
    const idx = items.findIndex(it => getItemId(it) === id);
    lastSelectIdxRef.current = idx;
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, [getItemId]);

  // Shift-click: selects all rows between anchor and current index.
  const handleRangeSelect = useCallback((id, items) => {
    const clickedIdx = items.findIndex(it => getItemId(it) === id);
    if (clickedIdx === -1) return;
    const anchor = lastSelectIdxRef.current >= 0 ? lastSelectIdxRef.current : clickedIdx;
    const lo = Math.min(anchor, clickedIdx);
    const hi = Math.max(anchor, clickedIdx);
    setSelectedIds(prev => {
      const next = new Set(prev);
      for (let i = lo; i <= hi; i++) next.add(getItemId(items[i]));
      return next;
    });
    lastSelectIdxRef.current = clickedIdx;
  }, [getItemId]);

  return {
    selectedIds,
    setSelectedIds,
    selectionModeActive,
    setSelectionModeActive,
    lastSelectIdxRef,
    toggleSelect,
    selectAll,
    clearSelection,
    enterSelectionMode,
    handleRowToggleSelect,
    handleRangeSelect,
  };
}

/**
 * Scopes for copy-aware destructive actions.
 * The backend enum must be explicit — never default to whole conversation.
 */
export const ACTION_SCOPES = [
  'THIS_COPY',
  'ALL_COPIES_OF_LOGICAL_MESSAGE',
  'COPIES_ON_THIS_ACCOUNT',
  'WHOLE_CONVERSATION',
];

export const DESTRUCTIVE_SCOPES = new Set(['WHOLE_CONVERSATION', 'ALL_COPIES_OF_LOGICAL_MESSAGE']);

export const SCOPE_I18N_KEYS = {
  THIS_COPY: 'conversation.scopeThisCopy',
  ALL_COPIES_OF_LOGICAL_MESSAGE: 'conversation.scopeAllCopies',
  COPIES_ON_THIS_ACCOUNT: 'conversation.scopeAccountCopies',
  WHOLE_CONVERSATION: 'conversation.scopeWholeConversation',
};
