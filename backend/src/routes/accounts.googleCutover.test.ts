// Route coverage for the Gmail API half of the in-place mail cutover.
//
// The cutover service itself is covered against real PostgreSQL in
// `providerGoogleMailCutover.integration.test.ts`; here the question is what the HTTP surface does with each
// outcome — the status, the body, whether the IMAP session is torn down, and that the Google service is the
// one asked when the account is a Google account.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { listeningPort } from '../test/net.js';
import type { Server } from 'node:http';
import type { JsonBody } from '../test/json.js';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: { headers: Record<string, string>; session?: { userId?: string } }, _res: unknown, next: () => void) => {
    req.session = { userId: '11111111-1111-1111-1111-111111111111' };
    next();
  },
}));
vi.mock('../index.js', () => ({
  imapManager: {
    connectAccount: vi.fn().mockResolvedValue(true),
    disconnectAccount: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('../services/connectionPolicy.js', () => ({
  getConnectionPolicy: vi.fn().mockResolvedValue({
    allowPrivateHosts: false,
    allowInsecureTls: false,
    allowNonstandardPorts: false,
  }),
}));
// A Google account makes the Microsoft half decline, and the route then asks the Google one.
// The route classifies the account first, with the same service the recommendation uses.
vi.mock('../services/providerAccountClassifier.js', () => ({
  classifyProviderAccount: vi.fn(() => 'google'),
  classifyProviderAccountById: vi.fn(async () => ({ kind: 'google', account: { email_address: 'user@example.test' } })),
  providerConnectionSignals: vi.fn(async () => []),
}));

vi.mock('../services/providerMailCutover.js', () => ({
  cutOverMicrosoftMailAccount: vi.fn(),
}));
vi.mock('../services/providerGoogleMailCutover.js', () => ({
  cutOverGoogleMailAccount: vi.fn(),
}));

import express from 'express';
import accountRoutes from './accounts.js';
import { imapManager as __mock_imapManager } from '../index.js';
import { cutOverMicrosoftMailAccount as __mock_msCutover } from '../services/providerMailCutover.js';
import { cutOverGoogleMailAccount as __mock_googleCutover } from '../services/providerGoogleMailCutover.js';

const imapManager = vi.mocked(__mock_imapManager, true);
const msCutover = vi.mocked(__mock_msCutover);
const googleCutover = vi.mocked(__mock_googleCutover);

const ACCOUNT_ID = '22222222-2222-2222-2222-222222222222';
const CONNECTION_ID = '33333333-3333-3333-3333-333333333333';

const migratedAccount = {
  id: ACCOUNT_ID,
  email_address: 'user@gmail.com',
  mail_transport: 'gmail_api',
  protocol: 'gmail_api',
  provider_connection_id: CONNECTION_ID,
  provider_mailbox_id: 'google-subject',
  migration_state: 'active_native',
  migration_required: false,
  mail_method_preference: 'gmail_api',
  transport_generation: 2,
} as const;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/accounts', accountRoutes);
  return app;
}

describe('POST /api/accounts/:id/migrate for a Google account', () => {
  let server: Server;
  let base = '';

  beforeAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server = buildApp().listen(0, () => resolve());
      server.once('error', reject);
    });
    base = `http://127.0.0.1:${listeningPort(server)}`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  beforeEach(() => {
    msCutover.mockReset();
    googleCutover.mockReset();
    // The account is Google's, so the Microsoft cutover declines and the Google one is asked.
    msCutover.mockResolvedValue({ status: 'not_applicable', reason: 'This account is not a Microsoft account' });
    imapManager.disconnectAccount.mockClear();
  });

  function migrate(body: unknown = {}) {
    return fetch(`${base}/api/accounts/${ACCOUNT_ID}/migrate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('reports a successful in-place switch and tears the IMAP session down', async () => {
    googleCutover.mockResolvedValue({
      status: 'migrated',
      connectionId: CONNECTION_ID,
      account: migratedAccount,
      transitions: [{ from: 'not_applicable', to: 'active_native' }],
      labelsDiscovered: true,
      labels: 7,
    });

    const response = await migrate();
    const body = await response.json() as JsonBody;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true, alreadyNative: false, transport: 'gmail_api', connectionId: CONNECTION_ID, labelsDiscovered: true,
    });
    expect((body.account as JsonBody).mail_transport).toBe('gmail_api');
    // The switch owns the transport now, so no IMAP session may outlive it.
    expect(imapManager.disconnectAccount).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(googleCutover).toHaveBeenCalledWith(expect.objectContaining({ userId: expect.any(String), accountId: ACCOUNT_ID }));
  });

  it('answers an already-native account as an idempotent no-op', async () => {
    googleCutover.mockResolvedValue({
      status: 'already_native', connectionId: CONNECTION_ID, account: migratedAccount, transitions: [],
    });

    const response = await migrate();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, alreadyNative: true, transport: 'gmail_api' });
  });

  it('surfaces the missing Gmail scope and the recorded state', async () => {
    googleCutover.mockResolvedValue({
      status: 'refused', httpStatus: 409, code: 'PROVIDER_AUTH_REQUIRED',
      message: 'The Google grant is missing the scope the Gmail transport needs: gmail.modify',
      missingScopes: ['gmail.modify'], migrationState: 'authorization_required', recorded: true,
    });

    const response = await migrate();

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'PROVIDER_AUTH_REQUIRED', missingScopes: ['gmail.modify'], migrationState: 'authorization_required',
    });
    expect(imapManager.disconnectAccount).not.toHaveBeenCalled();
  });

  it('refuses a connection that belongs to another mailbox with its own code', async () => {
    googleCutover.mockResolvedValue({
      status: 'refused', httpStatus: 409, code: 'ACCOUNT_MIGRATION_IDENTITY_MISMATCH',
      message: 'That connection belongs to other@gmail.com, not to user@gmail.com.', migrationState: null, recorded: false,
    });

    const response = await migrate({ connectionId: CONNECTION_ID });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'ACCOUNT_MIGRATION_IDENTITY_MISMATCH' });
    expect(imapManager.disconnectAccount).not.toHaveBeenCalled();
  });

  it('rejects a malformed connection id before either cutover runs', async () => {
    const response = await migrate({ connectionId: 'not-a-uuid' });

    expect(response.status).toBe(400);
    expect(googleCutover).not.toHaveBeenCalled();
    expect(msCutover).not.toHaveBeenCalled();
  });

  it('reports an account with no native transport as not applicable', async () => {
    googleCutover.mockResolvedValue({ status: 'not_applicable', reason: 'This account is not a Google account' });

    const response = await migrate();

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'ACCOUNT_MIGRATION_NOT_APPLICABLE' });
  });
});
