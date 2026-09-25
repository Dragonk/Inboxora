import { describe, it, expect, vi, beforeEach } from 'vitest';

// The seam exists so the Graph transport is a branch in one place rather than a second
// pipeline inside the send route. These cases pin the properties the route depends on:
// an ordinary account reaches SMTP unchanged, a native Graph account reaches Graph and
// never touches SMTP, and a native account without its connection is refused before any
// transport is built.
const graphSend = vi.hoisted(() => vi.fn());
const gmailSend = vi.hoisted(() => vi.fn());
vi.mock('./smtpTransport.js', () => ({ createAccountSmtpTransport: vi.fn() }));
vi.mock('./providers/microsoft/graphMailTransport.js', () => ({
  graphMailTransport: vi.fn(() => ({ kind: 'microsoft_graph', send: graphSend })),
}));
vi.mock('./providers/google/gmailMailTransport.js', () => ({
  gmailMailTransport: vi.fn(() => ({ kind: 'gmail_api', send: gmailSend })),
}));

import { createAccountMailTransport } from './sendTransport.js';
import { createAccountSmtpTransport } from './smtpTransport.js';
import { graphMailTransport } from './providers/microsoft/graphMailTransport.js';
import { gmailMailTransport } from './providers/google/gmailMailTransport.js';
import type { ComposedMail, RenderedSmtpMessage } from './composedMail.js';

const smtp = vi.mocked(createAccountSmtpTransport);
const graph = vi.mocked(graphMailTransport);
const gmail = vi.mocked(gmailMailTransport);

beforeEach(() => {
  smtp.mockReset();
  graph.mockClear();
  gmail.mockClear();
  graphSend.mockReset();
  gmailSend.mockReset();
});

const rendered: RenderedSmtpMessage = {
  raw: Buffer.from('Subject: hi\r\n\r\nbody'),
  envelope: { from: 'sam@contoso.test', to: ['you@example.test'] },
  mailOptions: { subject: 'hi' },
};

const composed: ComposedMail = {
  messageId: '<m@x>',
  from: { email: 'sam@contoso.test' },
  to: [{ email: 'you@example.test' }],
  cc: [],
  bcc: [],
  subject: 'hi',
  plainBody: 'body',
};

describe('binding a send to a transport', () => {
  it('passes an ordinary account through to SMTP and reports a successful hand-off', async () => {
    const sendMail = vi.fn().mockResolvedValue({ accepted: ['you@example.test'], rejected: ['gone@example.test'] });
    smtp.mockResolvedValue({ transport: { sendMail } } as never);
    const account = { id: 'acct-1', user_id: 'user-1', email_address: 'sam@contoso.test', smtp_host: 'smtp.test' };

    const bound = await createAccountMailTransport(account);
    expect(smtp).toHaveBeenCalledWith(account);
    if ('error' in bound) throw new Error('expected a transport');
    expect(bound.account).toBe(account);
    expect(bound.transport.kind).toBe('smtp');
    expect(bound.transport.sendsRenderedMessage).toBe(true);

    // The caller's own rendering is handed over verbatim: the transport composes no second message.
    await expect(bound.transport.send({ composed, rendered })).resolves.toEqual({
      status: 'accepted',
      accepted: ['you@example.test'],
      rejected: ['gone@example.test'],
    });
    expect(sendMail).toHaveBeenCalledWith({ subject: 'hi', raw: rendered.raw });
    expect(graph).not.toHaveBeenCalled();
  });

  it('binds a native Graph account to Graph, and never consults SMTP for it', async () => {
    graphSend.mockResolvedValue({ status: 'accepted', accepted: ['you@example.test'], rejected: [] });
    const account = {
      id: 'acct-1', user_id: 'user-1', email_address: 'sam@contoso.test',
      mail_transport: 'microsoft_graph', provider_connection_id: 'connection-1',
    };

    const bound = await createAccountMailTransport(account);
    if ('error' in bound) throw new Error('expected a transport');
    expect(bound.transport.kind).toBe('microsoft_graph');
    // No RFC-822 message is rendered or dispatched for a native account.
    expect(bound.transport.sendsRenderedMessage).toBe(false);
    expect(smtp).not.toHaveBeenCalled();
    expect(graph).toHaveBeenCalledWith({ userId: 'user-1', connectionId: 'connection-1', config: expect.anything() });

    await bound.transport.send({ composed });
    expect(graphSend).toHaveBeenCalledWith({ composed });
  });

  it('refuses a native account whose connection is missing, before building any transport', async () => {
    const bound = await createAccountMailTransport({
      id: 'acct-1', user_id: 'user-1', mail_transport: 'microsoft_graph', provider_connection_id: null,
    } as never);
    expect(bound).toMatchObject({ status: 409, code: 'PROVIDER_AUTH_REQUIRED' });
    expect(smtp).not.toHaveBeenCalled();
    expect(graph).not.toHaveBeenCalled();
  });

  it('binds a native Gmail account to Gmail, and never consults SMTP or Graph for it', async () => {
    gmailSend.mockResolvedValue({ status: 'accepted', accepted: ['you@example.test'], rejected: [] });
    const account = {
      id: 'acct-1', user_id: 'user-1', email_address: 'sam@gmail.test',
      mail_transport: 'gmail_api', provider_connection_id: 'connection-g',
    };

    const bound = await createAccountMailTransport(account);
    if ('error' in bound) throw new Error('expected a transport');
    expect(bound.transport.kind).toBe('gmail_api');
    // The Gmail transport composes its own representation, so no RFC-822 message from the route is used.
    expect(bound.transport.sendsRenderedMessage).toBe(false);
    expect(smtp).not.toHaveBeenCalled();
    expect(graph).not.toHaveBeenCalled();
    expect(gmail).toHaveBeenCalledWith({ userId: 'user-1', connectionId: 'connection-g', config: expect.anything() });

    await bound.transport.send({ composed });
    expect(gmailSend).toHaveBeenCalledWith({ composed });
  });

  it('refuses a native Gmail account whose connection is missing, before building any transport', async () => {
    const bound = await createAccountMailTransport({
      id: 'acct-1', user_id: 'user-1', mail_transport: 'gmail_api', provider_connection_id: null,
    } as never);
    expect(bound).toMatchObject({ status: 409, code: 'PROVIDER_AUTH_REQUIRED' });
    expect(smtp).not.toHaveBeenCalled();
    expect(gmail).not.toHaveBeenCalled();
  });

  it('carries the SMTP factory’s refusal through unchanged, including its domain code', async () => {
    smtp.mockResolvedValue({ status: 403, error: 'Plain-text SMTP is not allowed', code: 'OPERATION_FORBIDDEN' } as never);
    const bound = await createAccountMailTransport({ id: 'acct-1', smtp_tls: 'none' } as never);
    expect(bound).toMatchObject({ status: 403, code: 'OPERATION_FORBIDDEN', error: 'Plain-text SMTP is not allowed' });
  });
});
