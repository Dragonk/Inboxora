import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockRequest, mockResponse } from '../test/http.js';

vi.mock('../services/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: { session?: { userId: string } }, _res: unknown, next: () => void) => {
    req.session = { userId: 'owner' }; next();
  },
}));
vi.mock('../index.js', () => ({ imapManager: { connectAccount: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('../services/connectionPolicy.js', () => ({
  getConnectionPolicy: async () => ({ allowPrivateHosts: false, allowNonstandardPorts: false }),
}));
import 'express-async-errors';
import express from 'express';
import { query as dbQuery } from '../services/db.js';
import { pluginRegistry } from '../plugins/registry.js';
import accountRoutes from './accounts.js';

const query = vi.mocked(dbQuery);
const id = '11111111-1111-4111-8111-111111111111';
const initial = { id, name: 'Mailbox', default_cc: ['old@example.com'], default_bcc: ['private@example.com'] };
let saved: Record<string, unknown>;
let owned: boolean;

const app = express();
app.use('/api/accounts', accountRoutes);

beforeEach(() => {
  owned = true;
  saved = { ...initial };
  query.mockReset();
  vi.spyOn(pluginRegistry, 'collectHook').mockResolvedValue([]);
  query.mockImplementation(async (sql, params = []) => {
    if (sql.startsWith('SELECT id FROM email_accounts')) return { rows: owned ? [{ id }] : [] };
    if (sql.includes('FROM account_aliases')) return { rows: [{ id: 'alias', account_id: id, email: 'alias@example.com' }] };
    if (sql.includes('INSERT INTO email_accounts')) {
      saved = { ...initial, default_cc: params[21], default_bcc: params[22] };
      return { rows: [{ ...saved, auth_pass: 'secret', oauth_access_token: 'token' }] };
    }
    if (sql.startsWith('UPDATE email_accounts')) {
      for (const match of sql.matchAll(/(\w+) = \$(\d+)/g)) {
        if (match[1] !== 'id') saved[match[1]] = params[Number(match[2]) - 1];
      }
      return { rows: [{ ...saved, auth_pass: 'secret', oauth_refresh_token: 'token' }] };
    }
    if (sql.includes('FROM email_accounts')) return { rows: [saved] };
    throw new Error(`Unexpected query: ${sql}`);
  });
});
afterEach(() => vi.restoreAllMocks());

// Dispatch through the mounted Express router without opening a TCP listener.
// The repository's request/response doubles retain middleware and UUID routing.
function request(method: string, body?: unknown): Promise<{ status: number; json: () => Promise<unknown> }> {
  return new Promise((resolve, reject) => {
    const req = mockRequest({ method, url: `/api/accounts${method === 'PUT' ? `/${id}` : ''}`, headers: {}, body });
    const res = mockResponse({
      statusCode: 200,
      setHeader: vi.fn(),
      status(code: number) { this.statusCode = code; return this; },
      json(value: unknown) {
        const serialized: unknown = JSON.parse(JSON.stringify(value));
        resolve({ status: this.statusCode, json: async () => serialized });
        return this;
      },
    });
    app(req, res, (error?: unknown) => reject(error ?? new Error('No mounted route matched')));
  });
}
function expectNoWrites() {
  expect(query.mock.calls.filter(([sql]) => /\b(INSERT|UPDATE|DELETE)\b/.test(sql))).toEqual([]);
  expect(vi.mocked(pluginRegistry.collectHook).mock.calls.some(([name]) => name === 'persistAccountSettings')).toBe(false);
  expect(saved).toEqual(initial);
}
const createBody = { name: 'Mailbox', email_address: 'me@example.com' };

describe('account compose defaults through the mounted router', () => {
  it('GET exposes both arrays with aliases and an owner-scoped safe projection', async () => {
    const response = await request('GET');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ ...initial, aliases: [{ id: 'alias', account_id: id, email: 'alias@example.com' }] }]);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('default_cc, default_bcc');
    expect(sql).toContain('WHERE user_id = $1');
    expect(params).toEqual(['owner']);
    expect(sql).not.toMatch(/auth_pass|oauth_access_token|oauth_refresh_token|SELECT \*/);
  });
  it.each(['POST', 'PUT'])('%s normalizes, deduplicates and retains overlap without secrets', async method => {
    const response = await request(method, { ...createBody,
      default_cc: [' One@Example.com ', 'two@example.com', 'ONE@example.com'],
      default_bcc: ['TWO@example.com', ' Private@example.com '],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...initial, default_cc: ['one@example.com', 'two@example.com'], default_bcc: ['two@example.com', 'private@example.com'] });
    expect(saved.default_cc).toEqual(['one@example.com', 'two@example.com']);
    expect(saved.default_bcc).toEqual(['two@example.com', 'private@example.com']);
  });
  it('POST omission supplies empty defaults', async () => {
    const response = await request('POST', createBody);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ default_cc: [], default_bcc: [] });
  });
  it('PUT omission preserves both fields and empty arrays clear each independently', async () => {
    expect((await request('PUT', { name: 'Renamed' })).status).toBe(200);
    expect(saved).toEqual({ ...initial, name: 'Renamed' });
    expect((await request('PUT', { default_cc: [] })).status).toBe(200);
    expect(saved.default_cc).toEqual([]);
    expect(saved.default_bcc).toEqual(initial.default_bcc);
    expect((await request('PUT', { default_bcc: [] })).status).toBe(200);
    expect(saved.default_bcc).toEqual([]);
  });
  it('rejects unowned accounts before any write', async () => {
    owned = false;
    expect((await request('PUT', { default_cc: [] })).status).toBe(404);
    expect(query).toHaveBeenCalledExactlyOnceWith('SELECT id FROM email_accounts WHERE id = $1 AND user_id = $2', [id, 'owner']);
    expectNoWrites();
  });
  it.each(['default_cc', 'default_bcc'])('accepts 50 distinct addresses for %s', async field => {
    const addresses = Array.from({ length: 50 }, (_, i) => `person${i}@example.com`);
    expect((await request('PUT', { [field]: addresses })).status).toBe(200);
    expect(saved[field]).toEqual(addresses);
  });
  const invalid: unknown[] = [null, '', {}, 42, true, [null], [42], [{}], [[]], [''], [' '],
    ['Name <a@example.com>'], ['<a@example.com>'], ['Friends:a@example.com;'],
    ['a@example.com,b@example.com'], ['a@@example.com'], ['a..b@example.com'], ['a@-example.com'],
    ['a@example..com'], ['a@'], ['a b@example.com'], ['a@example.com (Name)'],
    ['a'.repeat(65) + '@example.com'], ['a@' + 'b'.repeat(64) + '.com'],
    ['a@' + ['b'.repeat(63), 'c'.repeat(63), 'd'.repeat(63), 'e'.repeat(61)].join('.')],
    Array(51).fill('a@example.com'),
    ...['\r', '\n', '\0', '\t', '\x01', '\x1f', '\x7f', '\u0085', '\u2028', '\u2029', '\u200b'].map(c => [`${c}a@example.com`]),
    ['a@example.com\r\nBcc: hidden@example.com'], ['a@example.com\n'],
  ];
  for (const method of ['POST', 'PUT']) {
    for (const field of ['default_cc', 'default_bcc']) {
      it.each(invalid.map(value => ({ value })))(`${method} rejects invalid ${field} without partial writes: $value`, async ({ value }) => {
        const response = await request(method, { ...createBody, name: 'Changed', default_cc: ['valid@example.com'], default_bcc: ['valid@example.com'], [field]: value });
        expect(response.status).toBe(400);
        expectNoWrites();
      });
    }
  }
});
