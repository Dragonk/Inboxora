import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
const { query } = vi.mocked(await import('./db.js'));
import { resolveSenderIdentity } from './senderIdentity.js';
import type { EmailAccountRow } from './imapManager.js';

const account = { id: 'account-a', name: 'Main', sender_name: 'Main Sender', email_address: 'main@example.test', signature: '<p>main</p>' } as EmailAccountRow;

beforeEach(() => query.mockReset());

describe('resolveSenderIdentity', () => {
  it('uses the account identity when no alias was selected', async () => {
    await expect(resolveSenderIdentity(account)).resolves.toMatchObject({ aliasId: null, fromEmail: 'main@example.test', fromSignature: '<p>main</p>' });
    expect(query).not.toHaveBeenCalled();
  });

  it('uses a scoped alias and inherits only its null signature', async () => {
    query.mockResolvedValueOnce({ rows: [{ name: 'Alias', email: 'alias@example.test', reply_to: 'reply@example.test', signature: null }] });
    await expect(resolveSenderIdentity(account, 'alias-a')).resolves.toMatchObject({ aliasId: 'alias-a', fromEmail: 'alias@example.test', fromReplyTo: 'reply@example.test', fromSignature: '<p>main</p>' });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('account_id = $2'), ['alias-a', 'account-a']);
  });

  it('rejects a missing or foreign alias instead of falling back', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await expect(resolveSenderIdentity(account, 'alias-other')).rejects.toMatchObject({ status: 409 });
  });
});
