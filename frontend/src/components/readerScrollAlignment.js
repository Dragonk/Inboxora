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
  const nextScrollTop = Math.min(maxScrollTop, Math.max(0,
    reader.scrollTop + headerTop - desiredTop,
  ));
  reader.scrollTop = nextScrollTop;
  return { desiredTop, scrollTop: nextScrollTop, readerTop: readerRect.top };
}
