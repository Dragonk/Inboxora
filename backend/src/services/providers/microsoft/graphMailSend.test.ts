import { describe, it, expect, vi, beforeEach } from 'vitest';

// The renderer is where Microsoft's transport decides how a blind recipient is expressed, so these
// cases assert the payload's recipient groups rather than re-reading the object, and they never log an
// address (a failing assertion prints one, so the assertions compare structures instead).
const tokenMock = vi.hoisted(() => vi.fn(async () => ({
  accessToken: 'graph-token-1', expiresAt: new Date(Date.now() + 3600_000), generation: 1, refreshed: false, scopes: [],
})));
vi.mock('../../providerTokenService.js', () => ({ getMicrosoftAccessToken: tokenMock }));

import { GraphApiError } from './graphApiClient.js';
import { createGraphDraft, renderGraphMessage, sendGraphDraft } from './graphMailSend.js';
import type { ComposedMail } from '../../composedMail.js';

const base: ComposedMail = {
  messageId: '<fixed@inboxora.test>',
  from: { email: 'sam@contoso.test', name: 'Sam' },
  to: ['visible@example.test'],
  cc: [],
  bcc: [],
  subject: 'Subject line',
  plainBody: 'Plain body',
};

const api = (fetchImpl: unknown) => ({ userId: 'user-1', connectionId: 'connection-1', config: { clientId: 'x' }, fetchImpl } as never);

describe('renderGraphMessage', () => {
  it('maps the three recipient groups separately, with the blind recipient as bccRecipients', () => {
    const payload = renderGraphMessage({
      ...base,
      to: ['visible@example.test'],
      cc: ['copy@example.test'],
      bcc: ['blind@example.test'],
    });
    expect(payload.toRecipients).toEqual([{ emailAddress: { address: 'visible@example.test' } }]);
    expect(payload.ccRecipients).toEqual([{ emailAddress: { address: 'copy@example.test' } }]);
    expect(payload.bccRecipients).toEqual([{ emailAddress: { address: 'blind@example.test' } }]);
    // Never folded into another group, and never expressed as a header.
    expect(payload.internetMessageHeaders ?? []).toHaveLength(0);
  });

  it('needs no Bcc header: a blind recipient is representable as data', () => {
    const payload = renderGraphMessage({ ...base, to: [], bcc: ['blind@example.test'] });
    expect(payload.toRecipients).toHaveLength(0);
    expect(payload.bccRecipients).toHaveLength(1);
  });

  it('prefers the HTML body and carries threading as Internet message headers', () => {
    const payload = renderGraphMessage({
      ...base,
      htmlBody: '<p>Rich</p>',
      inReplyTo: '<parent@example.test>',
      references: '<root@example.test> <parent@example.test>',
      headers: { 'X-Inboxora-Operation-Id': 'op-1' },
    });
    expect(payload.body).toEqual({ contentType: 'HTML', content: '<p>Rich</p>' });
    expect(payload.internetMessageHeaders).toEqual([
      { name: 'In-Reply-To', value: '<parent@example.test>' },
      { name: 'References', value: '<root@example.test> <parent@example.test>' },
      { name: 'X-Inboxora-Operation-Id', value: 'op-1' },
    ]);
  });

  it('does not let a caller-supplied header shadow the threading ones', () => {
    const payload = renderGraphMessage({ ...base, inReplyTo: '<parent@example.test>', headers: { 'in-reply-to': '<other@example.test>' } });
    const names = (payload.internetMessageHeaders ?? []).map(header => header.name.toLowerCase());
    expect(names.filter(name => name === 'in-reply-to')).toHaveLength(1);
  });
});

describe('createGraphDraft', () => {
  beforeEach(() => tokenMock.mockClear());

  it('creates a draft and returns the provider id', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: 'AAMkAD-draft-1' }), {
      status: 201, headers: { 'content-type': 'application/json' },
    }));
    const draft = await createGraphDraft(api(fetchImpl), { ...base, bcc: ['blind@example.test'] });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/me/messages');
    expect(init.method).toBe('POST');
    const sent = JSON.parse(String(init.body)) as { bccRecipients: unknown[]; subject: string };
    expect(sent.subject).toBe('Subject line');
    expect(sent.bccRecipients).toHaveLength(1);
    expect(draft.id).toBe('AAMkAD-draft-1');
  });

  it('does not report success when the provider answers without a draft id', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({}), { status: 201, headers: { 'content-type': 'application/json' } }));
    await expect(createGraphDraft(api(fetchImpl), base)).rejects.toThrow('draft id');
  });

  it('surfaces a provider refusal as the classified error rather than a silent draft', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'ErrorAccessDenied', message: 'no' } }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    ));
    await expect(createGraphDraft(api(fetchImpl), base)).rejects.toBeInstanceOf(GraphApiError);
  });
});

// The final send is the non-idempotent step, so these cases are about which answers may be believed. A
// refused send is a fact; a timeout or a 5xx is not, and must come back as unknown rather than as either.
describe('sendGraphDraft', () => {
  beforeEach(() => tokenMock.mockClear());

  it('reports a 202 as accepted', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }));
    await expect(sendGraphDraft(api(fetchImpl), 'AAMkAD-draft-1')).resolves.toEqual({ status: 'accepted' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/me/messages/AAMkAD-draft-1/send');
    expect(init.method).toBe('POST');
  });

  it('reports a read refusal as refused, with retryability from the provider’s own class', async () => {
    const denied = vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'ErrorAccessDenied', message: 'no' } }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    ));
    await expect(sendGraphDraft(api(denied), 'draft-1')).resolves.toMatchObject({ status: 'refused', retryable: false });

    const throttled = vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'TooManyRequests', message: 'later' } }),
      { status: 429, headers: { 'content-type': 'application/json' } },
    ));
    await expect(sendGraphDraft(api(throttled), 'draft-1')).resolves.toMatchObject({ status: 'refused', retryable: true });
  });

  it('never reports success or refusal when the outcome is genuinely unknown', async () => {
    const broken = vi.fn(async () => { throw new Error('socket hang up'); });
    await expect(sendGraphDraft(api(broken), 'draft-1')).resolves.toMatchObject({ status: 'outcome_unknown' });

    const serverError = vi.fn(async () => new Response('oops', { status: 503 }));
    await expect(sendGraphDraft(api(serverError), 'draft-1')).resolves.toMatchObject({ status: 'outcome_unknown' });
  });

  it('does not attempt a second send of its own accord', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('timeout'); });
    await sendGraphDraft(api(fetchImpl), 'draft-1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
