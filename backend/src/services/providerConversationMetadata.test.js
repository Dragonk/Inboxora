import { describe, expect, it } from 'vitest';
import { providerMetadataForMessage } from './providerConversationMetadata.js';
import { parseProviderMetadata, providerFetchQuery } from './providerThreadAdapter.js';
import { providerIdentityForCopy } from './conversationProviderEnvelope.js';

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

  it('derives the same Outlook root identity from live-shaped and persisted-shaped data', () => {
    const raw = Buffer.concat([Buffer.alloc(22, 7), Buffer.alloc(5, 3)]).toString('base64');
    const live = providerMetadataForMessage({ headers: new Map([['Thread-Index', raw], ['Thread-Topic', 'Topic']]) }, { id: 'a1', imap_host: 'outlook.office365.com' });
    const persisted = providerIdentityForCopy({ conversation_thread_index: raw, conversation_thread_topic: 'Topic', provider_namespace: 'outlook:a1:outlook.office365.com' }, { id: 'a1', imap_host: 'outlook.office365.com' });
    expect(live.providerThreadId).toBe(persisted.providerThreadId);
    expect(live.source).toBe('outlook-conversation-index-root');
    expect(live.isStrong).toBe(false);
  });

  it('extracts Outlook thread metadata from live ImapFlow Map headers', () => {
    const result = providerMetadataForMessage({ headers: new Map([['Thread-Index', 'abc'], ['Thread-Topic', 'Topic']]) }, { imap_host: 'outlook.office365.com' });
    expect(result.threadIndex).toBe('abc');
    expect(result.threadTopic).toBe('Topic');
  });
});
