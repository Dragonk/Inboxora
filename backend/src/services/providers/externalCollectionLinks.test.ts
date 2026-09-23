import { describe, it, expect, vi, beforeEach } from 'vitest';

const query = vi.hoisted(() => vi.fn());
vi.mock('../db.js', () => ({ query }));
vi.mock('../encryption.js', () => ({ encrypt: (value: string) => `enc:v1:${value}` }));

import {
  ensureExternalCollectionLink,
  ensureExternalSourceConnection,
  externalCollectionKind,
  externalSourceAccess,
  externalSourceFingerprint,
} from './externalCollectionLinks.js';

/**
 * The link an external CalDAV/CardDAV/ICS collection needs before its write-back can be enabled (P02/P10).
 *
 * These cases pin the two rules that keep the row honest: the **source's** permission is recorded and
 * refreshed, and the **user's** choice (`user_access`, `enabled`) is never touched by a sync pass.
 */
describe('the external collection link', () => {
  beforeEach(() => { query.mockReset(); });

  it('treats an ICS subscription as read-only and a CalDAV/CardDAV source as writable at the source', () => {
    expect(externalSourceAccess('ical_url')).toBe('read_only');
    expect(externalSourceAccess('caldav')).toBe('read_write');
    expect(externalSourceAccess('carddav')).toBe('read_write');
    expect(externalCollectionKind('carddav')).toBe('address_book');
    expect(externalCollectionKind('caldav')).toBe('calendar');
    expect(externalCollectionKind('ical_url')).toBe('calendar');
  });

  it('fingerprints a source URL instead of storing it in the clear', () => {
    const fingerprint = externalSourceFingerprint('https://dav.example/calendars/user/');
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // Whitespace is not part of the identity, and two different URLs never share a fingerprint.
    expect(externalSourceFingerprint(' https://dav.example/calendars/user/ ')).toBe(fingerprint);
    expect(externalSourceFingerprint('https://dav.example/other/')).not.toBe(fingerprint);
  });

  it('creates the source connection with an encrypted URL and reuses it on the next pass', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })                    // SELECT source_connections
      .mockResolvedValueOnce({ rows: [{ id: 'source-1' }] })  // INSERT source_connections
    const created = await ensureExternalSourceConnection({
      userId: 'user-1', kind: 'caldav', url: 'https://dav.example/calendars/user/', label: 'Work',
    });
    expect(created).toBe('source-1');
    const insert = query.mock.calls[1];
    expect(String(insert[0])).toContain('INSERT INTO source_connections');
    expect(insert[1]).toEqual([
      'user-1', 'caldav', 'Work', 'enc:v1:https://dav.example/calendars/user/',
      externalSourceFingerprint('https://dav.example/calendars/user/'), null,
    ]);

    query.mockReset();
    query
      .mockResolvedValueOnce({ rows: [{ id: 'source-1' }] })  // SELECT finds it
      .mockResolvedValueOnce({ rows: [] });                   // label refresh
    const again = await ensureExternalSourceConnection({
      userId: 'user-1', kind: 'caldav', url: 'https://dav.example/calendars/user/',
    });
    expect(again).toBe('source-1');
    // No second source connection, and the refresh does not touch the kind or the URL.
    expect(query.mock.calls.some(call => String(call[0]).includes('INSERT INTO source_connections'))).toBe(false);
  });

  it('creates a collection link whose source access is the source’s and whose user access is the user’s', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'source-1' }] })  // SELECT source_connections
      .mockResolvedValueOnce({ rows: [] })                    // UPDATE label
      .mockResolvedValueOnce({ rows: [] })                    // SELECT integration_collections
      .mockResolvedValueOnce({ rows: [{ id: 'collection-1' }] }); // INSERT integration_collections
    const id = await ensureExternalCollectionLink({
      userId: 'user-1', kind: 'carddav', url: 'https://dav.example/addressbooks/user/',
      remoteId: 'https://dav.example/addressbooks/user/', label: 'Contacts', localAddressBookId: 'book-1',
    });
    expect(id).toBe('collection-1');
    const insert = query.mock.calls[3];
    const sql = String(insert[0]);
    expect(sql).toContain('INSERT INTO integration_collections');
    // The user's choice starts at `source` — read-only until they opt in — and DAV publishing starts off.
    expect(sql).toContain("'source', 'off'");
    expect(insert[1]).toEqual([
      'user-1', 'source-1', 'address_book', 'https://dav.example/addressbooks/user/',
      null, 'book-1', 'read_write',
    ]);
  });

  it('refreshes the source’s access without overwriting the user’s opt-in or the collection’s DAV mode', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'source-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'collection-1', local_calendar_id: 'calendar-1', local_address_book_id: null }] })
      .mockResolvedValueOnce({ rows: [] });                   // the refresh UPDATE
    const id = await ensureExternalCollectionLink({
      userId: 'user-1', kind: 'caldav', url: 'https://dav.example/calendars/user/',
      remoteId: 'source:source-1', localCalendarId: 'calendar-1',
    });
    expect(id).toBe('collection-1');
    const update = query.mock.calls[3];
    const sql = String(update[0]);
    expect(sql).toContain('UPDATE integration_collections');
    expect(sql).toContain('source_access = $2');
    // The statement must not name the columns that belong to the user, or a pass would undo their choice.
    expect(sql).not.toContain('user_access =');
    expect(sql).not.toContain('enabled =');
    expect(sql).not.toContain('dav_mode =');
    expect(update[1]).toEqual(['collection-1', 'read_write', 'calendar-1', null, false]);
    // A link that already exists is never inserted a second time.
    expect(query.mock.calls.some(call => String(call[0]).includes('INSERT INTO integration_collections'))).toBe(false);
  });

  it('records an ICS subscription as read-only at the source', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'source-2' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'collection-2' }] });
    await ensureExternalCollectionLink({
      userId: 'user-1', kind: 'ical_url', url: 'https://example.test/holidays.ics',
      remoteId: 'source:source-2', localCalendarId: 'calendar-2',
    });
    expect(query.mock.calls[3][1]?.[6]).toBe('read_only');
  });
});
