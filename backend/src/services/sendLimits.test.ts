import { describe, it, expect } from 'vitest';
import {
  SEND_ATTACHMENT_TOTAL_BYTES,
  attachmentRefusal,
  attachmentsRefusal,
  decodedBase64Bytes,
  effectiveSendLimits,
  httpBodyRefusal,
  inlineImagesRefusal,
  mailMaxAttachmentBytes,
  mailMaxMessageBytes,
  messageSizeRefusal,
  providerRawMessageRefusal,
  providerUploadFileRefusal,
  sendHttpBodyWindowBytes,
  sendLimitRefusalBody,
  sendLimitRefusalMessage,
  type EffectiveSendLimits,
} from './sendLimits.js';
import {
  GMAIL_RAW_MESSAGE_MAX_BYTES,
  GRAPH_UPLOAD_SESSION_FILE_MAX_BYTES,
  mailTransportCapabilities,
} from './providers/mailCapabilities.js';

const MIB = 1024 * 1024;
const MIB25 = 25 * MIB;

// P06: the limits belong to the transport. These cases pin the relationships rather than the numbers, so
// that raising one ceiling cannot silently raise another — and so that a provider which declares a larger
// ceiling is not shrunk by the installation's fallback.
describe('effective send limits', () => {
  it('falls back to the installation ceiling for SMTP, which declares none', () => {
    const limits = effectiveSendLimits('smtp', {});
    expect(limits.composedMessageFromFallback).toBe(true);
    expect(limits.composedMessageBytes).toBe(SEND_ATTACHMENT_TOTAL_BYTES);
    expect(limits.singleAttachmentBytes).toBe(SEND_ATTACHMENT_TOTAL_BYTES);
    expect(limits.totalAttachmentBytes).toBe(SEND_ATTACHMENT_TOTAL_BYTES);
    // SMTP has no raw-representation ceiling, no upload object and therefore no method threshold.
    expect(limits.providerRawMessageBytes).toBe(Number.POSITIVE_INFINITY);
    expect(limits.providerUploadFileBytes).toBe(Number.POSITIVE_INFINITY);
    expect(limits.uploadSessionThresholdBytes).toBe(Number.POSITIVE_INFINITY);
    expect(limits.providerMessageBytes).toBe(Number.POSITIVE_INFINITY);
  });

  it('uses Gmail’s raw-message ceiling rather than the installation fallback', () => {
    const limits = effectiveSendLimits('gmail_api', {});
    expect(limits.composedMessageFromFallback).toBe(false);
    expect(limits.providerRawMessageBytes).toBe(GMAIL_RAW_MESSAGE_MAX_BYTES);
    expect(limits.providerMessageBytes).toBe(GMAIL_RAW_MESSAGE_MAX_BYTES);
    expect(limits.totalAttachmentBytes).toBe(GMAIL_RAW_MESSAGE_MAX_BYTES);
    expect(limits.singleAttachmentBytes).toBe(GMAIL_RAW_MESSAGE_MAX_BYTES);
    // Gmail has no upload object: an attachment travels inside the raw message, so there is no second method.
    expect(limits.providerUploadFileBytes).toBe(Number.POSITIVE_INFINITY);
    expect(limits.uploadSessionThresholdBytes).toBe(Number.POSITIVE_INFINITY);
  });

  it('does not cap Microsoft Graph with the SMTP-era fallback', () => {
    const limits = effectiveSendLimits('microsoft_graph', {});
    // The single number that used to bound every transport at 25 MiB no longer bounds Graph at all...
    expect(limits.singleAttachmentBytes).toBe(GRAPH_UPLOAD_SESSION_FILE_MAX_BYTES);
    expect(limits.totalAttachmentBytes).toBe(GRAPH_UPLOAD_SESSION_FILE_MAX_BYTES);
    expect(limits.singleAttachmentBytes).toBeGreaterThan(SEND_ATTACHMENT_TOTAL_BYTES);
    // ...and the upload method, which is a method and not a ceiling, is stated separately.
    expect(limits.uploadSessionThresholdBytes).toBe(3 * MIB);
    expect(limits.providerUploadFileBytes).toBe(150 * MIB);
    expect(limits.composedMessageFromFallback).toBe(false);
  });

  it('lets the installation hard ceiling bound a provider that would accept more', () => {
    const limits = effectiveSendLimits('microsoft_graph', { MAIL_MAX_ATTACHMENT_BYTES: String(10 * MIB) });
    expect(limits.singleAttachmentBytes).toBe(10 * MIB);
    expect(limits.totalAttachmentBytes).toBe(10 * MIB);
    // The provider's own numbers are still reported; they are simply not the binding ceiling here.
    expect(limits.providerUploadFileBytes).toBe(150 * MIB);
  });

  it('separates the installation ceiling from the provider’s own upload ceiling', () => {
    // A lowered installation ceiling refuses first, and names the installation dimension...
    const lowered = effectiveSendLimits('microsoft_graph', { MAIL_MAX_ATTACHMENT_BYTES: String(10 * MIB) });
    expect(attachmentRefusal(11 * MIB, lowered, 'ten.bin')).toMatchObject({
      dimension: 'attachment', code: 'ATTACHMENT_TOO_LARGE', limitBytes: 10 * MIB,
    });
    // ...while the provider's own ceiling is untouched, so an 11 MiB file is not a provider problem.
    expect(providerUploadFileRefusal(11 * MIB, lowered, 'ten.bin')).toBeNull();
    expect(providerUploadFileRefusal(200 * MIB, lowered, 'big.bin')).toMatchObject({
      dimension: 'provider_upload_file', code: 'PROVIDER_UPLOAD_TOO_LARGE', limitBytes: 150 * MIB,
    });
  });

  it('keeps a provider ceiling that is lower than a raised installation ceiling', () => {
    const limits = effectiveSendLimits('microsoft_graph', {
      MAIL_MAX_ATTACHMENT_BYTES: String(400 * MIB),
    });
    expect(limits.singleAttachmentBytes).toBe(GRAPH_UPLOAD_SESSION_FILE_MAX_BYTES);
    expect(limits.totalAttachmentBytes).toBe(GRAPH_UPLOAD_SESSION_FILE_MAX_BYTES);
  });

  it('does not let the fallback message ceiling raise an installation’s hard attachment ceiling', () => {
    const limits = effectiveSendLimits('smtp', {
      MAIL_MAX_MESSAGE_BYTES: String(120 * MIB),
      MAIL_MAX_ATTACHMENT_BYTES: String(20 * MIB),
    });
    expect(limits.composedMessageBytes).toBe(120 * MIB);
    expect(limits.totalAttachmentBytes).toBe(20 * MIB);
  });

  it('resolves every dimension of one send explicitly', () => {
    const limits: EffectiveSendLimits = effectiveSendLimits('microsoft_graph', {});
    expect(Object.keys(limits).sort()).toEqual([
      'composedMessageBytes',
      'composedMessageFromFallback',
      'httpRequestBodyBytes',
      'inlineImageBytes',
      'providerMessageBytes',
      'providerRawMessageBytes',
      'providerUploadFileBytes',
      'singleAttachmentBytes',
      'totalAttachmentBytes',
      'transport',
      'uploadSessionThresholdBytes',
    ].sort());
    // Inline images are attachments, so their budget can never exceed the attachment total.
    expect(limits.inlineImageBytes).toBe(limits.totalAttachmentBytes);
  });

  it('ignores nonsense in both environment ceilings', () => {
    expect(mailMaxMessageBytes({ MAIL_MAX_MESSAGE_BYTES: '0' })).toBe(SEND_ATTACHMENT_TOTAL_BYTES);
    expect(mailMaxMessageBytes({ MAIL_MAX_MESSAGE_BYTES: 'nonsense' })).toBe(SEND_ATTACHMENT_TOTAL_BYTES);
    expect(mailMaxAttachmentBytes({ MAIL_MAX_ATTACHMENT_BYTES: '-5' })).toBe(GRAPH_UPLOAD_SESSION_FILE_MAX_BYTES);
    const limits = effectiveSendLimits('smtp', { MAIL_MAX_MESSAGE_BYTES: '0', MAIL_MAX_ATTACHMENT_BYTES: 'x' });
    expect(limits.composedMessageBytes).toBe(SEND_ATTACHMENT_TOTAL_BYTES);
    expect(limits.totalAttachmentBytes).toBe(SEND_ATTACHMENT_TOTAL_BYTES);
  });

  it('makes the HTTP body window wide enough for the largest supported file, in base64', () => {
    const window = sendHttpBodyWindowBytes({});
    const largest = mailMaxAttachmentBytes({});
    expect(window).toBeGreaterThan(Math.ceil(largest * 4 / 3));
    // The provider numbers are the ones the window has to accommodate: a Graph upload-session file.
    expect(largest).toBeGreaterThanOrEqual(GRAPH_UPLOAD_SESSION_FILE_MAX_BYTES);
  });

  it('reads the provider numbers from one capability definition', () => {
    expect(mailTransportCapabilities('gmail_api').rawMessageBytes).toBe(GMAIL_RAW_MESSAGE_MAX_BYTES);
    expect(mailTransportCapabilities('microsoft_graph').uploadSessionFileBytes).toBe(GRAPH_UPLOAD_SESSION_FILE_MAX_BYTES);
    // A transport that declares nothing is the fallback case, not a zero ceiling.
    expect(mailTransportCapabilities('smtp').messageBytes).toBeNull();
  });
});

