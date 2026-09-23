// PostgreSQL route regression: presentation preferences must be constrained to
// owned durable identities, and hiding (unlike collapsing) changes defaults.
// Run with DB_HOST and DB_NAME set after migrations, for example:
//   DB_HOST=127.0.0.1 DB_NAME=inboxora npx vitest run src/routes/calendarPresentation.integration.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import 'express-async-errors';
import { pool } from '../services/db.js';
import { listeningPort } from '../test/net.js';
import calendarRouter from './calendar.js';

const hasPg = Boolean(process.env.DB_HOST && process.env.DB_NAME);
const describeOrSkip = hasPg ? describe : describe.skip;
const USER_ID = '00000000-0000-0000-0000-00000000c901';
const CALENDAR_ID = '00000000-0000-0000-0000-00000000c902';
const ACCOUNT_ID = '00000000-0000-0000-0000-00000000c903';
const CONNECTION_ID = '00000000-0000-0000-0000-00000000c904';
const IMPORT_SOURCE_ID = '00000000-0000-0000-0000-00000000c905';

function ownedSession(req: express.Request, _res: express.Response, next: express.NextFunction) {
  req.session = { userId: USER_ID } as express.Request['session'];
  next();
}

describeOrSkip('calendar presentation routes (PostgreSQL)', () => {
  let server: Server;
  let base = '';

  beforeAll(async () => {
    await pool.query(`INSERT INTO users (id, username) VALUES ($1, 'calendar-presentation-pg') ON CONFLICT (id) DO NOTHING`, [USER_ID]);
    const app = express();
    app.use(express.json());
    app.use(ownedSession);
    app.use('/api/calendar', calendarRouter);
    await new Promise<void>(resolve => { server = app.listen(0, () => resolve()); });
    base = `http://127.0.0.1:${listeningPort(server)}`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await pool.query('DELETE FROM users WHERE id = $1', [USER_ID]);
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM calendars WHERE user_id = $1', [USER_ID]);
    await pool.query('DELETE FROM calendar_import_sources WHERE user_id = $1', [USER_ID]);
    await pool.query('DELETE FROM email_accounts WHERE user_id = $1', [USER_ID]);
    await pool.query('DELETE FROM provider_connections WHERE user_id = $1', [USER_ID]);
    await pool.query('DELETE FROM user_calendar_source_preferences WHERE user_id = $1', [USER_ID]);
    await pool.query('DELETE FROM user_calendar_presentation_preferences WHERE user_id = $1', [USER_ID]);
    await pool.query(`INSERT INTO calendars (id, user_id, owner_user_id, name, color, display_visible, source, read_only)
      VALUES ($1, $2, $2, 'Personal', '#123456', true, 'local', false)`, [CALENDAR_ID, USER_ID]);
  });

  it('includes configured sources and connected accounts before discovery creates calendars', async () => {
    await pool.query(`INSERT INTO provider_connections (id, user_id, provider, issuer, subject, status)
      VALUES ($1, $2, 'google', 'https://accounts.google.com', 'zero-calendars', 'active')`, [CONNECTION_ID, USER_ID]);
    await pool.query(`INSERT INTO email_accounts (id, user_id, name, email_address, provider_connection_id)
      VALUES ($1, $2, 'Google account', 'long-identity@example.test', $3)`, [ACCOUNT_ID, USER_ID, CONNECTION_ID]);
    await pool.query(`INSERT INTO account_provider_feature_settings (account_id, feature, enabled)
      VALUES ($1, 'calendars', false)`, [ACCOUNT_ID]);
    await pool.query(`INSERT INTO calendar_import_sources (id, user_id, kind, url, url_fingerprint, display_name, enabled)
      VALUES ($1, $2, 'ical_url', 'enc:v1:encrypted', 'source-fingerprint', 'Empty ICS', true)`, [IMPORT_SOURCE_ID, USER_ID]);

    const response = await fetch(`${base}/api/calendar/presentation`);
    const payload = await response.json() as { sources: Array<{ id: string; identityLabel: string | null; featureEnabled: boolean; canSync: boolean }>; groups: Array<{ id: string; calendars: unknown[] }> };
    expect(payload.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `google:account:${ACCOUNT_ID}`, identityLabel: 'long-identity@example.test', featureEnabled: false, canSync: false }),
      expect.objectContaining({ id: `calendar-source:${IMPORT_SOURCE_ID}`, featureEnabled: true, canSync: true }),
    ]));
    expect(payload.groups.find(group => group.id === `google:account:${ACCOUNT_ID}`)?.calendars).toEqual([]);
    expect(payload.groups.find(group => group.id === `calendar-source:${IMPORT_SOURCE_ID}`)?.calendars).toEqual([]);
  });

  it('persists only owned keys and returns the refreshed canonical snapshot', async () => {
    const initial = await fetch(`${base}/api/calendar/presentation`);
    expect(initial.status).toBe(200);
    const payload = await initial.json() as { revision: string; groups: Array<{ id: string; calendars: Array<{ id: string; sidebarHidden: boolean }> }> };
    const local = payload.groups.find(group => group.id === 'local');
    expect(local?.calendars).toEqual(expect.arrayContaining([expect.objectContaining({ id: CALENDAR_ID, sidebarHidden: false })]));

    const hidden = await fetch(`${base}/api/calendar/presentation/calendars/${CALENDAR_ID}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sidebarHidden: true }) });
    expect(hidden.status).toBe(200);
    const refreshed = await hidden.json() as { revision: string; groups: Array<{ id: string; calendars: Array<{ id: string; sidebarHidden: boolean }> }> };
    expect(refreshed.revision).not.toBe(payload.revision);
    expect(refreshed.groups.find(group => group.id === 'local')?.calendars).toEqual(expect.arrayContaining([expect.objectContaining({ id: CALENDAR_ID, sidebarHidden: true })]));
    expect((await pool.query('SELECT sidebar_hidden FROM user_calendar_presentation_preferences WHERE user_id = $1 AND calendar_id = $2', [USER_ID, CALENDAR_ID])).rows).toEqual([{ sidebar_hidden: true }]);

    const foreign = await fetch(`${base}/api/calendar/presentation/calendars/00000000-0000-0000-0000-00000000c999`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sidebarHidden: true }) });
    expect(foreign.status).toBe(404);
  });
});
