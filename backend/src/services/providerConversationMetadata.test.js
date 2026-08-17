import { describe, expect, it } from 'vitest';
import { providerMetadataForMessage } from './providerConversationMetadata.js';
import { parseProviderMetadata, providerFetchQuery } from './providerThreadAdapter.js';

describe('provider conversation metadata', () => {
  it('detects Gmail strong provider threads from ImapFlow attributes', () => {
    const result = providerMetadataForMessage({ attributes: { emailId: 12n, threadId: 99n }, references: '<root@x>', inReplyTo: '<parent@x>' }, { id: 'a1', imap_host: 'imap.gmail.com' });
    expect(result.provider).toBe('gmail');
    expect(result.providerThreadId).toBe('99');
    expect(result.isStrong).toBe(true);
    expect(result.inReplyTo).toBe('<parent@x>');
  });

  it('keeps legacy Gmail attribute aliases supported', () => {
    const result = parseProviderMetadata({ attributes: { xGmMsgId: 12n, xGmThrid: 99n } }, { id: 'a1', imap_host: 'imap.gmail.com' });
    expect(result.providerMessageId).toBe('12');
    expect(result.providerThreadId).toBe('99');
  });

  it('requests Gmail thread metadata from ImapFlow', () => {
    expect(providerFetchQuery({ imap_host: 'imap.gmail.com' }, { headers: true }).threadId).toBe(true);
    expect(providerFetchQuery({ imap_host: 'imap.example.com' }, { headers: true }).threadId).toBeUndefined();
  });

  it('extracts Outlook thread metadata from parsed MIME headers', () => {
    const result = providerMetadataForMessage({ parsedHeaders: { 'thread-index': 'abc', 'thread-topic': 'Topic' } }, { imap_host: 'outlook.office365.com' });
    expect(result.provider).toBe('outlook');
    expect(result.isStrong).toBe(false);
    expect(result.threadIndex).toBe('abc');
    expect(result.threadTopic).toBe('Topic');
  });
});
