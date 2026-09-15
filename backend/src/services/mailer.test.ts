import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn() }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn() }));
vi.mock('./smtpTransport.js', () => ({ createSmtpTransport: vi.fn() }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));

import { sendSystemEmail } from './mailer.js';
import { query as __mock_query } from './db.js';
import { decrypt as __mock_decrypt } from './encryption.js';
import { resolveForConnection as __mock_resolveForConnection } from './hostValidation.js';
import { createSmtpTransport as __mock_createSmtpTransport } from './smtpTransport.js';
import { getConnectionPolicy as __mock_getConnectionPolicy } from './connectionPolicy.js';

// Cast mocked module exports so their vitest mock helpers type-check.
const query = vi.mocked(__mock_query);
const decrypt = vi.mocked(__mock_decrypt);
const resolveForConnection = vi.mocked(__mock_resolveForConnection);
const createSmtpTransport = vi.mocked(__mock_createSmtpTransport);
const getConnectionPolicy = vi.mocked(__mock_getConnectionPolicy);

const CONFIG = {
  host: 'mail.internal.lan',
  port: 587,
  tls: 'STARTTLS',
  user: 'system@internal.lan',
  pass: 'ENCRYPTED',
  fromName: 'MailFlow',
  fromEmail: 'system@internal.lan',
};

// #358: the System Email path must honor the admin's "Allow private / local hosts" policy,
// exactly as the personal-account path does. Previously it resolved the host with the
// default allowPrivate:false, so a self-hosted relay on a private IP was rejected even with
// the toggle on — and sendSystemEmail (verification/2FA codes, invites) has no fallback, so
// those emails hard-failed.
describe('sendSystemEmail honors allow-private-hosts policy (#358)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    query.mockResolvedValue({ rows: [{ value: JSON.stringify(CONFIG) }] });
    decrypt.mockReturnValue('smtp-secret');
    resolveForConnection.mockResolvedValue({ host: '10.0.0.5', servername: null });
    createSmtpTransport.mockReturnValue({ sendMail: vi.fn().mockResolvedValue({}), verify: vi.fn() });
  });

  it('passes allowPrivate:true through to host resolution when the policy allows it', async () => {
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: false, allowNonstandardPorts: false });

    await sendSystemEmail({ to: 'user@example.com', subject: 'Hi', text: 'body' });

    expect(resolveForConnection).toHaveBeenCalledWith('mail.internal.lan', { allowPrivate: true });
  });

  it('passes allowPrivate:false when the policy disallows private hosts', async () => {
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: false, allowInsecureTls: false, allowNonstandardPorts: false });

    await sendSystemEmail({ to: 'user@example.com', subject: 'Hi', text: 'body' });

    expect(resolveForConnection).toHaveBeenCalledWith('mail.internal.lan', { allowPrivate: false });
  });

  it('surfaces a private-host rejection from resolution rather than swallowing it', async () => {
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: false, allowInsecureTls: false, allowNonstandardPorts: false });
    resolveForConnection.mockRejectedValue(new Error('Host resolves to a private or reserved IP address'));

    await expect(sendSystemEmail({ to: 'user@example.com', subject: 'Hi', text: 'body' }))
      .rejects.toThrow(/private or reserved/i);
    expect(createSmtpTransport).not.toHaveBeenCalled();
  });
});
