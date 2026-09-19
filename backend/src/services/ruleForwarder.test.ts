import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./smtpTransport.js', () => ({
  createAccountSmtpTransport: vi.fn(),
}));
// The account is bound to its transport through the real send seam, so the Graph transport itself is
// stubbed (never the seam): that is what lets these cases assert a native account both reads and sends
// without ever touching the SMTP factory or the injected IMAP reader.
const graphSend = vi.hoisted(() => vi.fn());
vi.mock('./providers/microsoft/graphMailTransport.js', () => ({
  graphMailTransport: vi.fn(() => ({ kind: 'microsoft_graph', send: graphSend })),
}));
vi.mock('./providers/google/gmailMailTransport.js', () => ({
  gmailMailTransport: vi.fn(),
}));
// Keep the pure Graph helpers real (they are the code under test's collaborators) and stub the readers.
vi.mock('./providers/microsoft/graphMailBody.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./providers/microsoft/graphMailBody.js')>();
  return {
    ...actual,
    fetchGraphMessageBody: vi.fn(),
    fetchGraphAttachments: vi.fn(),
    collectGraphInlineImages: vi.fn(),
    fetchGraphAttachmentBytes: vi.fn(),
  };
});

import { query as __mock_query } from './db.js';
import { createAccountSmtpTransport as __mock_createAccountSmtpTransport } from './smtpTransport.js';
import {
  collectGraphInlineImages as __mock_collectGraphInlineImages,
  fetchGraphAttachments as __mock_fetchGraphAttachments,
  fetchGraphAttachmentBytes as __mock_fetchGraphAttachmentBytes,
  fetchGraphMessageBody as __mock_fetchGraphMessageBody,
} from './providers/microsoft/graphMailBody.js';
import {
  buildForwardComposedMail,
  buildForwardMessage,
  forwardRuleMessage,
} from './ruleForwarder.js';

// Cast mocked module exports so their vitest mock helpers type-check.
const query = vi.mocked(__mock_query);
const createAccountSmtpTransport = vi.mocked(__mock_createAccountSmtpTransport);
const fetchGraphMessageBody = vi.mocked(__mock_fetchGraphMessageBody);
const fetchGraphAttachments = vi.mocked(__mock_fetchGraphAttachments);
const collectGraphInlineImages = vi.mocked(__mock_collectGraphInlineImages);
const fetchGraphAttachmentBytes = vi.mocked(__mock_fetchGraphAttachmentBytes);

const imapAccount = {
  id: 'account-1',
  user_id: 'user-1',
  sender_name: 'Mailbox',
  email_address: 'mailbox@example.com',
};
/** The same local account, but owned by Microsoft Graph: it must read and send over Graph only. */
const graphAccount = {
  ...imapAccount,
  mail_transport: 'microsoft_graph',
  provider_connection_id: 'connection-1',
};
const recipient = 'recipient@example.com';
const storedAttachments = [
  {
    part: '2',
    filename: 'invoice.pdf',
    type: 'application/pdf',
    encoding: 'base64',
    size: 7,
  },
  {
    part: '3',
    filename: 'notes.txt',
    type: 'text/plain',
    encoding: 'quoted-printable',
    size: 5,
  },
];
const messageRow = {
  id: 'message-1',
  account_id: imapAccount.id,
  uid: 42,
  folder: 'INBOX',
  provider_message_id: 'graph-message-1',
  subject: 'Quarterly review',
  from_name: 'Example Sender',
  from_email: 'sender@example.com',
  to_addresses: [{ address: 'team@example.com' }],
  cc_addresses: [],
  date: '2026-07-29T12:00:00.000Z',
  body_text: 'Original body',
  body_html: '<p>Original body</p>',
  attachments: [],
};

/** State the in-memory reservation store exposes so a case can assert what happened to it. */
interface DbState {
  reservation: string | null;
  sentUpdates: number;
  deletes: number;
}

