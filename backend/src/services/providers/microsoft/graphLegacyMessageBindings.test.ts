import { describe, expect, it, vi } from 'vitest';
import { bindVerifiedLegacyGraphMessage, resolveGraphMessageIdentity } from './graphLegacyMessageBindings.js';

describe('Graph legacy message bindings', () => {
  it('uses a verified alias only for its exact account and connection', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ canonical_message_id: 'native-1', provider_message_id: 'graph-1' }] });
    await expect(resolveGraphMessageIdentity({ query }, {
      messageId: 'legacy-1', accountId: 'account-1', connectionId: 'connection-1', directProviderMessageId: null,
    })).resolves.toEqual({ kind: 'resolved', canonicalMessageId: 'native-1', providerMessageId: 'graph-1' });
    expect(String(query.mock.calls[0]?.[0])).toContain('b.account_id = $2 AND b.connection_id = $3');
  });

  it('does not turn a missing or ambiguous alias into a Graph id', async () => {
    await expect(resolveGraphMessageIdentity({ query: vi.fn().mockResolvedValue({ rows: [] }) }, {
      messageId: 'legacy-1', accountId: 'account-1', connectionId: 'connection-1', directProviderMessageId: null,
    })).resolves.toEqual({ kind: 'identity_missing' });
    await expect(resolveGraphMessageIdentity({ query: vi.fn() }, {
      messageId: 'legacy-1', accountId: 'account-1', connectionId: null, directProviderMessageId: null,
    })).resolves.toEqual({ kind: 'account_connection_missing' });
  });

  it('binds only one candidate corroborated by RFC id, sender and date', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'legacy-1' }] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(bindVerifiedLegacyGraphMessage({ query }, {
      accountId: 'account-1', connectionId: 'connection-1', canonicalMessageId: 'native-1', providerMessageId: 'graph-1',
      rfcMessageId: '<x@example.test>', fromEmail: 'sender@example.test', date: '2026-09-23T09:00:00Z',
    })).resolves.toBe('bound');
    expect(String(query.mock.calls[0]?.[0])).toContain('m.from_email IS NOT DISTINCT FROM $3');
    expect(String(query.mock.calls[0]?.[0])).toContain('m.date IS NOT DISTINCT FROM $4::timestamptz');
  });

  it('fails closed for duplicate or absent RFC candidates', async () => {
    const ambiguous = vi.fn().mockResolvedValue({ rows: [{ id: 'legacy-1' }, { id: 'legacy-2' }] });
    await expect(bindVerifiedLegacyGraphMessage({ query: ambiguous }, {
      accountId: 'account-1', connectionId: 'connection-1', canonicalMessageId: 'native-1', providerMessageId: 'graph-1',
      rfcMessageId: '<x@example.test>', fromEmail: 'sender@example.test', date: '2026-09-23T09:00:00Z',
    })).resolves.toBe('ambiguous');
    await expect(bindVerifiedLegacyGraphMessage({ query: vi.fn() }, {
      accountId: 'account-1', connectionId: 'connection-1', canonicalMessageId: 'native-1', providerMessageId: 'graph-1',
      rfcMessageId: null, fromEmail: 'sender@example.test', date: '2026-09-23T09:00:00Z',
    })).resolves.toBe('none');
  });
});
