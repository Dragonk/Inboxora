import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGmailDraft,
  deleteGmailUserDraft,
  findGmailDraftIdForMessage,
  saveGmailUserDraft,
} from './gmailMailDrafts.js';
import type { ComposedMail } from '../../composedMail.js';

const tokenMock = vi.hoisted(() => vi.fn(async () => ({
  accessToken: 'google-token-1', expiresAt: new Date(Date.now() + 3600_000), generation: 1, refreshed: false, scopes: [],
})));

vi.mock('../../providerTokenService.js', () => ({ getGoogleAccessToken: tokenMock }));

const OPTIONS = {
  userId: 'user-1',
  connectionId: 'connection-1',
  config: { clientId: 'client-1', clientSecret: 'secret-1', redirectUri: 'https://inboxora.example/cb' },
};

const composed: ComposedMail = {
  messageId: '<draft-1@example.test>',
  from: { email: 'sam@gmail.test' },
  to: [{ email: 'you@example.test', name: 'You' }],
  cc: [],
  bcc: [{ email: 'secret@example.test' }],
  subject: 'Draft',
  plainBody: 'half written',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A `204` cannot carry a body, and the `Response` constructor rejects one. */
function noContent(): Response {
  return { ok: true, status: 204, headers: new Headers(), json: async () => null } as Response;
}

/** The provider's own answer: the draft id wraps a different message id. */
const DRAFT = { id: 'draft-1', message: { id: 'msg-1', threadId: 'thread-1', labelIds: ['DRAFT'] } };

afterEach(() => {
  vi.unstubAllGlobals();
  tokenMock.mockClear();
});

describe('saving a Gmail draft', () => {
  it('creates the draft from the rendered message and reports both identities', async () => {
    const calls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: String(init?.method), body: JSON.parse(String(init?.body)) });
      return jsonResponse(DRAFT);
    }));

    const saved = await createGmailDraft(OPTIONS, composed);
    expect(saved).toEqual({ id: 'draft-1', messageId: 'msg-1', threadId: 'thread-1', created: true });
    expect(calls[0]?.url).toContain('/users/me/drafts');
    expect(calls[0]?.method).toBe('POST');

    // The draft's bytes are the canonical render with the Bcc header intact: a draft is
    // not delivered, and a blind recipient must survive a reload.
    const encoded = String((calls[0]?.body.message as { raw?: string } | undefined)?.raw ?? '');
    const raw = Buffer.from(encoded, 'base64url').toString('utf8');
    expect(raw).toMatch(/^Bcc: secret@example\.test\r$/m);
    expect(Object.keys(calls[0]?.body ?? {})).toEqual(['message']);
  });

  it('patches the existing draft in place rather than leaving two', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: String(init?.method) });
      return jsonResponse(DRAFT);
    }));

    const saved = await saveGmailUserDraft(OPTIONS, composed, { existingDraftId: 'draft-1' });
    expect(saved).toEqual({ id: 'draft-1', messageId: 'msg-1', threadId: 'thread-1', created: false });
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.url).toContain('/users/me/drafts/draft-1');
  });

  it('creates a new draft and reports the superseded one when the saved draft is gone', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url));
      if (calls.length === 1) return jsonResponse({ error: { code: 404, message: 'not found' } }, 404);
      return jsonResponse(DRAFT);
    }));

    const saved = await saveGmailUserDraft(OPTIONS, composed, { existingDraftId: 'draft-gone' });
    expect(saved).toEqual({ id: 'draft-1', messageId: 'msg-1', threadId: 'thread-1', created: true, supersededId: 'draft-gone' });
    expect(calls).toHaveLength(2);
  });

  it('propagates a refusal rather than reporting a save that did not happen', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { code: 403, message: 'insufficient scope', status: 'PERMISSION_DENIED', errors: [{ reason: 'insufficientPermissions' }] } }, 403)));
    await expect(createGmailDraft(OPTIONS, composed)).rejects.toMatchObject({ code: 'INSUFFICIENT_SCOPES' });
  });

  it('reports a create that answered without its identities as a failure, not as success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ id: 'draft-1' })));
    await expect(createGmailDraft(OPTIONS, composed)).rejects.toThrow(/did not return a draft id/);
  });
});

describe('deleting a Gmail draft', () => {
  it('removes it at the provider', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${String(init?.method)} ${String(url)}`);
      return noContent();
    }));
    await expect(deleteGmailUserDraft(OPTIONS, 'draft-1')).resolves.toEqual({ alreadyGone: false });
    expect(calls[0]).toContain('DELETE');
    expect(calls[0]).toContain('/users/me/drafts/draft-1');
  });

  it('treats a draft that is already gone as the end state the caller asked for', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { code: 404, message: 'not found' } }, 404)));
    await expect(deleteGmailUserDraft(OPTIONS, 'draft-1')).resolves.toEqual({ alreadyGone: true });
  });

  it('propagates any other refusal, so the local row is not dropped while Gmail holds the draft', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { code: 500, message: 'backend error' } }, 500)));
    await expect(deleteGmailUserDraft(OPTIONS, 'draft-1')).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  });
});

describe('resolving the draft id from the message identity', () => {
  it('pages until the draft wrapping the message is found', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url));
      if (urls.length === 1) {
        return jsonResponse({ drafts: [{ id: 'other', message: { id: 'msg-9' } }], nextPageToken: 'page-2' });
      }
      return jsonResponse({ drafts: [DRAFT] });
    }));

    await expect(findGmailDraftIdForMessage(OPTIONS, 'msg-1')).resolves.toBe('draft-1');
    expect(urls[1]).toContain('pageToken=page-2');
  });

  it('answers null when no draft wraps the message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ drafts: [{ id: 'other', message: { id: 'msg-9' } }] })));
    await expect(findGmailDraftIdForMessage(OPTIONS, 'msg-1')).resolves.toBeNull();
  });

  it('stops at its page bound instead of paging a mailbox forever', async () => {
    let requests = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      requests += 1;
      return jsonResponse({ drafts: [], nextPageToken: 'always-more' });
    }));
    await expect(findGmailDraftIdForMessage(OPTIONS, 'msg-1')).resolves.toBeNull();
    expect(requests).toBe(10);
  });
});
