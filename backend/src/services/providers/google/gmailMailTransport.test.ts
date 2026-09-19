import { describe, expect, it, vi } from 'vitest';
import { gmailMailTransport } from './gmailMailTransport.js';
import type { ComposedMail } from '../../composedMail.js';

const sendRaw = vi.hoisted(() => vi.fn());

vi.mock('./gmailMailSend.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./gmailMailSend.js')>()),
  sendGmailRawMessage: sendRaw,
}));

const API = {
  userId: 'user-1',
  connectionId: 'connection-1',
  config: { clientId: 'client-1', clientSecret: 'secret-1', redirectUri: 'https://inboxora.example/cb' },
};

/** A tiny body keeps the rendered message well under Gmail's ceiling. */
const composed: ComposedMail = {
  messageId: '<m@x>',
  from: { email: 'sam@gmail.test' },
  to: [{ email: 'you@example.test', name: 'You' }],
  cc: [{ email: 'cc@example.test' }],
  bcc: [{ email: 'secret@example.test' }],
  subject: 'Invoice',
  plainBody: 'body',
};

describe('the Gmail send transport', () => {
  it('sends the composed message itself — no SMTP render, no IMAP', async () => {
    sendRaw.mockReset();
    sendRaw.mockResolvedValue({ status: 'accepted', providerMessageId: '18f2a4c0d1e2f3a4' });
    const transport = gmailMailTransport(API);

    const result = await transport.send({ composed });
    expect(transport.kind).toBe('gmail_api');
    expect(result).toEqual({
      status: 'accepted',
      accepted: ['you@example.test', 'cc@example.test', 'secret@example.test'],
      rejected: [],
      providerMessageId: '18f2a4c0d1e2f3a4',
    });
    // The buffer handed to Gmail carries the Bcc header; that is the whole point of this arm.
    const [api, raw] = sendRaw.mock.calls[0] as unknown as [typeof API, Buffer];
    expect(api.connectionId).toBe('connection-1');
    expect(raw.toString('utf8')).toMatch(/^Bcc: secret@example\.test\r$/m);
  });

  it('passes a refusal through with the provider\'s own class', async () => {
    sendRaw.mockReset();
    sendRaw.mockResolvedValue({ status: 'refused', httpStatus: 429, code: 'RATE_LIMITED', message: 'slow down', retryable: true });
    await expect(gmailMailTransport(API).send({ composed })).resolves.toEqual({
      status: 'refused', statusCode: 429, code: 'RATE_LIMITED', error: 'slow down', retryable: true,
    });
  });

  it('reports an unknown outcome as unknown, so the route parks it instead of retrying', async () => {
    sendRaw.mockReset();
    sendRaw.mockResolvedValue({ status: 'outcome_unknown', reason: 'socket hang up' });
    await expect(gmailMailTransport(API).send({ composed })).resolves.toEqual({ status: 'outcome_unknown', reason: 'socket hang up' });
  });

  it('refuses an over-limit message before anything is dispatched', async () => {
    sendRaw.mockReset();
    const huge = { ...composed, attachments: [{ filename: 'big.bin', content: Buffer.alloc(26 * 1024 * 1024) }] };
    const result = await gmailMailTransport(API).send({ composed: huge });
    expect(result).toMatchObject({ status: 'refused', statusCode: 413, code: 'MESSAGE_TOO_LARGE', retryable: false });
    // Nothing left the installation: this is a refusal the user can act on, not an unknown outcome.
    expect(sendRaw).not.toHaveBeenCalled();
  });
});
