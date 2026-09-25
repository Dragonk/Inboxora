import { describe, it, expect, vi } from 'vitest';

// The seam imports the provider auth/config layer, which opens real Redis and PostgreSQL connections at import
// time. This suite exercises the pure size policy, so those are stubbed rather than dialled.
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./redis.js', () => ({ redisClient: {} }));
// `smtpTransport` reaches the OAuth router, which reaches the application entry point and connects Redis at
// import time. The SMTP arm is not what this suite measures, so it is replaced rather than dialled.
vi.mock('./smtpTransport.js', () => ({ createAccountSmtpTransport: vi.fn() }));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('./providerAuthService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./providerAuthService.js')>()),
  microsoftConfigFromEnv: () => ({}),
  googleConfigFromEnv: () => ({}),
}));

import { gmailPreflight, providerPreflight } from './sendTransport.js';
import { effectiveSendLimits } from './sendLimits.js';
import type { ComposedMail } from './composedMail.js';

const MIB = 1024 * 1024;

// P06: the provider's own pre-dispatch size question. These are the checks that keep a size refusal from
// becoming an ambiguous outcome: they run before the send intent is claimed, so nothing is dispatched and
// nothing has to be reconciled.
// One backing buffer, sliced per fixture: `subarray` shares memory, so a 151 MiB *limit* can be exercised
// without allocating a 151 MiB file per case.
const backing = Buffer.alloc(160 * MIB, 7);
const sized = (size: number) => backing.subarray(0, size);

function composedWith(sizes: number[]): ComposedMail {
  return {
    messageId: 'm1',
    from: { email: 'me@example.com' },
    to: [{ email: 'you@example.com' }],
    cc: [],
    bcc: [],
    subject: 'Files',
    plainBody: 'Hello',
    attachments: sizes.map((size, index) => ({
      filename: `file-${index}.bin`,
      content: sized(size),
      contentType: 'application/octet-stream',
    })),
  };
}

describe('the Microsoft Graph preflight', () => {
  const limits = effectiveSendLimits('microsoft_graph', {});
  const preflight = providerPreflight('microsoft_graph', limits);

  it('allows a file above the SMTP-era 25 MB that Graph carries through an upload session', () => {
    // 26 MiB: above the number that used to bound every transport, far below Graph's own file ceiling.
    expect(preflight(composedWith([26 * MIB]))).toBeNull();
    expect(preflight(composedWith([140 * MIB]))).toBeNull();
  });

  it('allows a total above 25 MB, because Graph’s ceiling is its own', () => {
    expect(preflight(composedWith([20 * MIB, 20 * MIB]))).toBeNull();
  });

  it('refuses a file above the provider’s upload ceiling, naming it, before dispatch', () => {
    const refusal = preflight(composedWith([151 * MIB]));
    expect(refusal).toMatchObject({
      dimension: 'provider_upload_file',
      code: 'PROVIDER_UPLOAD_TOO_LARGE',
      transport: 'microsoft_graph',
      filename: 'file-0.bin',
      limitBytes: 150 * MIB,
    });
    expect(refusal?.statusCode).toBe(413);
    expect(refusal?.error).toContain('Microsoft Graph');
  });

  it('refuses a total above the provider’s message ceiling', () => {
    const refusal = preflight(composedWith([100 * MIB, 60 * MIB]));
    expect(refusal).toMatchObject({ dimension: 'attachments', code: 'ATTACHMENTS_TOO_LARGE' });
  });

  it('names the installation ceiling when an operator has lowered it', () => {
    const lowered = providerPreflight('microsoft_graph', effectiveSendLimits('microsoft_graph', { MAIL_MAX_ATTACHMENT_BYTES: String(4 * MIB) }));
    const refusal = lowered(composedWith([5 * MIB]));
    expect(refusal).toMatchObject({ dimension: 'attachment', code: 'ATTACHMENT_TOO_LARGE', limitBytes: 4 * MIB });
  });
});

describe('the Gmail preflight', () => {
  const limits = effectiveSendLimits('gmail_api', {});

  it('refuses a raw message over Gmail’s ceiling before anything is dispatched', async () => {
    const { refusal, raw } = await gmailPreflight(composedWith([1 * MIB]), limits, async () => sized(26 * MIB));
    expect(refusal).toMatchObject({
      dimension: 'provider_raw_message',
      code: 'PROVIDER_MESSAGE_TOO_LARGE',
      transport: 'gmail_api',
      limitBytes: 25 * MIB,
    });
    expect(raw).toBeUndefined();
  });

  it('refuses when the attachments fit but the encoded message does not', async () => {
    // 20 MiB of attachments are inside every attachment ceiling; the rendered raw message is not, which is the
    // case that only a raw-message measurement can catch.
    const { refusal } = await gmailPreflight(composedWith([20 * MIB]), limits, async () => sized(34 * MIB));
    expect(refusal?.code).toBe('PROVIDER_MESSAGE_TOO_LARGE');
  });

  it('keeps the measured render for the send that follows, and refuses only when it must', async () => {
    const raw = sized(2 * MIB);
    const { refusal, raw: measured } = await gmailPreflight(composedWith([1 * MIB]), limits, async () => raw);
    expect(refusal).toBeNull();
    expect(measured).toBe(raw);
  });

  it('leaves a composition failure to the send, which reports it as the retryable refusal it is', async () => {
    const { refusal, raw } = await gmailPreflight(composedWith([]), limits, async () => { throw new Error('render failed'); });
    expect(refusal).toBeNull();
    expect(raw).toBeUndefined();
  });
});
