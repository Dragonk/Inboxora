import { mockPoolClient } from '../test/poolClient.js';
import { describe, expect, it, vi } from 'vitest';
vi.mock('./db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
import { decodeLegacyConversationHeaders, MAX_REPAIR_HEADER_BYTES, repairConversationHeadersBatch, repairConversationHeadersWithClient } from './conversationHeaderRepair.js';

const legacy = (value: Buffer) => [...value.entries()].map(([index, byte]) => `${index}: ${byte}`).join('\r\n');

describe('legacy IMAP header recovery', () => {
  it('recovers folding, repeated fields and UTF-8 without changing the header bytes', () => {
    const headers = 'Received: first\r\n\tcontinued\r\nReceived: second\r\nSubject: żółć\r\n';
    expect(decodeLegacyConversationHeaders(legacy(Buffer.from(headers)))).toBe(headers);
  });

  it('leaves normal headers, malformed lists, missing indices and out-of-range bytes alone', () => {
    const valid = legacy(Buffer.from('Subject: test\r\n'));
    for (const value of [
      'Subject: test\r\n', '', '0: word', '0: 256', '0: -1', '0: 01',
      valid.replace('1: 117', '2: 117'), valid + '\r\n', valid.replace('1: ', '01: '),
      valid + '\r\n99: 65', legacy(Buffer.from('not a header')), '0: 83\n1: 117',
    ]) expect(decodeLegacyConversationHeaders(value)).toBeNull();
  });

  it('does not perform a lossy repair of invalid UTF-8 or NUL bytes', () => {
    expect(decodeLegacyConversationHeaders(legacy(Buffer.from([83, 58, 32, 255])))).toBeNull();
    expect(decodeLegacyConversationHeaders(legacy(Buffer.from('Subject: a\0b')))).toBeNull();
  });

  it('bounds maintenance memory and rejects invalid batch sizes', async () => {
    expect(decodeLegacyConversationHeaders('0: ' + '1'.repeat(MAX_REPAIR_HEADER_BYTES))).toBeNull();
    for (const limit of [0, -1, 251, 1.5, NaN, Infinity]) {
      await expect(repairConversationHeadersBatch({ userId: 'u', accountId: 'a', limit })).rejects.toThrow('Repair limit');
    }
  });
  it.each(['not-a-cursor','v2:garbage','v2:'+Buffer.from('{}').toString('base64url')])('rejects invalid cursor %s before issuing SQL',async cursor=>{
    const query=vi.fn(),client=mockPoolClient({query});
    await expect(repairConversationHeadersWithClient(client,{userId:'u',accountId:'a',afterId:cursor,apply:true})).rejects.toThrow('Invalid header repair cursor');
    expect(query).not.toHaveBeenCalled();
  });

});
