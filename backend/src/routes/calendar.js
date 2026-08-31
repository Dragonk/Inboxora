import { Router } from 'express';
import crypto from 'crypto';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const MAX_EVENT_RANGE_DAYS = 366;
const MAX_EVENT_RANGE_MS = MAX_EVENT_RANGE_DAYS * 24 * 60 * 60 * 1000;
router.use(requireAuth);

function parseEventTimes(body) {
  const startsAt = new Date(body?.startsAt);
  const endsAt = new Date(body?.endsAt);
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt < startsAt) {
    return null;
  }
  return { startsAt, endsAt };
}

function escapeICalendarText(value) {
  return String(value || '')
    .replaceAll('\\', '\\\\')
    .replaceAll('\r\n', '\n')
    .replaceAll('\n', '\\n')
    .replaceAll(';', '\\;')
    .replaceAll(',', '\\,');
}

function formatICalendarDate(value, allDay) {
  const utc = value.toISOString();
  return allDay
    ? utc.slice(0, 10).replaceAll('-', '')
    : utc.replaceAll('-', '').replaceAll(':', '').replace('.000', '');
}

function foldICalendarLine(line) {
  const chunks = [];
  let chunk = '';
  let limit = 75;
  for (const character of line) {
    if (Buffer.byteLength(chunk + character, 'utf8') > limit && chunk) {
      chunks.push(chunk);
      chunk = character;
      limit = 74;
    } else chunk += character;
  }
  chunks.push(chunk);
  return chunks.join('\r\n ');
}

function localEventIcal({ uid, summary, description, location, url, organizer, startsAt, endsAt, allDay }) {
  const dateParameter = allDay ? ';VALUE=DATE' : '';
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Inboxora//DAV Hub//EN', 'BEGIN:VEVENT', `UID:${uid}`, `DTSTART${dateParameter}:${formatICalendarDate(startsAt, allDay)}`, `DTEND${dateParameter}:${formatICalendarDate(endsAt, allDay)}`];
  if (summary) lines.push(`SUMMARY:${escapeICalendarText(summary)}`);
  if (description) lines.push(`DESCRIPTION:${escapeICalendarText(description)}`);
  if (location) lines.push(`LOCATION:${escapeICalendarText(location)}`);
  if (url) lines.push(`URL:${escapeICalendarText(url)}`);
  if (organizer) lines.push(`ORGANIZER:${escapeICalendarText(organizer)}`);
  lines.push('END:VEVENT', 'END:VCALENDAR', '');
  return lines.map(foldICalendarLine).join('\r\n');
}

async function writableCalendar(userId, calendarId) {
  const result = await query(
    'SELECT id, source, read_only FROM calendars WHERE id = $1 AND user_id = $2',
    [calendarId, userId],
  );
  const calendar = result.rows[0];
  if (!calendar) return { status: 404, error: 'Calendar not found' };
  if (calendar.read_only || calendar.source !== 'local') return { status: 403, error: 'This calendar is read-only' };
  return { calendar };
}

router.get('/calendars', async (req, res) => {
  const result = await query(
    `SELECT id, name, description, color, source, external_url, read_only, sync_token, created_at, updated_at
     FROM calendars WHERE user_id = $1 ORDER BY created_at ASC`,
    [req.session.userId],
  );
  res.json({ calendars: result.rows });
});

router.get('/events', async (req, res) => {
  const from = new Date(req.query.from);
  const to = new Date(req.query.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to < from) {
    return res.status(400).json({ error: 'A valid from/to range is required' });
  }
  if (to.getTime() - from.getTime() > MAX_EVENT_RANGE_MS) {
    return res.status(400).json({ error: 'The requested event range is too large' });
  }
  const result = await query(
    `SELECT e.id, e.calendar_id, e.uid, e.recurrence_id, e.etag, e.summary, e.description,
            e.location, e.url, e.organizer, e.starts_at, e.ends_at, e.all_day, e.timezone,
            c.name AS calendar_name, c.color AS calendar_color, c.source, c.read_only
     FROM calendar_events e
     JOIN calendars c ON c.id = e.calendar_id
     WHERE e.user_id = $1 AND e.starts_at < $3 AND e.ends_at > $2
     ORDER BY e.starts_at ASC`,
    [req.session.userId, from, to],
  );
  res.json({ events: result.rows });
});

