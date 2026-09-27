import { describe, expect, it } from 'vitest';
import { conversationPersistedFields, conversationRawHeaders } from './conversationIngestEnvelope.js';

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

  it('includes delivery identities from case-insensitive Map headers', async () => {
    const { resolveOwnIdentityAddresses } = await import('./conversationIngestEnvelope.js');
    const db = { query: async () => ({ rows: [{ email_address: 'me@example', aliases: [] }] }) };
    await expect(resolveOwnIdentityAddresses(db, 'a1', {
      headers: new Map([['Delivered-To', 'catchall@example.com']]),
    })).resolves.toContain('catchall@example.com');
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


describe('IMAP binary header storage (issue #16)', () => {
  const raw = 'Received: from mx.example.test\r\n'
    + '\tby inbox.example.test\r\nMessage-ID: <m@example.test>\r\n'
    + 'Subject: Zażółć gęślą jaźń\r\nX-Repeated: one\r\nX-Repeated: two\r\n';

  it('stores a real ImapFlow Buffer as RFC headers, not indexed decimal bytes', () => {
    const input = Buffer.from(raw, 'utf8');
    const stored = conversationRawHeaders({ headers: input });
    expect(stored).toBe(raw);
    expect(Buffer.byteLength(stored!)).toBe(input.byteLength);
  });

  it('decodes only the supplied Uint8Array view, not its entire backing buffer', () => {
    const input = Buffer.from(`prefix${raw}suffix`);
    const view = new Uint8Array(input.buffer, input.byteOffset + 6, Buffer.byteLength(raw));
    expect(conversationRawHeaders({ headers: view })).toBe(raw);
  });

  it('preserves raw strings, header folding, duplicate fields and Unicode', () => {
    expect(conversationRawHeaders({ headers: raw })).toBe(raw);
  });

  it('keeps empty and absent input semantics', () => {
    expect(conversationRawHeaders({ headers: Buffer.alloc(0) })).toBe('');
    expect(conversationRawHeaders({ headers: null })).toBeNull();
    expect(conversationRawHeaders(undefined)).toBeNull();
  });
});
