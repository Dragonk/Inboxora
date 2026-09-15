import { useStore } from '../store/index.ts';

// Auto-advance the reading pane when the open message leaves the list: select the row that takes
// its place (next in display order, or previous if it was the last, or nothing if the list is now
// empty). Call before removeMessage so the outgoing row is still present for the lookup. No-op
// unless the removed message is the currently selected one. Store-only (no component state), so it's
// a shared list capability that core row-actions and plugins (e.g. GTD "done") both use.
// selectedWithinRemovedRow: when true, advance even if the selected id isn't exactly removedId —
// used by threaded archive, where the open message may be a child of the removed thread head
// (a different id) but still leaves the list, so selection must still advance.
export function advanceSelectionAfterRemoval<T extends [] | [selectedWithinRemovedRow: boolean]>(
  removedId: string,
  ...args: T
): void {
  const { messages, searchResults, searchQuery, selectedMessageId, setSelectedMessage } = useStore.getState();
  const selectedWithinRemovedRow = args.length === 1 && args[0];
  if (!selectedWithinRemovedRow && selectedMessageId !== removedId) return;

  const displayMsgs = searchQuery.trim() ? searchResults : messages;
  const idx = displayMsgs.findIndex((message) => message.id === removedId);
  if (idx === -1) return;

  const nextIndex = idx + 1 < displayMsgs.length ? idx + 1 : idx - 1;
  const next = nextIndex < 0 ? null : displayMsgs[nextIndex];
  setSelectedMessage(next === null ? null : next.id);
}
