import { describe, expect, it } from 'vitest';
import { providerMetadataForMessage } from './providerConversationMetadata.js';

describe('provider conversation metadata', () => {
  it('detects Gmail strong provider threads without globalizing ids', () => {
    const result = providerMetadataForMessage({ attributes: { xGmMsgId: 12n, xGmThrid: 99n }, references: '<root@x>', inReplyTo: '<parent@x>' }, { id: 'a1', imap_host: 'imap.gmail.com' });
    expect(result.provider).toBe('gmail');
    expect(result.providerThreadId).toBe('99');
    expect(result.isStrong).toBe(true);
    expect(result.inReplyTo).toBe('<parent@x>');
  });

  it('treats Outlook thread metadata as supporting evidence only', () => {
    const result = providerMetadataForMessage({ attributes: { 'thread-index': 'abc', 'thread-topic': 'Topic' } }, { imap_host: 'outlook.office365.com' });
    expect(result.provider).toBe('outlook');
    expect(result.isStrong).toBe(false);
    expect(result.threadIndex).toBe('abc');
  });
});
