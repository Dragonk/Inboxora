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
    expect((providerFetchQuery({ imap_host: 'imap.gmail.com' }, { headers: true })).threadId).toBe(true);
    expect((providerFetchQuery({ imap_host: 'imap.example.com' }, { headers: true })).threadId).toBeUndefined();
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

// A native Microsoft account carries Graph's `conversationId` in `thread_id`. It is
// server-assigned and immutable, so it is strong evidence — the same property Gmail's
// X-GM-THRID has — and it must not be routed through the Outlook Thread-Index path,
// which expects a 22-byte hex root and answers null for a base64 id. Dropping the key
// silently would be the worse of the two failures.
describe('Graph conversations', () => {
  const account = { id: 'acct-1', imap_host: 'outlook.office365.com', mail_transport: 'microsoft_graph' };
  const message = { thread_id: 'AAQkADM0YmY3Y2Et=', messageId: '<m1@contoso.test>' };

  it('takes the conversation id as a strong provider thread id', () => {
    const metadata = providerMetadataForMessage(message, account);
    expect(metadata).toMatchObject({
      provider: 'graph',
      providerThreadId: 'AAQkADM0YmY3Y2Et=',
      isStrong: true,
      source: 'provider-thread-id',
    });
    // The namespace carries the account, so two mailboxes cannot share a thread.
    expect(metadata.namespace).toContain('acct-1');
  });

  it('does not fall back to the Outlook Thread-Index path for a Graph account', () => {
    // A base64 conversation id has no 22-byte hex root, so that path would answer null.
    const metadata = providerMetadataForMessage({ thread_id: 'AAQkADM0YmY3Y2Et=' }, account);
    expect(metadata.providerThreadId).toBe('AAQkADM0YmY3Y2Et=');
    expect(metadata.source).not.toBe('outlook-conversation-index-root');
  });

  it('treats an IMAP Outlook mailbox exactly as before', () => {
    const metadata = providerMetadataForMessage(message, { id: 'acct-1', imap_host: 'outlook.office365.com' });
    expect(metadata.provider).toBe('outlook');
    expect(metadata.isStrong).toBe(false);
    expect(metadata.providerThreadId).toBeNull();
  });
});

describe('native Gmail API conversations', () => {
  // A cutover account has no IMAP host to classify: `mail_transport` is the signal, and the Gmail threadId
  // the sync stored is what keeps a conversation together. Without this override the provider was classified
  // as `generic`, the thread id stopped being strong evidence, and a Gmail account re-grouped by subject.
  const nativeAccount = { id: 'acct-gmail', imap_host: 'imap.gmail.com', mail_transport: 'gmail_api' };

  it('takes the stored Gmail thread id as a strong provider thread', () => {
    const metadata = providerMetadataForMessage(
      { thread_id: 'thread-1', provider_thread_id: 'thread-1' } as never,
      nativeAccount as never,
    );
    expect(metadata.provider).toBe('gmail');
    expect(metadata.isStrong).toBe(true);
    expect(metadata.providerThreadId).toBe('thread-1');
    expect(metadata.source).toBe('provider-thread-id');
  });

  it('groups two messages of one Gmail thread even with different subjects and Message-IDs', () => {
    const first = providerMetadataForMessage(
      { thread_id: 'thread-1', provider_thread_id: 'thread-1', messageId: '<a@example.test>', subject: 'Project plan' } as never,
      nativeAccount as never,
    );
    const reply = providerMetadataForMessage(
      { thread_id: 'thread-1', provider_thread_id: 'thread-1', messageId: '<b@example.test>', subject: 'Re: Projektplan' } as never,
      nativeAccount as never,
    );
    expect(reply.providerThreadId).toBe(first.providerThreadId);
    expect(reply.isStrong).toBe(true);
  });

  it('keeps two different Gmail threads apart even when the subjects match', () => {
    const one = providerMetadataForMessage(
      { thread_id: 'thread-1', provider_thread_id: 'thread-1', subject: 'Status' } as never,
      nativeAccount as never,
    );
    const two = providerMetadataForMessage(
      { thread_id: 'thread-2', provider_thread_id: 'thread-2', subject: 'Status' } as never,
      nativeAccount as never,
    );
    expect(one.providerThreadId).not.toBe(two.providerThreadId);
  });

  it('does not give a generic IMAP account a strong provider thread', () => {
    const generic = providerMetadataForMessage(
      { thread_id: 'thread-1', provider_thread_id: 'thread-1' } as never,
      { id: 'acct-1', imap_host: 'imap.fastmail.test', mail_transport: null } as never,
    );
    expect(generic.isStrong).toBe(false);
    expect(generic.provider).toBe('generic');
  });

  it('keeps legacy Gmail IMAP (X-GM-THRID) behaviour unchanged', () => {
    const legacy = providerMetadataForMessage(
      { xGmThrid: '1844796336676610000' } as never,
      { id: 'acct-1', imap_host: 'imap.gmail.com', mail_transport: null } as never,
    );
    expect(legacy.provider).toBe('gmail');
    expect(legacy.isStrong).toBe(true);
    expect(legacy.source).toBe('x-gm-thread');
  });
});