function installDb(
  row: Record<string, unknown> | null,
  options: { messagesError?: Error; sentUpdateError?: Error } = {},
): DbState {
  const state: DbState = { reservation: null, sentUpdates: 0, deletes: 0 };
  query.mockImplementation(async sql => {
    const text = String(sql);
    if (text.includes('INSERT INTO inbox_rule_forwards')) {
      if (state.reservation) return { rows: [] };
      state.reservation = 'pending';
      return { rows: [{ id: 'delivery-1' }] };
    }
    if (text.includes('SELECT status')) {
      return { rows: state.reservation ? [{ status: state.reservation }] : [] };
    }
    if (text.includes('FROM messages')) {
      if (options.messagesError) throw options.messagesError;
      return { rows: row ? [row] : [] };
    }
    if (text.includes('UPDATE inbox_rule_forwards')) {
      state.sentUpdates += 1;
      if (options.sentUpdateError) throw options.sentUpdateError;
      state.reservation = 'sent';
      return { rows: [] };
    }
    if (text.includes('DELETE FROM inbox_rule_forwards')) {
      state.deletes += 1;
      state.reservation = null;
      return { rows: [] };
    }
    throw new Error(`Unexpected query: ${text}`);
  });
  return state;
}

describe('buildForwardMessage', () => {
  it('builds a PII-free-shape Fwd message and escapes forwarded headers', () => {
    const mail = buildForwardMessage({
      row: {
        subject: 'Quarterly <review>',
        from_name: 'Example <Sender>',
        from_email: 'sender@example.com',
        to_addresses: [{ address: 'team@example.com' }],
        cc_addresses: [],
        date: '2026-07-29T12:00:00.000Z',
      },
      account: {
        sender_name: 'Mailbox',
        email_address: 'mailbox@example.com',
      },
      recipient: 'recipient@example.com',
      text: 'Plain body',
      html: '<p>HTML body</p>',
      attachments: [],
    });

    expect(mail).toMatchObject({
      from: 'Mailbox <mailbox@example.com>',
      to: 'recipient@example.com',
      subject: 'Fwd: Quarterly <review>',
    });
    expect(mail.text).toContain('---------- Forwarded message ----------');
    expect(mail.text).toContain('Plain body');
    expect(mail.html).toContain('Example &lt;Sender&gt;');
    expect(mail.html).toContain('<p>HTML body</p>');
  });

  it('does not add a second Fwd prefix', () => {
    const mail = buildForwardMessage({
      row: {
        subject: 'Fwd: Existing',
        from_name: '',
        from_email: 'sender@example.com',
        to_addresses: [],
        cc_addresses: [],
        date: null,
      },
      account: {
        name: 'Mailbox',
        email_address: 'mailbox@example.com',
      },
      recipient: 'recipient@example.com',
      text: '',
      html: null,
      attachments: [],
    });
    expect(mail.subject).toBe('Fwd: Existing');
  });

  it('derives a readable text alternative for HTML-only messages', () => {
    const mail = buildForwardMessage({
      row: {
        subject: 'HTML only',
        from_name: 'Example Sender',
        from_email: 'sender@example.com',
        to_addresses: [],
        cc_addresses: [],
        date: null,
      },
      account: imapAccount,
      recipient: 'recipient@example.com',
      text: '',
      html: '<p>Hello <strong>there</strong></p><p>Second&nbsp;line</p>',
      attachments: [],
    });

    expect(mail.text).toContain('Hello there');
    expect(mail.text).toContain('Second line');
  });

  it('preserves a text-only body without adding an HTML alternative', () => {
    const mail = buildForwardMessage({
      row: {
        subject: 'Text only',
        from_name: 'Example Sender',
        from_email: 'sender@example.com',
        to_addresses: [],
        cc_addresses: [],
        date: null,
      },
      account: imapAccount,
      recipient: 'recipient@example.com',
      text: 'Plain body only',
      html: null,
      attachments: [],
    });

    expect(mail.text).toContain('Plain body only');
    expect(mail).not.toHaveProperty('html');
  });
});