describe('limit refusals', () => {
  const smtp = effectiveSendLimits('smtp', {});
  const graph = effectiveSendLimits('microsoft_graph', {});
  const gmail = effectiveSendLimits('gmail_api', {});

  it('refuses at the boundary, not below it, and names the dimension', () => {
    expect(attachmentRefusal(smtp.singleAttachmentBytes, smtp)).toBeNull();
    expect(attachmentRefusal(smtp.singleAttachmentBytes + 1, smtp, 'big.bin')).toMatchObject({
      dimension: 'attachment', code: 'ATTACHMENT_TOO_LARGE', limitBytes: smtp.singleAttachmentBytes, filename: 'big.bin',
    });
    expect(attachmentsRefusal(smtp.totalAttachmentBytes, smtp)).toBeNull();
    expect(attachmentsRefusal(smtp.totalAttachmentBytes + 1, smtp)).toMatchObject({
      dimension: 'attachments', code: 'ATTACHMENTS_TOO_LARGE',
    });
    expect(inlineImagesRefusal(smtp.inlineImageBytes + 1, smtp)).toMatchObject({
      dimension: 'inline_images', code: 'INLINE_IMAGES_TOO_LARGE',
    });
    expect(messageSizeRefusal(smtp.composedMessageBytes + 1, smtp)).toMatchObject({
      dimension: 'composed_message', code: 'MESSAGE_TOO_LARGE',
    });
    expect(providerRawMessageRefusal(gmail.providerRawMessageBytes + 1, gmail)).toMatchObject({
      dimension: 'provider_raw_message', code: 'PROVIDER_MESSAGE_TOO_LARGE', transport: 'gmail_api',
    });
    expect(providerUploadFileRefusal(graph.providerUploadFileBytes + 1, graph, 'huge.bin')).toMatchObject({
      dimension: 'provider_upload_file', code: 'PROVIDER_UPLOAD_TOO_LARGE', filename: 'huge.bin',
    });
    expect(httpBodyRefusal(smtp.httpRequestBodyBytes + 1, smtp)).toMatchObject({
      dimension: 'http_body', code: 'REQUEST_TOO_LARGE',
    });
  });

  it('does not refuse a Graph attachment the SMTP fallback would have refused', () => {
    const forty = 40 * MIB;
    expect(attachmentRefusal(forty, graph, 'forty.bin')).toBeNull();
    expect(providerUploadFileRefusal(forty, graph, 'forty.bin')).toBeNull();
    // The same file on SMTP is refused, and by the dimension that is actually binding there.
    expect(attachmentRefusal(forty, smtp, 'forty.bin')).toMatchObject({ dimension: 'attachment', code: 'ATTACHMENT_TOO_LARGE' });
  });

  it('decodes base64 sizes the way the route accounts for them', () => {
    expect(decodedBase64Bytes('')).toBe(0);
    expect(decodedBase64Bytes('TWFu')).toBe(3);
    expect(decodedBase64Bytes('TWE=')).toBe(2);
    expect(decodedBase64Bytes('TQ==')).toBe(1);
    // A full 4-byte group per three bytes, which is the relationship the body window is built on.
    expect(decodedBase64Bytes('A'.repeat(4 * 1000))).toBe(3000);
  });

  it('answers with the domain facts and a sentence that names the transport', () => {
    const body = sendLimitRefusalBody(providerUploadFileRefusal(GRAPH_UPLOAD_SESSION_FILE_MAX_BYTES + 1, graph, 'huge.bin')!);
    expect(body).toMatchObject({
      code: 'PROVIDER_UPLOAD_TOO_LARGE',
      dimension: 'provider_upload_file',
      transport: 'microsoft_graph',
      filename: 'huge.bin',
      limitBytes: GRAPH_UPLOAD_SESSION_FILE_MAX_BYTES,
      actualBytes: GRAPH_UPLOAD_SESSION_FILE_MAX_BYTES + 1,
    });
    expect(body.error).toContain('Microsoft Graph');
    // No `actual`/`limit` aliases: the domain names are the contract, and a client reading English is a bug.
    expect(body).not.toHaveProperty('actual');
    expect(body).not.toHaveProperty('limit');

    const gmailBody = sendLimitRefusalBody(providerRawMessageRefusal(GMAIL_RAW_MESSAGE_MAX_BYTES + 1, gmail)!);
    expect(gmailBody.error).toContain('Gmail');
    expect(sendLimitRefusalMessage(providerRawMessageRefusal(MIB25 + 1, gmail)!)).toContain('Gmail');
  });
});
