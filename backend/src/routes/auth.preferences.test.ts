import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockRequest, mockResponse, mockSession } from '../test/http.js';

vi.mock('../services/db.js', () => ({ query: vi.fn(), pool: {} }));
vi.mock('../index.js', () => ({
  imapManager: {
    updateSyncIntervalForUser: vi.fn(),
    updateFolderSyncIntervalForUser: vi.fn(),
  },
}));
vi.mock('../services/encryption.js', () => ({
  decrypt: (value: unknown) => value,
  encrypt: (value: unknown) => value,
}));
vi.mock('../services/pushNotifications.js', () => ({ pushConfigured: false }));
vi.mock('../services/hostValidation.js', () => ({
  validateHost: vi.fn(),
  resolveForConnection: vi.fn(),
}));
vi.mock('../services/connectionPolicy.js', () => ({
  getConnectionPolicy: vi.fn(),
}));
vi.mock('../services/authLimiter.js', () => ({
  authLimiterConfig: { maxRequests: 10, windowMs: 900000 },
}));
vi.mock('../services/authEvents.js', () => ({ logAuthEvent: vi.fn() }));
vi.mock('../services/mailer.js', () => ({ sendSystemEmail: vi.fn() }));
vi.mock('./oidc.js', () => ({ buildEndSessionUrl: vi.fn() }));
vi.mock('../services/categorizer.js', () => ({
  invalidateGlobalCategorizationCache: vi.fn(),
}));
vi.mock('../services/redis.js', () => ({ redisClient: {} }));
vi.mock('../services/rateLimiter.js', () => ({
  consume: vi.fn(),
  reset: vi.fn(),
}));

import { query as __mock_query } from '../services/db.js';
import { patchPreferences } from './auth.js';

// Cast mocked module exports so their vitest mock helpers type-check.
const query = vi.mocked(__mock_query);

// `query` declares its params argument with a default (`params: unknown[] = []`),
// so a recorded mock call types that tuple element as optional. The route handlers
// under test always pass a params array, so state that contract here rather than
// asserting on the optional element.
function recordedQueryCall(callIndex: number): [sql: string, params: unknown[]] {
  const call = query.mock.calls[callIndex];
  const params = call[1];
  if (params === undefined) {
    throw new Error(`query call ${callIndex} was not passed params`);
  }
  return [call[0], params];
}

beforeEach(() => {
  query.mockReset().mockResolvedValue({ rows: [] });
});

describe('PATCH /auth/preferences folderOrder', () => {
  it('merges folderOrder into existing preferences as JSONB', async () => {
    const folderOrder = { 'account-1': ['Archive', 'INBOX'] };
    const req = mockRequest({ session: { userId: 'user-1' }, body: { folderOrder } });
    const res = mockResponse({
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    });

    await patchPreferences(req, res);

    const [sql, params] = recordedQueryCall(0);
    expect(sql).toContain('SET preferences = preferences');
    expect(sql).toContain(
      "jsonb_build_object('folderOrder', $38::jsonb)",
    );
    expect(params[0]).toBe('user-1');
    expect(params[37]).toBe(JSON.stringify(folderOrder));
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });
});

