import { describe, expect, it } from 'vitest';
import { parseProviderMetadata, providerNamespace } from './providerThreadAdapter.js';

describe('provider fixtures', () => {
  it('normalizes Gmail BigInt identifiers without precision loss', () => {
    const result = parseProviderMetadata({ attributes: { xGmMsgId: 9007199254740993n, xGmThrid: 9007199254740995n } }, { id: 'a1', imap_host: 'imap.gmail.com' });
    expect(result.provider).toBe('gmail');
    expect(result.providerMessageId).toBe('9007199254740993');
    expect(result.providerThreadId).toBe('9007199254740995');
    expect(result.isStrong).toBe(true);
  });

  it('covers Gmail, Outlook and generic/Fastmail namespaces', () => {
    expect(providerNamespace({ provider: 'generic', accountId: 'a1', host: 'imap.fastmail.com' })).toBe('generic:a1:imap.fastmail.com');
    expect(parseProviderMetadata({}, { id: 'a2', imap_host: 'outlook.office365.com' }).provider).toBe('outlook');
    expect(parseProviderMetadata({}, { id: 'a3', imap_host: 'imap.fastmail.com' }).provider).toBe('generic');
  });
});
