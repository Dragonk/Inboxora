import { describe, it, expect } from 'vitest';
import {
  SEND_ATTACHMENT_TOTAL_BYTES,
  attachmentTotalRefusal,
  mailMaxMessageBytes,
  messageSizeRefusal,
  sendLimits,
} from './sendLimits.js';

// The four size dimensions used to be literals and locals spread through the send route,
// two of them the same number written twice. A refusal has to name its dimension, so the
// kinds and their arithmetic live here and are asserted as a set rather than one by one.
describe('the send limits', () => {
  it('derives the dimensions together so the relationship cannot drift', () => {
    const limits = sendLimits({});
    expect(limits.attachmentsBytes).toBe(SEND_ATTACHMENT_TOTAL_BYTES);
    expect(limits.attachmentBytes).toBe(limits.mimeBytes);
  });

  it('reads MAIL_MAX_MESSAGE_BYTES for the message dimensions and ignores nonsense', () => {
    expect(mailMaxMessageBytes({ MAIL_MAX_MESSAGE_BYTES: '52428800' })).toBe(52_428_800);
    // A zero, negative or unparsable override must not become a limit nothing can pass.
    expect(mailMaxMessageBytes({ MAIL_MAX_MESSAGE_BYTES: '0' })).toBe(SEND_ATTACHMENT_TOTAL_BYTES);
    expect(mailMaxMessageBytes({ MAIL_MAX_MESSAGE_BYTES: 'nonsense' })).toBe(SEND_ATTACHMENT_TOTAL_BYTES);
    const raised = sendLimits({ MAIL_MAX_MESSAGE_BYTES: '52428800' });
    expect(raised.mimeBytes).toBe(52_428_800);
    // Raising the message ceiling must not silently raise the attachment total with it.
    expect(raised.attachmentsBytes).toBe(SEND_ATTACHMENT_TOTAL_BYTES);
  });

  it('refuses at the boundary and names the dimension it refused on', () => {
    const limits = sendLimits({});
    expect(attachmentTotalRefusal(limits.attachmentsBytes, limits)).toBeNull();
    expect(attachmentTotalRefusal(limits.attachmentsBytes + 1, limits)).toMatchObject({
      kind: 'attachments', code: 'ATTACHMENT_TOO_LARGE', limitBytes: limits.attachmentsBytes,
    });
    expect(messageSizeRefusal(limits.mimeBytes, limits)).toBeNull();
    expect(messageSizeRefusal(limits.mimeBytes + 1, limits)).toMatchObject({
      kind: 'mime', code: 'MESSAGE_TOO_LARGE',
    });
  });
});
