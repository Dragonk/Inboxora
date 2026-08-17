import { describe, expect, it } from 'vitest';
import { conversationPersistedFields, conversationRawHeaders } from './conversationIngestEnvelope.js';

describe('conversation ingest envelope', () => {
  it('preserves raw headers and provider thread fields without credentials', () => {
    const fields = conversationPersistedFields({
      headers: new Map([['Message-ID', '<m@x>'], ['References', '<p@x>']]),
      attributes: { xGmThrid: 42n, xGmMsgId: 7n },
    }, { id: 'a1', imap_host: 'imap.example', email_address: 'me@example' });
    expect(conversationRawHeaders({ headers: { Subject: 'Hello' } })).toBe('Subject: Hello');
    expect(fields.conversation_raw_headers).toContain('Message-ID: <m@x>');
    expect(fields.provider.providerThreadId).toBe('42');
    expect(JSON.stringify(fields)).not.toMatch(/password|token|secret/i);
  });
});
