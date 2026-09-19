import { describe, it, expect, vi, beforeEach } from 'vitest';

// The seam exists so the Graph transport is a branch in one place rather than a second
// pipeline inside the send route. These cases pin the two properties the route depends
// on: a native account is refused (by the SMTP factory, not by a second guard here), and
// every other account reaches SMTP unchanged, keeping the account type it passed in.
vi.mock('./smtpTransport.js', () => ({ createAccountSmtpTransport: vi.fn() }));

import { createAccountMailTransport } from './sendTransport.js';
import { createAccountSmtpTransport } from './smtpTransport.js';

const smtp = vi.mocked(createAccountSmtpTransport);

beforeEach(() => smtp.mockReset());

describe('binding a send to a transport', () => {
  it('passes an ordinary account through to SMTP', async () => {
    smtp.mockResolvedValue({ transport: { sendMail: vi.fn() } } as never);
    const account = { id: 'acct-1', user_id: 'user-1', email_address: 'sam@contoso.test', smtp_host: 'smtp.test' };

    const result = await createAccountMailTransport(account);
    expect(smtp).toHaveBeenCalledWith(account);
    expect(result).toHaveProperty('transport');
  });

  it('still refuses a Microsoft Graph account, and does so once', async () => {
    // The refusal lives in the SMTP factory so that *no* caller can hand it a native
    // account; this seam must not grow a second copy of the same condition.
    smtp.mockResolvedValue({ status: 501, error: 'not available yet', code: 'OPERATION_FORBIDDEN' } as never);

    const result = await createAccountMailTransport({ id: 'acct-1', mail_transport: 'microsoft_graph' } as never);
    expect(result).toMatchObject({ status: 501, code: 'OPERATION_FORBIDDEN' });
    expect(smtp).toHaveBeenCalledTimes(1);
  });
});
