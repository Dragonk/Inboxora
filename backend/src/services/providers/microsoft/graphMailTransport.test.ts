import { describe, it, expect, vi, beforeEach } from 'vitest';

// The transport is the composition of four already-tested pieces, so these cases are about the sequence
// and the outcome it reports — in particular that a failure before the final send is NOT an unknown send.
const draftMock = vi.hoisted(() => vi.fn(async () => ({ id: 'AAMkAD-draft-1' })));
const replyDraftMock = vi.hoisted(() => vi.fn(async () => ({ id: 'AAMkAD-reply-1' })));
const patchDraftMock = vi.hoisted(() => vi.fn(async () => undefined));
const attachMock = vi.hoisted(() => vi.fn(async () => ({ id: 'att-1', strategy: 'direct' as const })));
const sendMock = vi.hoisted(() => vi.fn(async () => ({ status: 'accepted' as const })));
vi.mock('./graphMailSend.js', () => ({
  createGraphDraft: draftMock,
  createGraphReplyDraft: replyDraftMock,
  patchGraphDraft: patchDraftMock,
  sendGraphDraft: sendMock,
}));
vi.mock('./graphMailAttachments.js', () => ({ addGraphAttachment: attachMock }));

import { graphMailTransport } from './graphMailTransport.js';
import type { ComposedMail } from '../../composedMail.js';

// `config` is omitted so the transport reads the environment's own config, exactly as the seam leaves it.
const api = { userId: 'user-1', connectionId: 'connection-1' };
const composed: ComposedMail = {
  messageId: '<m@x>',
  from: { email: 'sam@contoso.test' },
  to: [{ email: 'visible@example.test' }],
  cc: [],
  bcc: [{ email: 'blind@example.test' }],
  subject: 'Hi',
  plainBody: 'Body',
};

beforeEach(() => {
  draftMock.mockClear(); replyDraftMock.mockClear(); patchDraftMock.mockClear();
  attachMock.mockClear(); sendMock.mockClear();
});

describe('the Graph send transport', () => {
  it('stages a reply with the provider action and patches it before sending', async () => {
    // MAIL-03: the provider's own reply action is what gives the message its threading edge; the JSON payload
    // cannot carry the RFC headers. The composed content replaces the pre-filled draft content afterwards.
    const calls: string[] = [];
    replyDraftMock.mockImplementation(async () => { calls.push('reply'); return { id: 'reply-1' }; });
    patchDraftMock.mockImplementation(async () => { calls.push('patch'); });
    sendMock.mockImplementation(async () => { calls.push('send'); return { status: 'accepted' as const }; });

    const result = await graphMailTransport(api).send({
      composed,
      replyContext: { transport: 'microsoft_graph', kind: 'reply_all', providerMessageId: 'parent-1' },
    });

    expect(calls).toEqual(['reply', 'patch', 'send']);
    expect(replyDraftMock).toHaveBeenCalledWith(expect.anything(), 'parent-1', 'reply_all');
    // The ordinary create path is not used when the send answers a message.
    expect(draftMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'accepted', providerMessageId: 'reply-1' });
  });

  it('creates the draft, adds every attachment, then sends — in that order', async () => {
    const calls: string[] = [];
    draftMock.mockImplementation(async () => { calls.push('draft'); return { id: 'draft-1' }; });
    attachMock.mockImplementation(async () => { calls.push('attach'); return { id: 'att-1', strategy: 'direct' as const }; });
    sendMock.mockImplementation(async () => { calls.push('send'); return { status: 'accepted' as const }; });

    const result = await graphMailTransport(api).send({
      composed: { ...composed, attachments: [{ filename: 'a.bin', content: Buffer.from('x') }] },
    });

    expect(calls).toEqual(['draft', 'attach', 'send']);
    expect(result).toEqual({
      status: 'accepted',
      // The blind recipient reaches the provider as a recipient, and is not a header anywhere.
      accepted: ['visible@example.test', 'blind@example.test'],
      rejected: [],
      providerMessageId: 'draft-1',
    });
  });

  it('reports a provider refusal as refused, with its retryability', async () => {
    sendMock.mockResolvedValue({ status: 'refused', code: 'ErrorAccessDenied', message: 'no', retryable: false } as never);
    await expect(graphMailTransport(api).send({ composed })).resolves.toMatchObject({ status: 'refused', code: 'ErrorAccessDenied' });
  });

  it('reports an unknown send as unknown, and does not send twice', async () => {
    sendMock.mockResolvedValue({ status: 'outcome_unknown', reason: 'socket hang up' } as never);
    const result = await graphMailTransport(api).send({ composed });
    expect(result).toMatchObject({ status: 'outcome_unknown' });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('treats a failure before the final send as a retryable refusal, because nothing has left', async () => {
    sendMock.mockClear();
    draftMock.mockRejectedValueOnce(new Error('graph 500'));
    await expect(graphMailTransport(api).send({ composed })).resolves.toMatchObject({ status: 'refused', code: 'DRAFT_CREATE_FAILED', retryable: true });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('names a failed attachment upload, and still does not send', async () => {
    draftMock.mockResolvedValue({ id: 'draft-1' } as never);
    attachMock.mockRejectedValueOnce(new Error('upload session expired'));
    sendMock.mockClear();
    await expect(graphMailTransport(api).send({ composed: { ...composed, attachments: [{ filename: 'a.bin', content: Buffer.from('x') }] } }))
      .resolves.toMatchObject({ status: 'refused', code: 'ATTACHMENT_UPLOAD_FAILED' });
    expect(sendMock).not.toHaveBeenCalled();
  });
});
