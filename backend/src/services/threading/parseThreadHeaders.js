import { decodeMimeWords, parseHeadersInput } from '../messageParser.js';
import { normalizeMessageIdList } from './normalizeMessageId.js';

function headerValue(headers, name) {
  return headers?.[name] || headers?.[name.toLowerCase()] || '';
}

export function parseThreadHeaders(input) {
  const headers = parseHeadersInput(input);
  const inReplyTo = normalizeMessageIdList(headerValue(headers, 'in-reply-to'));
  const references = normalizeMessageIdList(headerValue(headers, 'references'));
  return {
    inReplyTo: inReplyTo.at(-1) || null,
    references,
    subject: decodeMimeWords(headerValue(headers, 'subject') || '').trim() || null,
  };
}
