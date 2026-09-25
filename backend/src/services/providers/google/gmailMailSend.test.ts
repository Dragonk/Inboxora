import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderGmailRawMessage, renderSmtpMessage } from '../../composedMail.js';
import type { ComposedMail } from '../../composedMail.js';
import { gmailMessageSizeRefusal, sendGmailRawMessage } from './gmailMailSend.js';

const tokenMock = vi.hoisted(() => vi.fn(async () => ({
  accessToken: 'google-token-1', expiresAt: new Date(Date.now() + 3600_000), generation: 1, refreshed: false, scopes: [],
})));

vi.mock('../../providerTokenService.js', () => ({ getGoogleAccessToken: tokenMock }));

const OPTIONS = {
  userId: 'user-1',
  connectionId: 'connection-1',
  config: { clientId: 'client-1', clientSecret: 'secret-1', redirectUri: 'https://inboxora.example/cb' },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const composed: ComposedMail = {
  messageId: '<invoice-1@example.test>',
  from: { email: 'sam@gmail.test', name: 'Sam' },
  to: [{ email: 'you@example.test', name: 'You' }],
  cc: [{ email: 'cc@example.test' }],
  bcc: [{ email: 'secret@example.test' }],
  subject: 'Invoice',
  plainBody: 'Please find the invoice',
  htmlBody: '<p>Please find the invoice</p>',
};

afterEach(() => {
  vi.unstubAllGlobals();
  tokenMock.mockClear();
});

describe('rendering the canonical model for Gmail', () => {
  it('keeps the Bcc header, because that is how Gmail reaches a blind recipient', async () => {
    // The Gmail API's Message resource has no envelope field, and its own documentation says the send
    // delivers to the recipients in the To/Cc/Bcc **headers**. Stripping Bcc here would silently drop
    // every blind recipient, and the SMTP renderer's rule must therefore not be reused for this arm.
    const raw = (await renderGmailRawMessage(composed)).toString('utf8');
    expect(raw).toMatch(/^Bcc: secret@example\.test\r$/m);
    expect(raw).toContain('To: You <you@example.test>');
    expect(raw).toContain('Cc: cc@example.test');
    expect(raw).toContain('Subject: Invoice');
  });

  it('still renders the SMTP artefact without Bcc, so the two arms stay different on purpose', async () => {
    const rendered = await renderSmtpMessage(composed);
    const raw = rendered.raw.toString('utf8');
    expect(raw).not.toMatch(/^Bcc:/im);
    // The blind recipient is in the envelope, which is what makes the SMTP send safe.
    expect(rendered.envelope.to).toContain('secret@example.test');
  });

  it('refuses a message above Gmail\'s own raw ceiling, in the provider\'s terms', () => {
    expect(gmailMessageSizeRefusal(1024)).toBeNull();
    expect(gmailMessageSizeRefusal(25 * 1024 * 1024 + 1)).toEqual({
      code: 'MESSAGE_TOO_LARGE',
      actualBytes: 25 * 1024 * 1024 + 1,
      limitBytes: 25 * 1024 * 1024,
    });
  });
});

describe('sending a rendered message through Gmail', () => {
  it('posts only the base64url raw message, never a synthetic envelope field', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return jsonResponse({ id: '18f2a4c0d1e2f3a4', threadId: '18f2a4c0d1e2f3a0' });
    }));

    const raw = Buffer.from('To: you@example.test\r\n\r\nbody');
    const outcome = await sendGmailRawMessage(OPTIONS, raw);
    expect(outcome).toEqual({ status: 'accepted', providerMessageId: '18f2a4c0d1e2f3a4' });
    expect(bodies[0]).toEqual({ raw: raw.toString('base64url') });
    // The API's Message schema has no `envelope`: sending one would be an unknown field.
    expect(Object.keys(bodies[0] as object)).toEqual(['raw']);
  });

  it('passes a real Gmail threadId for replies while preserving RFC reply headers in raw', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return jsonResponse({ id: 'reply-message', threadId: 'gmail-thread-123' });
    }));
    const raw = Buffer.from(
      'To: you@example.test\\r\\n'
      + 'Subject: Re: Topic\\r\\n'
      + 'In-Reply-To: <parent@example.test>\\r\\n'
      + 'References: <parent@example.test>\\r\\n\\r\\nReply',
    );
    await expect(sendGmailRawMessage(OPTIONS, raw, { threadId: 'gmail-thread-123' }))
      .resolves.toMatchObject({ status: 'accepted' });
    expect(bodies[0]).toEqual({ raw: raw.toString('base64url'), threadId: 'gmail-thread-123' });
  });

  it('reports a 4xx read before acceptance as a refusal, retryable only for throttling', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { code: 403, message: 'insufficient scope', status: 'PERMISSION_DENIED', errors: [{ reason: 'insufficientPermissions' }] } }, 403)));
    await expect(sendGmailRawMessage(OPTIONS, Buffer.from('x'))).resolves.toMatchObject({
      status: 'refused', httpStatus: 403, code: 'INSUFFICIENT_SCOPES', retryable: false,
    });

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { code: 429, message: 'rate limited' } }, 429)));
    await expect(sendGmailRawMessage(OPTIONS, Buffer.from('x'))).resolves.toMatchObject({
      status: 'refused', httpStatus: 429, code: 'RATE_LIMITED', retryable: true,
    });
  });

  it('reports a 5xx as an unknown outcome, never as a refusal or a success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { code: 500, message: 'backend error' } }, 500)));
    await expect(sendGmailRawMessage(OPTIONS, Buffer.from('x'))).resolves.toMatchObject({ status: 'outcome_unknown' });
  });

  it('reports a lost connection as an unknown outcome', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('socket hang up'); }));
    await expect(sendGmailRawMessage(OPTIONS, Buffer.from('x'))).resolves.toEqual({
      status: 'outcome_unknown', reason: 'socket hang up',
    });
  });

  it('treats an accepted answer without an id as accepted, without inventing one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({})));
    await expect(sendGmailRawMessage(OPTIONS, Buffer.from('x'))).resolves.toEqual({ status: 'accepted' });
  });
});
