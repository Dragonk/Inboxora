/**
 * Remove one header (and its folded continuation lines) from a raw RFC-822 message.
 *
 * It exists because of a measured property of the composer, not a preference: the
 * stream composition the send route uses for size accounting **keeps a `Bcc:` header**
 * in the generated message, while the delivery transport omits it. That is harmless
 * while the buffer is only measured — and becomes a disclosure the moment the buffer is
 * handed to a transport as `raw`, because a raw message is sent as given. Blind
 * recipients belong in the envelope and nowhere a recipient or relay can read them from.
 *
 * The obvious switch does not work: `keepBcc: false` on the stream transport still
 * emits the header (measured, same byte count as the default). So the header is removed
 * here, once, where both transports can share the result.
 *
 * Only the header block is touched: the body is copied verbatim, including any line that
 * happens to start with the header's name, and the `CRLF CRLF` separator is preserved.
 */
export function stripHeaderFromMessage(message: Buffer | string, headerName: string): Buffer {
  const input = typeof message === 'string' ? Buffer.from(message, 'utf8') : message;
  const text = input.toString('latin1');
  const separator = text.indexOf('\r\n\r\n');
  if (separator === -1) return input; // not a message with a header block; leave it alone

  const head = text.slice(0, separator);
  const body = text.slice(separator);
  const wanted = headerName.toLowerCase();
  const kept: string[] = [];
  let dropping = false;

  for (const line of head.split('\r\n')) {
    // A continuation line belongs to the header above it: it is removed with it.
    if (/^[ \t]/.test(line)) {
      if (!dropping) kept.push(line);
      continue;
    }
    const colon = line.indexOf(':');
    if (colon !== -1 && line.slice(0, colon).trim().toLowerCase() === wanted) {
      dropping = true;
      continue;
    }
    dropping = false;
    kept.push(line);
  }

  // If the header was absent the message is returned byte-for-byte, so a caller cannot
  // be surprised by a rewrite that was not needed.
  if (kept.length === head.split('\r\n').length) return input;
  return Buffer.from(`${kept.join('\r\n')}${body}`, 'latin1');
}
