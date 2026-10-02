import { describe, expect, it } from 'vitest';
import { draftAttachments } from './draftAttachments.js';
describe('draft attachment contract', () => {
  it('accepts canonical bytes and ignores file/URL execution options', () => {
    expect(draftAttachments([{filename:'test.txt',content:'aGk=',path:'/private',href:'https://example.test',contentType:'text/plain'}]))
      .toEqual([{filename:'test.txt',content:Buffer.from('hi'),contentType:'text/plain',contentDisposition:'attachment'}]);
    expect(draftAttachments(undefined)).toEqual([]);
  });
  it.each([null, {}, [{filename:'bad\r\nHeader',content:''}], [{filename:'x',content:'not base64!'}],
    [{filename:'x',content:'aGk=',contentType:'text/plain\r\nOther: injected'}], Array(101).fill({filename:'x',content:''})])('rejects malformed input %#', input => {
    expect(() => draftAttachments(input)).toThrow();
  });
});
