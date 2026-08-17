import { describe, expect, it } from 'vitest';
import { normalizeProviderReferences, parseProviderMetadata, providerNamespace } from './providerThreadAdapter.js';

describe('provider thread adapter foundations', () => {
  it('namespaces provider ids by account', () => {
    expect(providerNamespace({ provider: 'gmail', accountId: 'a1', host: 'imap.gmail.com' })).toBe('gmail:a1:imap.gmail.com');
  });

  it('extracts Gmail provider ids without making them global', () => {
    const result = parseProviderMetadata({ attributes: { xGmMsgId: 12n, xGmThrid: 99n } }, { id: 'a1', imap_host: 'imap.gmail.com' });
    expect(result.provider).toBe('gmail');
    expect(result.providerMessageId).toBe('12');
    expect(result.providerThreadId).toBe('99');
    expect(result.namespace).toContain('a1');
  });

  it('keeps only valid structured references', () => {
    expect(normalizeProviderReferences('<a@x> <a@x> prose')).toEqual(['<a@x>']);
  });
});