describe('buildForwardComposedMail', () => {
  it('builds the canonical model from the same fields as the nodemailer options', () => {
    const input = {
      row: messageRow,
      account: imapAccount,
      recipient: 'Recipient Name <recipient@example.com>',
      text: null,
      html: '<p>HTML body</p>',
      attachments: [{ filename: 'invoice.pdf', content: Buffer.from('pdfdata'), contentType: 'application/pdf' }],
    };
    const options = buildForwardMessage(input);
    const model = buildForwardComposedMail({ ...input, messageId: '<m@example.com>' });

    expect(model.messageId).toBe('<m@example.com>');
    expect(model.from).toEqual({ email: 'mailbox@example.com', name: 'Mailbox' });
    expect(model.to).toEqual([{ email: 'recipient@example.com', name: 'Recipient Name' }]);
    expect(model.cc).toEqual([]);
    expect(model.bcc).toEqual([]);
    expect(model.subject).toBe(options.subject);
    expect(model.plainBody).toBe(options.text);
    expect(model.htmlBody).toBe(options.html);
    expect(model.attachments).toEqual([
      { filename: 'invoice.pdf', content: Buffer.from('pdfdata'), contentType: 'application/pdf' },
    ]);
  });
});

describe('forwardRuleMessage', () => {
  let smtpSender: { sendMail: Mock; verify: Mock };
  let imapManager: { fetchMessageBody: Mock; fetchMultipleAttachments: Mock };
  let input: Parameters<typeof forwardRuleMessage>[0];

  beforeEach(() => {
    vi.clearAllMocks();
    query.mockReset();
    graphSend.mockReset();
    fetchGraphMessageBody.mockReset();
    fetchGraphAttachments.mockReset();
    collectGraphInlineImages.mockReset();
    fetchGraphAttachmentBytes.mockReset();
    smtpSender = {
      sendMail: vi.fn().mockResolvedValue({ accepted: [recipient], rejected: [] }),
      verify: vi.fn(),
    };
    createAccountSmtpTransport.mockResolvedValue({ account: imapAccount, transport: smtpSender });
    imapManager = {
      fetchMessageBody: vi.fn(),
      fetchMultipleAttachments: vi.fn().mockResolvedValue(new Map()),
    };
    input = {
      ruleId: 'rule-1',
      message: { id: messageRow.id },
      account: imapAccount,
      imapManager,
      recipient,
    };
  });

  describe('an IMAP account', () => {
    it('reserves, sends once, and marks the delivery sent', async () => {
      const state = installDb(messageRow);

      await expect(forwardRuleMessage(input)).resolves.toBe('sent');
      expect(smtpSender.sendMail).toHaveBeenCalledTimes(1);
      expect(smtpSender.sendMail.mock.calls[0][0]).toMatchObject({ to: recipient });
      expect(state.sentUpdates).toBe(1);
      expect(state.reservation).toBe('sent');
    });

    it('returns duplicate without sending when the existing reservation is sent', async () => {
      const state = installDb(messageRow);
      state.reservation = 'sent';

      await expect(forwardRuleMessage(input)).resolves.toBe('duplicate');
      expect(smtpSender.sendMail).not.toHaveBeenCalled();
      expect(createAccountSmtpTransport).not.toHaveBeenCalled();
    });

    it('rejects a pending reservation without starting another delivery', async () => {
      const state = installDb(messageRow);
      state.reservation = 'pending';

      await expect(forwardRuleMessage(input)).rejects.toThrow('Forward delivery pending');
      expect(smtpSender.sendMail).not.toHaveBeenCalled();
      expect(createAccountSmtpTransport).not.toHaveBeenCalled();
    });

    it('allows only one SMTP attempt while another run owns the pending reservation', async () => {
      let notifyDeliveryStarted: ((value?: unknown) => void) | undefined;
      let releaseDelivery: ((value?: unknown) => void) | undefined;
      const deliveryStarted = new Promise(resolve => {
        notifyDeliveryStarted = resolve;
      });
      smtpSender.sendMail.mockImplementation(() => {
        if (notifyDeliveryStarted) notifyDeliveryStarted();
        return new Promise(resolve => {
          releaseDelivery = resolve;
        });
      });
      const state = installDb(messageRow);

      const firstRun = forwardRuleMessage(input);
      await deliveryStarted;

      await expect(forwardRuleMessage(input)).rejects.toThrow('Forward delivery pending');
      expect(smtpSender.sendMail).toHaveBeenCalledTimes(1);
      expect(createAccountSmtpTransport).toHaveBeenCalledTimes(1);

      if (releaseDelivery) releaseDelivery({ accepted: [recipient], rejected: [] });
      await expect(firstRun).resolves.toBe('sent');
      expect(state.reservation).toBe('sent');
    });

    it('deletes a pending reservation after a known pre-delivery failure', async () => {
      const state = installDb(messageRow, { messagesError: new Error('body unavailable') });

      await expect(forwardRuleMessage(input)).rejects.toThrow('body unavailable');
      expect(state.deletes).toBe(1);
      expect(smtpSender.sendMail).not.toHaveBeenCalled();
    });

    it('keeps the reservation when recording success fails after SMTP delivery', async () => {
      const state = installDb(messageRow, { sentUpdateError: new Error('database unavailable') });

      await expect(forwardRuleMessage(input)).rejects.toThrow('database unavailable');
      expect(smtpSender.sendMail).toHaveBeenCalledTimes(1);
      expect(state.sentUpdates).toBe(1);
      expect(state.deletes).toBe(0);
    });

    it('fetches only stored attachment parts once and preserves their metadata', async () => {
      const pdf = Buffer.from('pdfdata');
      const notes = Buffer.from('notes');
      const row = {
        ...messageRow,
        attachments: JSON.stringify(storedAttachments),
      };
      imapManager.fetchMultipleAttachments.mockResolvedValue(new Map([
        ['2', pdf],
        ['3', notes],
      ]));
      installDb(row);

      await expect(forwardRuleMessage(input)).resolves.toBe('sent');

      expect(imapManager.fetchMessageBody).not.toHaveBeenCalled();
      expect(imapManager.fetchMultipleAttachments).toHaveBeenCalledTimes(1);
      expect(imapManager.fetchMultipleAttachments).toHaveBeenCalledWith(
        imapAccount,
        messageRow.uid,
        messageRow.folder,
        storedAttachments
      );
      expect(smtpSender.sendMail).toHaveBeenCalledWith(expect.objectContaining({
        attachments: [
          {
            filename: 'invoice.pdf',
            content: pdf,
            contentType: 'application/pdf',
          },
          {
            filename: 'notes.txt',
            content: notes,
            contentType: 'text/plain',
          },
        ],
      }));
    });

    it('fetches an uncached body, sanitizes HTML, and embeds inline data images', async () => {
      const pdf = Buffer.from('pdfdata');
      const row = {
        ...messageRow,
        body_text: '',
        body_html: null,
        attachments: [storedAttachments[0]],
      };
      imapManager.fetchMessageBody.mockResolvedValue({
        text: 'Secret original body',
        html: '<p onclick="alert(1)">Secret original body<img src="data:image/png;base64,QUJD"></p><script>alert(1)</script>',
        attachments: [{ ...storedAttachments[0], filename: 'duplicate.pdf' }],
      });
      imapManager.fetchMultipleAttachments.mockResolvedValue(new Map([
        ['2', pdf],
      ]));
      installDb(row);
      const consoleSpies = ['log', 'info', 'warn', 'error'].map(method =>
        vi.spyOn(console, method as 'warn' | 'error' | 'log').mockImplementation(() => {}));

      try {
        await expect(forwardRuleMessage(input)).resolves.toBe('sent');

        expect(imapManager.fetchMessageBody).toHaveBeenCalledWith(
          imapAccount,
          messageRow.uid,
          messageRow.folder
        );
        expect(imapManager.fetchMultipleAttachments).toHaveBeenCalledWith(
          imapAccount,
          messageRow.uid,
          messageRow.folder,
          [storedAttachments[0]]
        );
        const mail = smtpSender.sendMail.mock.calls[0][0];
        expect(mail.html).not.toContain('<script');
        expect(mail.html).not.toContain('onclick=');
        expect(mail.html).not.toContain('data:image');
        expect(mail.html).toMatch(/src="cid:img-[a-f0-9]+-0@mailflow"/);
        expect(mail.attachments).toEqual([
          expect.objectContaining({
            filename: 'image-0.png',
            content: Buffer.from('ABC'),
            contentDisposition: 'inline',
            contentType: 'image/png',
          }),
          {
            filename: 'invoice.pdf',
            content: pdf,
            contentType: 'application/pdf',
          },
        ]);
        const consoleOutput = consoleSpies
          .flatMap(spy => spy.mock.calls.flat())
          .map(value => String(value))
          .join(' ');
        expect(consoleOutput).not.toContain(input.recipient);
        expect(consoleOutput).not.toContain('Secret original body');
        expect(consoleOutput).not.toContain('invoice.pdf');
      } finally {
        consoleSpies.forEach(spy => spy.mockRestore());
      }
    });

    it('forwards attachment metadata discovered while fetching an uncached body', async () => {
      const pdf = Buffer.from('pdfdata');
      const fetchedAttachment = {
        part: '4',
        filename: 'discovered.pdf',
        type: 'application/pdf',
        encoding: 'base64',
        size: pdf.length,
      };
      const row = {
        ...messageRow,
        body_text: '',
        body_html: null,
        attachments: [],
      };
      imapManager.fetchMessageBody.mockResolvedValue({
        text: 'Fetched body',
        html: '<p>Fetched body</p>',
        attachments: [fetchedAttachment],
      });
      imapManager.fetchMultipleAttachments.mockResolvedValue(new Map([
        ['4', pdf],
      ]));
      installDb(row);

      await expect(forwardRuleMessage(input)).resolves.toBe('sent');

      expect(imapManager.fetchMultipleAttachments).toHaveBeenCalledWith(
        imapAccount,
        messageRow.uid,
        messageRow.folder,
        [fetchedAttachment]
      );
      expect(smtpSender.sendMail).toHaveBeenCalledWith(expect.objectContaining({
        attachments: [{
          filename: 'discovered.pdf',
          content: pdf,
          contentType: 'application/pdf',
        }],
      }));
    });

    it('rejects attachments larger than 25 MiB before SMTP delivery', async () => {
      const row = {
        ...messageRow,
        attachments: [{
          part: '2',
          filename: 'large.bin',
          type: 'application/octet-stream',
          encoding: 'base64',
          size: 0,
        }],
      };
      imapManager.fetchMultipleAttachments.mockResolvedValue(new Map([
        ['2', Buffer.alloc((25 * 1024 * 1024) + 1)],
      ]));
      const state = installDb(row);

      await expect(forwardRuleMessage(input))
        .rejects.toThrow('Total attachment size exceeds 25 MB');
      expect(createAccountSmtpTransport).not.toHaveBeenCalled();
      expect(smtpSender.sendMail).not.toHaveBeenCalled();
      expect(state.deletes).toBe(1);
    });

    it('rejects declared attachment sizes over 25 MiB before fetching bytes', async () => {
      const row = {
        ...messageRow,
        attachments: [{
          part: '2',
          filename: 'declared-large.bin',
          type: 'application/octet-stream',
          size: (25 * 1024 * 1024) + 1,
        }],
      };
      const state = installDb(row);

      await expect(forwardRuleMessage(input))
        .rejects.toThrow('Total attachment size exceeds 25 MB');
      expect(imapManager.fetchMultipleAttachments).not.toHaveBeenCalled();
      expect(createAccountSmtpTransport).not.toHaveBeenCalled();
      expect(state.deletes).toBe(1);
    });

    it('deletes the reservation when an attachment buffer is unavailable', async () => {
      const row = {
        ...messageRow,
        attachments: [storedAttachments[0]],
      };
      imapManager.fetchMultipleAttachments.mockResolvedValue(new Map());
      const state = installDb(row);

      await expect(forwardRuleMessage(input))
        .rejects.toThrow('Forward attachment unavailable');
      expect(createAccountSmtpTransport).not.toHaveBeenCalled();
      expect(smtpSender.sendMail).not.toHaveBeenCalled();
      expect(state.deletes).toBe(1);
    });

    it('deletes the reservation when SMTP setup returns a safe error', async () => {
      createAccountSmtpTransport.mockResolvedValue({
        error: 'SMTP is unavailable',
        status: 503,
      });
      const state = installDb(messageRow);

      await expect(forwardRuleMessage(input)).rejects.toThrow('SMTP is unavailable');
      expect(smtpSender.sendMail).not.toHaveBeenCalled();
      expect(state.deletes).toBe(1);
    });

    it('clears a failed delivery reservation so a retry can send', async () => {
      const unsafeMessage = 'timeout after DATA for recipient@example.com';
      smtpSender.sendMail
        .mockRejectedValueOnce(new Error(unsafeMessage))
        .mockResolvedValueOnce({ accepted: [recipient], rejected: [] });
      const state = installDb(messageRow);

      let thrown: Error | undefined;
      try {
        await forwardRuleMessage(input);
      } catch (err) {
        if (err instanceof Error) thrown = err;
      }
      if (!thrown) throw new Error('expected forwardRuleMessage to throw');
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown.message).toBe('Forward delivery failed');
      expect(thrown.message).not.toContain(recipient);
      expect(thrown.message).not.toContain(unsafeMessage);
      expect(thrown.cause).toBeUndefined();
      expect(state.deletes).toBe(1);

      await expect(forwardRuleMessage(input)).resolves.toBe('sent');
      expect(smtpSender.sendMail).toHaveBeenCalledTimes(2);
      expect(createAccountSmtpTransport).toHaveBeenCalledTimes(2);
      expect(state.reservation).toBe('sent');
    });
  });

  describe('a native Microsoft Graph account', () => {
    beforeEach(() => {
      input = { ...input, account: graphAccount };
    });

    const uncachedGraphRow = {
      ...messageRow,
      body_text: null,
      body_html: null,
      attachments: [],
    };

    it('reads the body and attachments over Graph and sends through the seam, never IMAP or SMTP', async () => {
      fetchGraphMessageBody.mockResolvedValue({
        contentType: 'html',
        content: '<p onclick="alert(1)">Graph body</p>',
      });
      fetchGraphAttachments.mockResolvedValue([
        { id: 'att-1', name: 'invoice.pdf', contentType: 'application/pdf', size: 7, isInline: false },
      ]);
      collectGraphInlineImages.mockResolvedValue([]);
      fetchGraphAttachmentBytes.mockResolvedValue(Buffer.from('pdfdata'));
      graphSend.mockResolvedValue({ status: 'accepted', accepted: [recipient], rejected: [] });
      const state = installDb(uncachedGraphRow);

      await expect(forwardRuleMessage(input)).resolves.toBe('sent');

      // The native invariant: no mailbox or SMTP object is ever opened for this account.
      expect(imapManager.fetchMessageBody).not.toHaveBeenCalled();
      expect(imapManager.fetchMultipleAttachments).not.toHaveBeenCalled();
      expect(createAccountSmtpTransport).not.toHaveBeenCalled();

      expect(fetchGraphMessageBody).toHaveBeenCalledWith(
        { userId: 'user-1', connectionId: 'connection-1', config: expect.anything() },
        'graph-message-1'
      );
      expect(fetchGraphAttachments).toHaveBeenCalledWith(expect.anything(), 'graph-message-1');
      expect(fetchGraphAttachmentBytes).toHaveBeenCalledWith(
        expect.anything(),
        'graph-message-1',
        'att-1',
        25 * 1024 * 1024
      );

      expect(graphSend).toHaveBeenCalledTimes(1);
      const sent = graphSend.mock.calls[0][0];
      // Graph composes its own representation, so no rendered RFC-822 message accompanies the model.
      expect(sent.rendered).toBeUndefined();
      expect(sent.composed.from).toEqual({ email: 'mailbox@example.com', name: 'Mailbox' });
      expect(sent.composed.to).toEqual([{ email: recipient }]);
      expect(sent.composed.subject).toBe('Fwd: Quarterly review');
      expect(sent.composed.htmlBody).toContain('Graph body');
      expect(sent.composed.htmlBody).not.toContain('onclick');
      expect(sent.composed.attachments).toEqual([
        { filename: 'invoice.pdf', content: Buffer.from('pdfdata'), contentType: 'application/pdf' },
      ]);

      expect(state.reservation).toBe('sent');
      expect(state.sentUpdates).toBe(1);
    });

    it('leaves the reservation pending and unreported when the provider outcome is unknown', async () => {
      fetchGraphMessageBody.mockResolvedValue({ contentType: 'text', content: 'Graph body' });
      fetchGraphAttachments.mockResolvedValue([]);
      collectGraphInlineImages.mockResolvedValue([]);
      graphSend.mockResolvedValue({ status: 'outcome_unknown', reason: 'connection lost after DATA' });
      const state = installDb(uncachedGraphRow);

      await expect(forwardRuleMessage(input)).rejects.toThrow('outcome is unknown');
      expect(state.sentUpdates).toBe(0);
      expect(state.deletes).toBe(0);
      expect(state.reservation).toBe('pending');

      // A later run reconciles rather than sending a second copy.
      await expect(forwardRuleMessage(input)).rejects.toThrow('Forward delivery pending');
      expect(graphSend).toHaveBeenCalledTimes(1);
    });

    it('releases the reservation when the provider refuses before acceptance', async () => {
      fetchGraphMessageBody.mockResolvedValue({ contentType: 'text', content: 'Graph body' });
      fetchGraphAttachments.mockResolvedValue([]);
      collectGraphInlineImages.mockResolvedValue([]);
      graphSend.mockResolvedValue({
        status: 'refused',
        statusCode: 502,
        code: 'DRAFT_CREATE_FAILED',
        error: 'draft could not be created',
        retryable: true,
      });
      const state = installDb(uncachedGraphRow);

      await expect(forwardRuleMessage(input))
        .rejects.toThrow('Forward delivery refused (DRAFT_CREATE_FAILED)');
      expect(state.sentUpdates).toBe(0);
      expect(state.deletes).toBe(1);
      expect(createAccountSmtpTransport).not.toHaveBeenCalled();
    });

    it('reads a cached body’s attachments by provider id without a Graph body fetch', async () => {
      fetchGraphAttachmentBytes.mockResolvedValue(Buffer.from('cached-bytes'));
      graphSend.mockResolvedValue({ status: 'accepted', accepted: [recipient], rejected: [] });
      const row = {
        ...messageRow,
        body_text: 'Cached body',
        body_html: null,
        attachments: JSON.stringify([
          { part: 'att-9', filename: 'cached.pdf', type: 'application/pdf', size: 12 },
        ]),
      };
      const state = installDb(row);

      await expect(forwardRuleMessage(input)).resolves.toBe('sent');

      expect(fetchGraphMessageBody).not.toHaveBeenCalled();
      expect(fetchGraphAttachments).not.toHaveBeenCalled();
      expect(imapManager.fetchMultipleAttachments).not.toHaveBeenCalled();
      expect(fetchGraphAttachmentBytes).toHaveBeenCalledWith(
        expect.anything(),
        'graph-message-1',
        'att-9',
        25 * 1024 * 1024
      );
      expect(graphSend.mock.calls[0][0].composed.attachments).toEqual([
        { filename: 'cached.pdf', content: Buffer.from('cached-bytes'), contentType: 'application/pdf' },
      ]);
      expect(state.reservation).toBe('sent');
    });

    it('refuses an uncached native message with no provider identity without opening IMAP', async () => {
      const state = installDb({ ...uncachedGraphRow, provider_message_id: null });

      await expect(forwardRuleMessage(input)).rejects.toThrow('no Graph identity');
      expect(imapManager.fetchMessageBody).not.toHaveBeenCalled();
      expect(createAccountSmtpTransport).not.toHaveBeenCalled();
      expect(state.deletes).toBe(1);
    });

    it('refuses when the native account has lost its connection, before any read', async () => {
      input = { ...input, account: { ...graphAccount, provider_connection_id: null } };
      const state = installDb(uncachedGraphRow);

      await expect(forwardRuleMessage(input)).rejects.toThrow('not linked to a Graph connection');
      expect(imapManager.fetchMessageBody).not.toHaveBeenCalled();
      expect(createAccountSmtpTransport).not.toHaveBeenCalled();
      expect(state.deletes).toBe(1);
    });
  });

  it('refuses a native Gmail source rather than reading it over IMAP', async () => {
    input = {
      ...input,
      account: { ...imapAccount, mail_transport: 'gmail_api', provider_connection_id: 'connection-g' },
    };
    const state = installDb({
      ...messageRow,
      body_text: null,
      body_html: null,
      attachments: [],
    });

    await expect(forwardRuleMessage(input))
      .rejects.toThrow('Forwarding from a gmail_api source is not supported yet');
    expect(imapManager.fetchMessageBody).not.toHaveBeenCalled();
    expect(createAccountSmtpTransport).not.toHaveBeenCalled();
    expect(state.deletes).toBe(1);
  });
});