router.post('/events', async (req, res) => {
  const { calendarId, summary, description = null, location = null, url = null, organizer = null, allDay = false, timezone = null } = req.body || {};
  const times = parseEventTimes(req.body);
  if (!calendarId || !times) return res.status(400).json({ error: 'calendarId and a valid event range are required' });

  const access = await writableCalendar(req.session.userId, calendarId);
  if (access.error) return res.status(access.status).json({ error: access.error });

  const uid = crypto.randomUUID();
  const rawIcal = localEventIcal({ uid, summary, description, location, url, organizer, allDay: Boolean(allDay), ...times });
  const result = await query(
    `INSERT INTO calendar_events (
       calendar_id, user_id, uid, raw_ical, summary, description, location, url, organizer,
       starts_at, ends_at, all_day, timezone
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING id, calendar_id, uid, etag, summary, description, location, url, organizer,
               starts_at, ends_at, all_day, timezone, created_at, updated_at`,
    [calendarId, req.session.userId, uid, rawIcal, summary || null, description, location, url, organizer, times.startsAt, times.endsAt, Boolean(allDay), timezone],
  );
  res.status(201).json({ event: result.rows[0] });
});


router.patch('/events/:eventId', async (req, res) => {
  const { calendarId, summary, description = null, location = null, url = null, organizer = null, allDay = false, timezone = null } = req.body || {};
  const times = parseEventTimes(req.body);
  if (!calendarId || !times) return res.status(400).json({ error: 'calendarId and a valid event range are required' });

  const access = await writableCalendar(req.session.userId, calendarId);
  if (access.error) return res.status(access.status).json({ error: access.error });

  const existing = await query(
    "SELECT uid FROM calendar_events WHERE id = $1 AND calendar_id = $2 AND user_id = $3",
    [req.params.eventId, calendarId, req.session.userId],
  );
  if (!existing.rows[0]) return res.status(404).json({ error: "Event not found" });

  const rawIcal = localEventIcal({ uid: existing.rows[0].uid, summary, description, location, url, organizer, allDay: Boolean(allDay), ...times });
  const result = await query(
    `UPDATE calendar_events SET
       raw_ical = $1, summary = $2, description = $3, location = $4, url = $5, organizer = $6,
       starts_at = $7, ends_at = $8, all_day = $9, timezone = $10,
       etag = gen_random_uuid()::text, updated_at = NOW()
     WHERE id = $11 AND calendar_id = $12 AND user_id = $13
     RETURNING id, calendar_id, uid, etag, summary, description, location, url, organizer,
               starts_at, ends_at, all_day, timezone, created_at, updated_at`,
    [rawIcal, summary || null, description, location, url, organizer, times.startsAt, times.endsAt, Boolean(allDay), timezone,
      req.params.eventId, calendarId, req.session.userId],
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Event not found" });

  res.json({ event: result.rows[0] });
});

router.delete('/events/:eventId', async (req, res) => {
  const calendarId = typeof req.query.calendarId === 'string' ? req.query.calendarId : null;
  if (!calendarId) return res.status(400).json({ error: 'calendarId is required' });

  const access = await writableCalendar(req.session.userId, calendarId);
  if (access.error) return res.status(access.status).json({ error: access.error });

  const result = await query(
    'DELETE FROM calendar_events WHERE id = $1 AND calendar_id = $2 AND user_id = $3 RETURNING id',
    [req.params.eventId, calendarId, req.session.userId],
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Event not found' });

  res.status(204).end();
});

export default router;
