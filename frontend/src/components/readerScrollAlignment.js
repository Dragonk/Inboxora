// The ConversationReader is itself the scroll viewport. Parent chrome (including
// the mobile back bar) is a flex sibling, so reader.getBoundingClientRect().top
// already starts below it. Any future sticky UI rendered *inside* the reader opts
// in with data-conversation-reader-sticky="true" and is measured, never guessed.
export function readerVisibleTop(reader) {
  const readerRect = reader.getBoundingClientRect();
  return [...reader.querySelectorAll('[data-conversation-reader-sticky="true"]')]
    .reduce((bottom, element) => {
      const rect = element.getBoundingClientRect();
      return rect.bottom > readerRect.top && rect.top < readerRect.bottom
        ? Math.max(bottom, rect.bottom)
        : bottom;
    }, readerRect.top);
}

export function alignReaderHeader(reader, header, gap = 8) {
  const readerRect = reader.getBoundingClientRect();
  const desiredTop = readerVisibleTop(reader) + gap;
  const headerTop = header.getBoundingClientRect().top;
  const maxScrollTop = Math.max(0, reader.scrollHeight - reader.clientHeight);
  const headerAlignedScrollTop = Math.min(maxScrollTop, Math.max(0,
    reader.scrollTop + headerTop - desiredTop,
  ));
  // A short terminal card can fit entirely in the viewport after header alignment.
  // Prefer the actual bottom in that case: it exposes as much of the selected body
  // as possible rather than leaving it below the fold behind trailing card padding.
  const card = header.closest?.('[data-conversation-message-state]');
  const cardRect = card?.getBoundingClientRect();
  const cardBottomAfterHeaderAlignment = cardRect
    ? cardRect.bottom - (headerTop - desiredTop)
    : Infinity;
  const terminalCard = cardRect
    && card.nextElementSibling === null
    && cardRect.height <= reader.clientHeight;
  const nextScrollTop = terminalCard || cardBottomAfterHeaderAlignment <= readerRect.bottom
    ? maxScrollTop
    : headerAlignedScrollTop;
  reader.scrollTop = nextScrollTop;
  return { desiredTop, scrollTop: nextScrollTop, readerTop: readerRect.top };
}