describe('PATCH /auth/preferences senderFavicons', () => {
  it('merges the senderFavicons boolean into preferences as JSONB', async () => {
    const req = mockRequest({ session: { userId: 'user-1' }, body: { senderFavicons: true } });
    const res = mockResponse({
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    });

    await patchPreferences(req, res);

    const [sql, params] = recordedQueryCall(0);
    expect(sql).toContain(
      "jsonb_build_object('senderFavicons', $39::boolean)",
    );
    expect(params[0]).toBe('user-1');
    expect(params[38]).toBe(true);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it('rejects a non-boolean senderFavicons without querying', async () => {
    const req = mockRequest({ session: { userId: 'user-1' }, body: { senderFavicons: 'yes' } });
    const res = mockResponse({
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    });

    await patchPreferences(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'senderFavicons must be a boolean' });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('PATCH /auth/preferences obsolete favicon badge', () => {
  it('does not persist the removed favicon badge preference', async () => {
    const req = mockRequest({ session: { userId: 'user-1' }, body: { showFaviconBadge: true } });
    const res = mockResponse({
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    });

    await patchPreferences(req, res);

    const [sql, params] = recordedQueryCall(0);
    expect(sql).not.toContain('showFaviconBadge');
    expect(params).not.toContain(true);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });
});

describe('PATCH /auth/preferences calendar preferences', () => {
  it('rejects invalid work-day and working-hour preferences without querying', async () => {
    const res = mockResponse({ status: vi.fn().mockReturnThis(), json: vi.fn() });
    await patchPreferences(mockRequest({ session: { userId: 'user-1' }, body: { calendarWorkDays: [1, 1] } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(query).not.toHaveBeenCalled();

    res.status.mockClear(); res.json.mockClear();
    await patchPreferences(mockRequest({ session: { userId: 'user-1' }, body: { calendarWorkHoursStart: '9:00' } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('serializes valid work-day and working-hour preferences into JSONB', async () => {
    const res = mockResponse({ status: vi.fn().mockReturnThis(), json: vi.fn() });
    await patchPreferences(mockRequest({ session: mockSession({ userId: 'user-1' }), body: {
      calendarWorkDays: [1, 2, 3, 4, 5], calendarWorkHoursStart: '08:30', calendarWorkHoursEnd: '17:30',
    } }), res);
    const [sql, params] = recordedQueryCall(0);
    expect(sql).toContain("jsonb_build_object('calendarWorkDays', $46::jsonb)");
    expect(sql).toContain("jsonb_build_object('calendarWorkHoursStart', $47::text)");
    expect(sql).toContain("jsonb_build_object('calendarWorkHoursEnd', $48::text)");
    expect(params[45]).toBe(JSON.stringify([1, 2, 3, 4, 5]));
    expect(params[46]).toBe('08:30');
    expect(params[47]).toBe('17:30');
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it('rejects equal and reversed effective working-hour ranges without querying', async () => {
    const res = mockResponse({ status: vi.fn().mockReturnThis(), json: vi.fn() });
    await patchPreferences(mockRequest({ session: { userId: 'user-1' }, body: { calendarWorkHoursStart: '17:00', calendarWorkHoursEnd: '09:00' } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(query).not.toHaveBeenCalled();

    res.status.mockClear(); res.json.mockClear();
    await patchPreferences(mockRequest({ session: { userId: 'user-1' }, body: { calendarWorkHoursStart: '09:00', calendarWorkHoursEnd: '09:00' } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('uses the persisted counterpart for a partial work-hour update', async () => {
    query.mockResolvedValueOnce({ rows: [{ preferences: { calendarWorkHoursStart: '08:00', calendarWorkHoursEnd: '17:00' } }] }).mockResolvedValueOnce({ rows: [] });
    const res = mockResponse({ status: vi.fn().mockReturnThis(), json: vi.fn() });
    await patchPreferences(mockRequest({ session: { userId: 'user-1' }, body: { calendarWorkHoursStart: '18:00' } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('persists a valid partial update with its persisted counterpart', async () => {
    query.mockResolvedValueOnce({ rows: [{ preferences: { calendarWorkHoursStart: '08:00', calendarWorkHoursEnd: '17:00' } }] }).mockResolvedValueOnce({ rows: [] });
    const res = mockResponse({ status: vi.fn().mockReturnThis(), json: vi.fn() });
    await patchPreferences(mockRequest({ session: { userId: 'user-1' }, body: { calendarWorkHoursEnd: '18:00' } }), res);
    const [, params] = recordedQueryCall(1);
    expect(params[46]).toBe('08:00');
    expect(params[47]).toBe('18:00');
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it('repairs a legacy invalid pair during a normal one-control update', async () => {
    query.mockResolvedValueOnce({ rows: [{ preferences: { calendarWorkHoursStart: '17:00', calendarWorkHoursEnd: '09:00' } }] }).mockResolvedValueOnce({ rows: [] });
    const res = mockResponse({ status: vi.fn().mockReturnThis(), json: vi.fn() });
    await patchPreferences(mockRequest({ session: { userId: 'user-1' }, body: { calendarWorkHoursEnd: '18:00' } }), res);
    const [, params] = recordedQueryCall(1);
    expect(params[46]).toBe('09:00');
    expect(params[47]).toBe('18:00');
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it('rejects an unsupported first day of week without querying', async () => {
    const req = mockRequest({ session: { userId: 'user-1' }, body: { calendarWeekStartsOn: 4 } });
    const res = mockResponse({ status: vi.fn().mockReturnThis(), json: vi.fn() });

    await patchPreferences(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'calendarWeekStartsOn must be 0 or 1' });
    expect(query).not.toHaveBeenCalled();
  });

  it('persists validated calendar view preferences as JSONB', async () => {
    const req = mockRequest({ session: { userId: 'user-1' }, body: { calendarWeekStartsOn: 0, mobileNavigationPosition: 'bottom', visibleCalendarIds: ['personal', 'contacts-birthdays'] } });
    const res = mockResponse({ status: vi.fn().mockReturnThis(), json: vi.fn() });

    await patchPreferences(req, res);

    const [sql, params] = recordedQueryCall(0);
    expect(sql).toContain("jsonb_build_object('calendarWeekStartsOn'");
    expect(sql).toContain("jsonb_build_object('mobileNavigationPosition'");
    expect(sql).toContain("jsonb_build_object('visibleCalendarIds'");
    expect(params).toContain(0);
    expect(params).toContain('bottom');
    expect(params).toContain(JSON.stringify(['personal', 'contacts-birthdays']));
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it('persists the mobile drawer swipe preference as a boolean', async () => {
    const req = mockRequest({ session: { userId: 'user-1' }, body: { mobileSidebarSwipeEnabled: false } });
    const res = mockResponse({ status: vi.fn().mockReturnThis(), json: vi.fn() });

    await patchPreferences(req, res);

    const [sql, params] = recordedQueryCall(0);
    expect(sql).toContain("jsonb_build_object('mobileSidebarSwipeEnabled'");
    expect(params).toContain(false);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it('rejects a non-boolean mobile drawer swipe preference', async () => {
    const req = mockRequest({ session: { userId: 'user-1' }, body: { mobileSidebarSwipeEnabled: 'yes' } });
    const res = mockResponse({ status: vi.fn().mockReturnThis(), json: vi.fn() });

    await patchPreferences(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'mobileSidebarSwipeEnabled must be a boolean' });
    expect(query).not.toHaveBeenCalled();
  });

  it('leaves the drawer preference absent when the client omits it', async () => {
    const req = mockRequest({ session: { userId: 'user-1' }, body: { calendarWeekStartsOn: 1 } });
    const res = mockResponse({ status: vi.fn().mockReturnThis(), json: vi.fn() });

    await patchPreferences(req, res);

    const [, params] = recordedQueryCall(0);
    expect(params[51]).toBe(null);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });
});
