import { describe, it, expect, vi, beforeEach } from 'vitest';

// The dispatch must follow the account that OWNS the message, not the one sending it, and a native
// Graph source must never reach the IMAP fetcher. That last one is the defect this exists to prevent:
// the route used to call `imapManager.fetchAttachment` unconditionally, so forwarding from a Graph
// account opened an IMAP connection for a mailbox that has no IMAP session.
const graphFetch = vi.hoisted(() => vi.fn(async () => Buffer.from('graph-bytes')));
vi.mock('./providers/microsoft/graphMailBody.js', () => ({ fetchGraphAttachmentBytes: graphFetch }));
vi.mock('./providerAuthService.js', () => ({ microsoftConfigFromEnv: () => ({ clientId: 'client-1' }) }));

import { fetchSourceAttachment, SourceAttachmentError } from './sourceAttachments.js';

const imapAccount = { id: 'acct-imap', user_id: 'user-1', mail_transport: 'imap_smtp' };
const graphAccount = { id: 'acct-graph', user_id: 'user-1', mail_transport: 'microsoft_graph', provider_connection_id: 'connection-1' };
const imapMessage = { uid: 42, folder: 'INBOX' };
const graphMessage = { uid: 7, folder: 'Inbox', provider_message_id: 'AAMkAD-1' };

let imap: ReturnType<typeof vi.fn>;

beforeEach(() => {
  graphFetch.mockClear();
  imap = vi.fn(async () => Buffer.from('imap-bytes'));
});

describe('fetchSourceAttachment', () => {
  it('IMAP source → IMAP sender reads over IMAP', async () => {
    const bytes = await fetchSourceAttachment({
      account: imapAccount, message: imapMessage, attachment: { part: '2' }, imap: imap as never,
    });
    expect(bytes.toString()).toBe('imap-bytes');
    expect(imap).toHaveBeenCalledTimes(1);
    expect(graphFetch).not.toHaveBeenCalled();
  });

  it('IMAP source → Graph sender still reads over IMAP (dispatch follows the source)', async () => {
    // The sender's transport is not the input: this call passes the IMAP source account, and a Graph
    // sender would reach this same helper with the same account.
    const bytes = await fetchSourceAttachment({
      account: imapAccount, message: imapMessage, attachment: { part: '2' }, imap: imap as never,
    });
    expect(bytes.toString()).toBe('imap-bytes');
    expect(graphFetch).not.toHaveBeenCalled();
  });

  it('Graph source → IMAP sender reads over Graph and never opens IMAP', async () => {
    const bytes = await fetchSourceAttachment({
      account: graphAccount, message: graphMessage, attachment: { part: 'AAMkAD-att-1' }, imap: imap as never,
    });
    expect(bytes.toString()).toBe('graph-bytes');
    expect(imap).not.toHaveBeenCalled();
    const [api, providerMessageId, attachmentId] = graphFetch.mock.calls[0] as unknown as [unknown, string, string];
    expect(providerMessageId).toBe('AAMkAD-1');
    expect(attachmentId).toBe('AAMkAD-att-1');
    expect((api as { connectionId: string }).connectionId).toBe('connection-1');
  });

  it('Graph source → Graph sender reads over Graph and never opens IMAP', async () => {
    await fetchSourceAttachment({
      account: graphAccount, message: graphMessage, attachment: { part: 'AAMkAD-att-2' }, imap: imap as never,
    });
    expect(graphFetch).toHaveBeenCalledTimes(1);
    expect(imap).not.toHaveBeenCalled();
  });

  it('refuses a Graph source with no provider identity rather than trying IMAP', async () => {
    await expect(fetchSourceAttachment({
      account: graphAccount, message: { uid: 7, folder: 'Inbox' }, attachment: { part: 'x' }, imap: imap as never,
    })).rejects.toBeInstanceOf(SourceAttachmentError);
    expect(imap).not.toHaveBeenCalled();
    expect(graphFetch).not.toHaveBeenCalled();
  });

  it('names an unimplemented transport instead of serving it over IMAP', async () => {
    const gmailApi = { id: 'acct-g', user_id: 'user-1', mail_transport: 'gmail_api' };
    await expect(fetchSourceAttachment({
      account: gmailApi, message: imapMessage, attachment: { part: '2' }, imap: imap as never,
    })).rejects.toMatchObject({ code: 'OPERATION_FORBIDDEN', status: 501 });
    expect(imap).not.toHaveBeenCalled();
  });

  it('reports a failed read as a fetch failure the caller can name', async () => {
    imap = vi.fn(async () => null);
    await expect(fetchSourceAttachment({
      account: imapAccount, message: imapMessage, attachment: { part: '2', filename: 'x.pdf' }, imap: imap as never,
    })).rejects.toMatchObject({ code: 'ATTACHMENT_FETCH_FAILED', status: 502 });
  });
});
