import { describe, expect, it } from 'vitest';
import { normalizeProviderReferences, parseProviderMetadata, providerNamespace, providerFetchQuery } from './providerThreadAdapter.js';

describe('provider thread adapter foundations', () => {
  it('namespaces provider ids by account', () => {
    expect(providerNamespace({ provider: 'gmail', accountId: 'a1', host: 'imap.gmail.com' })).toBe('gmail:a1:imap.gmail.com');
  });

  it('extracts Gmail provider ids without making them global', () => {
    const result = parseProviderMetadata({ attributes: { xGmMsgId: 12n, xGmThrid: 99n } }, { id: 'a1', imap_host: 'imap.gmail.com' });
    expect(result.provider).toBe('gmail');
    expect(result.providerMessageId).toBe('12');
    expect(result.providerThreadId).toBe('99');
    expect(result.isStrong).toBe(true);
    expect(result.source).toBe('x-gm-thread');
  });

  it('requests generic OBJECTID thread metadata when the capability is advertised', () => {
    expect(providerFetchQuery({ imap_host: 'imap.example.com', capabilities: ['OBJECTID', 'THREADID'] }, {}).threadId).toBe(true);
  });

  it('keeps ImapFlow OBJECTID/emailId provider-neutral', () => {
    const result = parseProviderMetadata({ emailId: 'object-1', threadId: 'object-thread-1' }, { id: 'a1', imap_host: 'imap.example.com' });
    expect(result.provider).toBe('generic');
    expect(result.providerMessageId).toBe('object-1');
    expect(result.providerThreadId).toBe('object-thread-1');
    expect(result.source).toBe('provider-thread-id');
    expect(result.diagnostics.messageIdSource).toBe('imapflow-email-id');
  });

  it('treats NIL provider values as absent', () => {
    const result = parseProviderMetadata({ emailId: 'NIL', threadId: 'NIL' }, { id: 'a1', imap_host: 'imap.gmail.com' });
    expect(result.providerMessageId).toBeNull();
    expect(result.providerThreadId).toBeNull();
    expect(result.isStrong).toBe(false);
  });

  it('keeps only valid structured references', () => {
    expect(normalizeProviderReferences('<a@x> <a@x> prose')).toEqual(['<a@x>']);
  });
});

it('uses persisted Gmail identities when replay has no fresh IMAP attributes', () => {
  const result = parseProviderMetadata({ provider_message_id: '123', provider_thread_id: '90071992547409931' }, { id: 'gmail-account', imap_host: 'imap.googlemail.com' });
  expect(result).toMatchObject({ provider: 'gmail', providerThreadId: '90071992547409931', isStrong: true });
  expect(providerFetchQuery({ imap_host: 'imap.googlemail.com' })).toMatchObject({ threadId: true });
});
