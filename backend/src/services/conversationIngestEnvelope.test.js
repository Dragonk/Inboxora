import { describe, expect, it } from 'vitest';
import { conversationPersistedFields } from './conversationIngestEnvelope.js';

describe('conversation ingest envelope', () => {
  it('preserves raw headers and provider thread fields without credentials', () => {
    const fields = conversationPersistedFields({
      headers: new Map([['Message-ID', '<m@x>'], ['References', '<p@x>']]),
      attributes: { emailId: 7n, threadId: 42n },
    }, { id: 'a1', imap_host: 'imap.gmail.com', email_address: 'me@example' });
    expect(fields.conversation_raw_headers).toContain('Message-ID: <m@x>');
    expect(fields.provider.providerThreadId).toBe('42');
    expect(JSON.stringify(fields)).not.toMatch(/password|token|secret/i);
  });

  it('persists Outlook MIME threading headers from the parsed ingest shape', () => {
    const fields = conversationPersistedFields({
      parsedHeaders: { 'thread-index': 'abc', 'thread-topic': 'Topic' },
      headers: { 'Thread-Index': 'abc', 'Thread-Topic': 'Topic' },
    }, { id: 'a1', imap_host: 'outlook.office365.com' });
    expect(fields.conversation_thread_index).toBe('abc');
    expect(fields.conversation_thread_topic).toBe('Topic');
  });
});
