import { describe, it, expect } from 'vitest';
import { renderSmtpMessage, type ComposedMail } from './composedMail.js';

// The renderer is the only place Inboxora decides a wire format, so these cases assert what a
// recipient could observe rather than that an object was assembled: the MIME must not carry a blind
// recipient, the envelope must, and the headers that make a reply thread must survive.
const base: ComposedMail = {
  messageId: '<fixed@inboxora.test>',
  from: { email: 'sam@inboxora.test', name: 'Sam' },
  to: ['visible@example.test'],
  cc: [],
  bcc: [],
  subject: 'Subject line',
  plainBody: 'Plain body',
};

describe('renderSmtpMessage', () => {
  it('renders a message with no Bcc header, and an envelope that carries the blind recipient', async () => {
    const { raw, envelope } = await renderSmtpMessage({
      ...base,
      to: ['visible@example.test'],
      cc: ['copy@example.test'],
      bcc: ['blind@example.test'],
    });
    const text = raw.toString();
    const headerBlock = text.split('\r\n\r\n')[0];

    expect(headerBlock).not.toMatch(/^Bcc:/im);
    // The blind address must appear nowhere in the message a recipient could read.
    expect(text).not.toContain('blind@example.test');
    expect(headerBlock).toMatch(/^To: visible@example\.test\r?$/im);
    expect(headerBlock).toMatch(/^Cc: copy@example\.test\r?$/im);
    // But it must reach the envelope, which is where it belongs.
    expect(envelope).toEqual({
      from: 'sam@inboxora.test',
      to: ['visible@example.test', 'copy@example.test', 'blind@example.test'],
    });
  });

  it('renders a blind-only message without inventing a To header', async () => {
    const { raw, envelope } = await renderSmtpMessage({ ...base, to: [], bcc: ['blind@example.test'] });
    const headerBlock = raw.toString().split('\r\n\r\n')[0];
    expect(headerBlock).not.toMatch(/^To:/im);
    expect(headerBlock).not.toMatch(/^Bcc:/im);
    expect(envelope.to).toEqual(['blind@example.test']);
  });

  it('preserves Reply-To, In-Reply-To, References and priority', async () => {
    const { raw } = await renderSmtpMessage({
      ...base,
      replyTo: { email: 'replies@example.test' },
      inReplyTo: '<parent@example.test>',
      references: '<root@example.test> <parent@example.test>',
      priority: 'high',
    });
    const headerBlock = raw.toString().split('\r\n\r\n')[0];
    expect(headerBlock).toMatch(/^Reply-To: replies@example\.test\r?$/im);
    expect(headerBlock).toMatch(/^In-Reply-To: <parent@example\.test>\r?$/im);
    expect(headerBlock).toContain('<root@example.test>');
    expect(headerBlock).toMatch(/^X-Priority: 1/im);
  });

  it('keeps an inline image as a cid part and an attachment as a file part', async () => {
    const { raw } = await renderSmtpMessage({
      ...base,
      htmlBody: '<p>Body <img src="cid:logo@inboxora"></p>',
      attachments: [
        { filename: 'logo.png', content: Buffer.from('PNGDATA'), contentType: 'image/png', cid: 'logo@inboxora', contentDisposition: 'inline' },
        { filename: 'report.pdf', content: Buffer.from('PDFDATA'), contentType: 'application/pdf' },
      ],
    });
    const text = raw.toString();
    // The exact rendering is nodemailer's (names unquoted), asserted as it is rather than as assumed.
    expect(text).toContain('Content-ID: <logo@inboxora>');
    expect(text).toContain('Content-Disposition: inline; filename=logo.png');
    expect(text).toContain('Content-Disposition: attachment; filename=report.pdf');
    expect(text).toContain('name=report.pdf');
  });

  it('sends CRLF line endings, and uses the model’s message id', async () => {
    const { raw } = await renderSmtpMessage(base);
    expect(raw.toString()).toContain('Message-ID: <fixed@inboxora.test>');
    expect(raw.toString()).toContain('\r\n');
    expect(raw.toString()).not.toMatch(/[^\r]\n/);
  });

  it('keeps the options it hands the transport consistent with the rendered artefact', async () => {
    const { mailOptions, envelope } = await renderSmtpMessage({ ...base, bcc: ['blind@example.test'] });
    // The transport is given the envelope explicitly, so it cannot re-derive one from headers that
    // deliberately do not mention the blind recipient.
    expect(mailOptions.envelope).toEqual(envelope);
    expect(mailOptions.from).toBe('Sam <sam@inboxora.test>');
    expect(mailOptions.text).toBe('Plain body');
  });
});
