import { Router } from 'express';
import crypto from 'crypto';
import { query, withTransaction } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { decrypt, encrypt } from '../services/encryption.js';
import { validateHost } from '../services/hostValidation.js';
import { getConnectionPolicy } from '../services/connectionPolicy.js';
import { releaseCalendarSource, scheduleCalendarSource, stopCalendarSource, syncCalendarSource } from '../services/externalCalendarSync.js';
import { sendCalendarInvitation } from '../services/calendarInvitation.js';

const router = Router();
const MAX_EVENT_RANGE_DAYS = 366;
const MAX_EVENT_RANGE_MS = MAX_EVENT_RANGE_DAYS * 24 * 60 * 60 * 1000;
router.use(requireAuth);

function parseEventTimes(body) {
  const startsAt = new Date(body?.startsAt);
  const endsAt = new Date(body?.endsAt);
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) {
    return null;
  }
  return { startsAt, endsAt };
}

function contactDateEvents(contacts, from, to) {
  const events = [];
  for (const contact of contacts) {
    for (const [field, label] of [['birthday', 'Birthday'], ['anniversary', 'Anniversary']]) {
      const value = contact[field] instanceof Date ? contact[field].toISOString().slice(0, 10) : String(contact[field] || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) continue;
      const [, month, day] = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      for (let year = from.getUTCFullYear(); year <= to.getUTCFullYear(); year++) {
        const startsAt = new Date(Date.UTC(year, Number(month) - 1, Number(day)));
        if (startsAt.getUTCMonth() !== Number(month) - 1 || startsAt < from || startsAt >= to) continue;
        const endsAt = new Date(startsAt); endsAt.setUTCDate(endsAt.getUTCDate() + 1);
        events.push({ id: `contacts-${field}-${contact.id}-${year}`, calendar_id: 'contacts-birthdays', uid: `contacts-${field}-${contact.id}-${year}`, summary: `${label}: ${contact.display_name || contact.primary_email || 'Contact'}`, starts_at: startsAt, ends_at: endsAt, all_day: true, calendar_name: 'Contact dates', calendar_color: '#e879f9', source: 'contacts', read_only: true });
      }
    }
  }
  return events;
}

function escapeICalendarText(value) {
  return String(value || '')
    .replaceAll('\\', '\\\\')
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
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

function normalizeAttendees(value) {
  if (!Array.isArray(value)) return null;
  const attendees = value.map(email => typeof email === 'string' ? email.trim().toLowerCase() : '').filter(Boolean);
  if (attendees.some(email => /[\r\n\0\s,;"<>]/.test(email) || !/^[^@]+@[^@]+\.[^@]+$/.test(email))) return null;
  return [...new Set(attendees)];
}

function invitationOperationKey(req) {
  const supplied = req.headers['x-idempotency-key'];
  if (typeof supplied === 'string' && supplied.trim()) return supplied.trim().slice(0, 128);
  return crypto.createHash('sha256').update(JSON.stringify(req.body || {})).digest('hex');
}

function invitationRequestFingerprint(req, fields) {
  const { calendarId, normalizedAttendees, times, summary, description, location, url, organizer, allDay, timezone, invitationAccount } = fields;
  return crypto.createHash('sha256').update(JSON.stringify({
    eventId: req.params.eventId || null, calendarId, summary: summary || null, description, location, url, organizer,
    allDay: Boolean(allDay), timezone, attendees: normalizedAttendees, inviteAccountId: invitationAccount?.id || null,
    startsAt: times.startsAt.toISOString(), endsAt: times.endsAt.toISOString(),
  })).digest('hex');
}

async function deliverInvitationOutbox(outboxId, actions) {
  try {
    for (const { account, ...invitation } of actions) {
      await sendCalendarInvitation({ account, ...invitation, startsAt: new Date(invitation.startsAt), endsAt: new Date(invitation.endsAt) });
    }
    await query("UPDATE calendar_invitation_outbox SET status = 'sent', attempts = attempts + 1, delivered_at = NOW(), last_error = NULL WHERE id = $1 AND status = 'sending'", [outboxId]);
    return null;
  } catch (error) {
    await query("UPDATE calendar_invitation_outbox SET attempts = attempts + 1, last_error = $2 WHERE id = $1 AND status = 'sending'", [outboxId, error.message]);
    console.error('Calendar invitation delivery failed:', error.message);
    return 'The event was saved, but the invitation could not be sent. Retry the same save to check its delivery status.';
  }
}

function duplicateInvitationStatus(outbox) {
  const status = outbox.status === 'sent' ? 'sent' : outbox.last_error ? 'failed' : 'pending';
  return {
    invitationStatus: { status, lastError: outbox.last_error || null },
    ...(status === 'sent' ? {} : {
      invitationError: status === 'failed'
        ? `The event was saved, but the invitation could not be sent: ${outbox.last_error}`
        : 'The invitation delivery is still pending; it was not sent again.',
    }),
  };
}

async function updateInvitedEvent(req, fields) {
  const { calendarId, invitationAccount, normalizedAttendees, times, summary, description, location, url, organizer, allDay, timezone } = fields;
  const key = invitationOperationKey(req);
  const fingerprint = invitationRequestFingerprint(req, fields);
  return withTransaction(async client => {
    const prior = await client.query('SELECT id, event_id, request_fingerprint, status, last_error FROM calendar_invitation_outbox WHERE user_id = $1 AND idempotency_key = $2 FOR UPDATE', [req.session.userId, key]);
    if (prior.rows[0]) {
      if (prior.rows[0].request_fingerprint !== fingerprint) return { conflict: true };
      const event = (await client.query('SELECT id, calendar_id, uid, etag, summary, description, location, url, organizer, starts_at, ends_at, all_day, timezone, attendees, invite_account_id, invitation_sequence, created_at, updated_at FROM calendar_events WHERE id = $1 AND calendar_id = $2 AND user_id = $3', [prior.rows[0].event_id, calendarId, req.session.userId])).rows[0];
      if (!event || event.id !== req.params.eventId) return { conflict: true };
      return { event, duplicate: true, ...duplicateInvitationStatus(prior.rows[0]) };
    }
    const existing = (await client.query('SELECT uid, attendees, invite_account_id, invitation_sequence, summary, description, location, starts_at, ends_at, all_day FROM calendar_events WHERE id = $1 AND calendar_id = $2 AND user_id = $3 FOR UPDATE', [req.params.eventId, calendarId, req.session.userId])).rows[0];
    if (!existing) return { notFound: true };
    const hadInvitation = Boolean(existing.invite_account_id && Array.isArray(existing.attendees) && existing.attendees.length);
    const senderChanged = hadInvitation && invitationAccount.id !== existing.invite_account_id;
    const cancelledAttendees = hadInvitation
      ? (senderChanged ? existing.attendees : existing.attendees.filter(email => !normalizedAttendees.includes(email)))
      : [];
    let cancellationAccount = null;
    if (cancelledAttendees.length) {
      cancellationAccount = invitationAccount.id === existing.invite_account_id
        ? invitationAccount
        : (await client.query('SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2 AND smtp_host IS NOT NULL', [existing.invite_account_id, req.session.userId])).rows[0] || null;
      if (!cancellationAccount) return { cancelFailed: true };
    }
    const rawIcal = localEventIcal({ uid: existing.uid, summary, description, location, url, organizer, allDay: Boolean(allDay), ...times });
    const result = await client.query(`UPDATE calendar_events SET raw_ical = $1, summary = $2, description = $3, location = $4, url = $5, organizer = $6, starts_at = $7, ends_at = $8, all_day = $9, timezone = $10, attendees = $11, invite_account_id = $12, invitation_sequence = CASE WHEN (invite_account_id IS NOT NULL AND jsonb_array_length(attendees) > 0) OR invitation_sequence > 0 THEN invitation_sequence + 1 ELSE 0 END, etag = gen_random_uuid()::text, updated_at = NOW() WHERE id = $13 AND calendar_id = $14 AND user_id = $15 RETURNING id, calendar_id, uid, etag, summary, description, location, url, organizer, starts_at, ends_at, all_day, timezone, attendees, invite_account_id, invitation_sequence, created_at, updated_at`, [rawIcal, summary || null, description, location, url, organizer, times.startsAt, times.endsAt, Boolean(allDay), timezone, normalizedAttendees, invitationAccount.id, req.params.eventId, calendarId, req.session.userId]);
    const event = result.rows[0];
    const actions = [];
    if (cancelledAttendees.length) actions.push({ account: cancellationAccount, attendees: cancelledAttendees, summary: existing.summary, description: existing.description, location: existing.location, uid: existing.uid, allDay: Boolean(existing.all_day), method: 'CANCEL', sequence: Number(existing.invitation_sequence || 0) + 1, startsAt: new Date(existing.starts_at).toISOString(), endsAt: new Date(existing.ends_at).toISOString() });
    actions.push({ account: invitationAccount, attendees: normalizedAttendees, summary, description, location, uid: event.uid, allDay: Boolean(allDay), method: 'REQUEST', sequence: event.invitation_sequence, startsAt: times.startsAt.toISOString(), endsAt: times.endsAt.toISOString() });
    const outbox = await client.query('INSERT INTO calendar_invitation_outbox (user_id, event_id, idempotency_key, request_fingerprint, payload) VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING id', [req.session.userId, event.id, key, fingerprint, JSON.stringify({ actions: actions.map(action => Object.fromEntries(Object.entries(action).filter(([name]) => name !== 'account'))) })]);
    return { event, outboxId: outbox.rows[0].id, actions };
  });
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
  res.json({ calendars: [...result.rows, {
    id: 'contacts-birthdays', name: 'Contact dates', description: 'Birthdays and anniversaries from contacts',
    color: '#e879f9', source: 'contacts', external_url: null, read_only: true,
  }] });
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
            e.location, e.url, e.organizer, e.starts_at, e.ends_at, e.all_day, e.timezone, e.attendees, e.invite_account_id, e.invitation_sequence,
            c.name AS calendar_name, c.color AS calendar_color, c.source, c.read_only
     FROM calendar_events e
     JOIN calendars c ON c.id = e.calendar_id
     WHERE e.user_id = $1 AND e.starts_at < $3 AND e.ends_at > $2
     ORDER BY e.starts_at ASC`,
    [req.session.userId, from, to],
  );
  const contactResult = await query(
    'SELECT id, display_name, primary_email, birthday, anniversary FROM contacts WHERE user_id = $1 AND (birthday IS NOT NULL OR anniversary IS NOT NULL)',
    [req.session.userId],
  );
  const events = [...result.rows, ...contactDateEvents(contactResult?.rows || [], from, to)]
    .sort((left, right) => new Date(left.starts_at) - new Date(right.starts_at));
  res.json({ events });
});

router.post('/events', async (req, res) => {
  const { calendarId, summary, description = null, location = null, url = null, organizer = null, allDay = false, timezone = null, sendInvites = false, inviteAccountId, attendees } = req.body || {};
  const times = parseEventTimes(req.body);
  if (!calendarId || !times) return res.status(400).json({ error: 'calendarId and a valid event range are required' });
  const normalizedAttendees = normalizeAttendees(attendees || []);
  if (!normalizedAttendees) return res.status(400).json({ error: 'Attendees must be valid email addresses' });
  if (sendInvites && (!inviteAccountId || !normalizedAttendees.length)) {
    return res.status(400).json({ error: 'A sender account and at least one attendee are required for invitations' });
  }

  const access = await writableCalendar(req.session.userId, calendarId);
  if (access.error) return res.status(access.status).json({ error: access.error });

  let invitationAccount = null;
  if (sendInvites) {
    const sender = await query(
      'SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2 AND enabled = true AND smtp_host IS NOT NULL',
      [inviteAccountId, req.session.userId],
    );
    invitationAccount = sender.rows[0] || null;
    if (!invitationAccount) return res.status(400).json({ error: 'The selected sender account is unavailable' });
  }

  if (sendInvites && typeof req.headers['x-idempotency-key'] === 'string' && req.headers['x-idempotency-key'].trim()) {
    const idempotencyKey = invitationOperationKey(req);
    const fingerprint = invitationRequestFingerprint(req, { calendarId, normalizedAttendees, times, summary, description, location, url, organizer, allDay, timezone, invitationAccount });
    let outcome;
    try {
      outcome = await withTransaction(async client => {
      const prior = await client.query('SELECT id, request_fingerprint, status, last_error FROM calendar_invitation_outbox WHERE user_id = $1 AND idempotency_key = $2 FOR UPDATE', [req.session.userId, idempotencyKey]);
      if (prior.rows[0]) {
        if (prior.rows[0].request_fingerprint !== fingerprint) return { conflict: true };
        const event = (await client.query('SELECT id, calendar_id, uid, etag, summary, description, location, url, organizer, starts_at, ends_at, all_day, timezone, attendees, invite_account_id, invitation_sequence, created_at, updated_at FROM calendar_events WHERE id = (SELECT event_id FROM calendar_invitation_outbox WHERE id = $1)', [prior.rows[0].id])).rows[0];
        return { event, duplicate: true, ...duplicateInvitationStatus(prior.rows[0]) };
      }
      const uid = crypto.randomUUID();
      const rawIcal = localEventIcal({ uid, summary, description, location, url, organizer, allDay: Boolean(allDay), ...times });
      const result = await client.query(
        `INSERT INTO calendar_events (calendar_id, user_id, uid, raw_ical, summary, description, location, url, organizer, starts_at, ends_at, all_day, timezone, attendees, invite_account_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING id, calendar_id, uid, etag, summary, description, location, url, organizer, starts_at, ends_at, all_day, timezone, attendees, invite_account_id, invitation_sequence, created_at, updated_at`,
        [calendarId, req.session.userId, uid, rawIcal, summary || null, description, location, url, organizer, times.startsAt, times.endsAt, Boolean(allDay), timezone, normalizedAttendees, invitationAccount.id],
      );
      const event = result.rows[0];
      const outbox = await client.query(
        `INSERT INTO calendar_invitation_outbox (user_id, event_id, idempotency_key, request_fingerprint, payload) VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING id`,
        [req.session.userId, event.id, idempotencyKey, invitationRequestFingerprint(req, { calendarId, normalizedAttendees, times, summary, description, location, url, organizer, allDay, timezone, invitationAccount }), JSON.stringify({ actions: [{ attendees: normalizedAttendees, summary, description, location, uid, allDay: Boolean(allDay), method: 'REQUEST', sequence: event.invitation_sequence ?? 0, startsAt: times.startsAt.toISOString(), endsAt: times.endsAt.toISOString() }] })],
      );
        return { event, outboxId: outbox.rows[0].id };
      });
    } catch (error) {
      console.error('Calendar invitation transaction failed:', error.message);
      return res.status(500).json({ error: 'The event and invitation could not be saved; no partial changes were kept.' });
    }
    if (outcome.conflict) return res.status(409).json({ error: 'The idempotency key was already used for a different calendar operation' });
    if (outcome.duplicate) return res.status(201).json({ event: outcome.event, ...outcome.invitationStatus ? { invitationStatus: outcome.invitationStatus } : {}, ...outcome.invitationError ? { invitationError: outcome.invitationError } : {} });
    const invitationError = await deliverInvitationOutbox(outcome.outboxId, [{ account: invitationAccount, attendees: normalizedAttendees, summary, description, location, uid: outcome.event.uid, allDay: Boolean(allDay), method: 'REQUEST', sequence: outcome.event.invitation_sequence ?? 0, startsAt: times.startsAt.toISOString(), endsAt: times.endsAt.toISOString() }]);
    return res.status(201).json({ event: outcome.event, ...(invitationError ? { invitationError } : {}) });
  }

  const uid = crypto.randomUUID();
  const rawIcal = localEventIcal({ uid, summary, description, location, url, organizer, allDay: Boolean(allDay), ...times });
  const result = await query(
    `INSERT INTO calendar_events (
       calendar_id, user_id, uid, raw_ical, summary, description, location, url, organizer,
       starts_at, ends_at, all_day, timezone, attendees, invite_account_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING id, calendar_id, uid, etag, summary, description, location, url, organizer,
               starts_at, ends_at, all_day, timezone, attendees, invite_account_id, invitation_sequence, created_at, updated_at`,
    [calendarId, req.session.userId, uid, rawIcal, summary || null, description, location, url, organizer, times.startsAt, times.endsAt, Boolean(allDay), timezone, sendInvites ? normalizedAttendees : [], invitationAccount?.id || null],
  );
  let invitationError = null;
  if (invitationAccount) {
    try {
      await sendCalendarInvitation({ account: invitationAccount, attendees: normalizedAttendees, summary, description, location, uid, allDay: Boolean(allDay), method: 'REQUEST', sequence: result.rows[0].invitation_sequence ?? 0, ...times });
    } catch (error) {
      invitationError = 'The event was saved, but the invitation could not be sent.';
      console.error('Calendar invitation delivery failed:', error.message);
    }
  }
  res.status(201).json({ event: result.rows[0], ...(invitationError ? { invitationError } : {}) });
});


router.patch('/events/:eventId', async (req, res) => {
  const { calendarId, summary, description = null, location = null, url = null, organizer = null, allDay = false, timezone = null, sendInvites = false, inviteAccountId, attendees } = req.body || {};
  const times = parseEventTimes(req.body);
  if (!calendarId || !times) return res.status(400).json({ error: 'calendarId and a valid event range are required' });
  const normalizedAttendees = normalizeAttendees(attendees || []);
  if (!normalizedAttendees) return res.status(400).json({ error: 'Attendees must be valid email addresses' });
  if (sendInvites && (!inviteAccountId || !normalizedAttendees.length)) return res.status(400).json({ error: 'A sender account and at least one attendee are required for invitations' });

  const access = await writableCalendar(req.session.userId, calendarId);
  if (access.error) return res.status(access.status).json({ error: access.error });

  let invitationAccount = null;
  if (sendInvites) {
    const sender = await query('SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2 AND enabled = true AND smtp_host IS NOT NULL', [inviteAccountId, req.session.userId]);
    invitationAccount = sender.rows[0] || null;
    if (!invitationAccount) return res.status(400).json({ error: 'The selected sender account is unavailable' });
  }

  if (sendInvites && typeof req.headers['x-idempotency-key'] === 'string' && req.headers['x-idempotency-key'].trim()) {
    let outcome;
    try {
      outcome = await updateInvitedEvent(req, { calendarId, invitationAccount, normalizedAttendees, times, summary, description, location, url, organizer, allDay, timezone });
    } catch (error) {
      console.error('Calendar invitation transaction failed:', error.message);
      return res.status(500).json({ error: 'The event and invitation could not be saved; no partial changes were kept.' });
    }
    if (outcome.notFound) return res.status(404).json({ error: 'Event not found' });
    if (outcome.conflict) return res.status(409).json({ error: 'The idempotency key was already used for a different calendar update' });
    if (outcome.cancelFailed) return res.status(502).json({ error: 'The previous invitation could not be cancelled, so the event was not changed.' });
    if (outcome.duplicate) return res.json({ event: outcome.event, ...outcome.invitationStatus ? { invitationStatus: outcome.invitationStatus } : {}, ...outcome.invitationError ? { invitationError: outcome.invitationError } : {} });
    const invitationError = await deliverInvitationOutbox(outcome.outboxId, outcome.actions);
    return res.json({ event: outcome.event, ...(invitationError ? { invitationError } : {}) });
  }

  const outcome = await withTransaction(async client => {
    const existing = await client.query(`SELECT uid, attendees, invite_account_id, invitation_sequence, summary, description, location, starts_at, ends_at, all_day FROM calendar_events WHERE id = $1 AND calendar_id = $2 AND user_id = $3 FOR UPDATE`, [req.params.eventId, calendarId, req.session.userId]);
    const existingEvent = existing.rows[0];
    if (!existingEvent) return { notFound: true };

    const hadInvitation = Boolean(existingEvent.invite_account_id && Array.isArray(existingEvent.attendees) && existingEvent.attendees.length);
    const senderChanged = hadInvitation && sendInvites && invitationAccount?.id !== existingEvent.invite_account_id;
    const cancelledAttendees = hadInvitation ? (senderChanged || !sendInvites ? existingEvent.attendees : existingEvent.attendees.filter(email => !normalizedAttendees.includes(email))) : [];
    const cancellationAccount = invitationAccount?.id === existingEvent.invite_account_id
      ? invitationAccount
      : cancelledAttendees.length
        // A disabled account retains SMTP settings for cancellation; referenced
        // sender accounts cannot be deleted because the FK is ON DELETE RESTRICT.
        ? (await client.query('SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2 AND smtp_host IS NOT NULL', [existingEvent.invite_account_id, req.session.userId])).rows[0] || null
        : null;
    if (cancelledAttendees.length) {
      if (!cancellationAccount) return { cancelFailed: true };
      try {
        await sendCalendarInvitation({ account: cancellationAccount, attendees: cancelledAttendees, summary: existingEvent.summary, description: existingEvent.description, location: existingEvent.location, uid: existingEvent.uid, allDay: Boolean(existingEvent.all_day), method: 'CANCEL', sequence: Number(existingEvent.invitation_sequence || 0) + 1, startsAt: new Date(existingEvent.starts_at), endsAt: new Date(existingEvent.ends_at) });
      } catch (error) {
        console.error('Calendar invitation cancellation before update failed:', error.message);
        return { cancelFailed: true };
      }
    }

    const rawIcal = localEventIcal({ uid: existingEvent.uid, summary, description, location, url, organizer, allDay: Boolean(allDay), ...times });
    const result = await client.query(`UPDATE calendar_events SET raw_ical = $1, summary = $2, description = $3, location = $4, url = $5, organizer = $6, starts_at = $7, ends_at = $8, all_day = $9, timezone = $10, attendees = $11, invite_account_id = $12, invitation_sequence = CASE WHEN (invite_account_id IS NOT NULL AND jsonb_array_length(attendees) > 0) OR invitation_sequence > 0 THEN invitation_sequence + 1 ELSE 0 END, etag = gen_random_uuid()::text, updated_at = NOW() WHERE id = $13 AND calendar_id = $14 AND user_id = $15 RETURNING id, calendar_id, uid, etag, summary, description, location, url, organizer, starts_at, ends_at, all_day, timezone, attendees, invite_account_id, invitation_sequence, created_at, updated_at`, [rawIcal, summary || null, description, location, url, organizer, times.startsAt, times.endsAt, Boolean(allDay), timezone, sendInvites ? normalizedAttendees : [], invitationAccount?.id || null, req.params.eventId, calendarId, req.session.userId]);
    if (!result.rows[0]) return { notFound: true };

    let invitationError = null;
    if (invitationAccount) {
      try {
        // Keep the row lock until this REQUEST is emitted, so a later mutation
        // cannot overtake it with a higher sequence number.
        await sendCalendarInvitation({ account: invitationAccount, attendees: normalizedAttendees, summary, description, location, uid: existingEvent.uid, allDay: Boolean(allDay), method: 'REQUEST', sequence: result.rows[0].invitation_sequence, ...times });
      } catch (error) {
        invitationError = 'The event was saved, but the invitation could not be sent.';
        console.error('Calendar invitation delivery failed:', error.message);
      }
    }
    return { event: result.rows[0], ...(invitationError ? { invitationError } : {}) };
  });
  if (outcome.cancelFailed) return res.status(502).json({ error: 'The previous invitation could not be cancelled, so the event was not changed.' });
  if (outcome.notFound || !outcome.event) return res.status(404).json({ error: 'Event not found' });

  res.json(outcome);
});


router.delete('/events/:eventId', async (req, res) => {
  const calendarId = typeof req.query.calendarId === 'string' ? req.query.calendarId : null;
  if (!calendarId) return res.status(400).json({ error: 'calendarId is required' });

  const access = await writableCalendar(req.session.userId, calendarId);
  if (access.error) return res.status(access.status).json({ error: access.error });

  const outcome = await withTransaction(async client => {
    const existing = await client.query(`SELECT uid, attendees, invite_account_id, invitation_sequence, summary, description, location, starts_at, ends_at, all_day FROM calendar_events WHERE id = $1 AND calendar_id = $2 AND user_id = $3 FOR UPDATE`, [req.params.eventId, calendarId, req.session.userId]);
    const event = existing.rows[0];
    if (!event) return { notFound: true };

    if (event.invite_account_id && Array.isArray(event.attendees) && event.attendees.length) {
      try {
        // A disabled account retains SMTP settings for cancellation; referenced
        // sender accounts cannot be deleted because the FK is ON DELETE RESTRICT.
        const sender = await client.query('SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2 AND smtp_host IS NOT NULL', [event.invite_account_id, req.session.userId]);
        if (!sender.rows[0]) return { cancelFailed: true };
        await sendCalendarInvitation({ account: sender.rows[0], attendees: event.attendees, summary: event.summary, description: event.description, location: event.location, uid: event.uid, allDay: Boolean(event.all_day), method: 'CANCEL', sequence: Number(event.invitation_sequence || 0) + 1, startsAt: new Date(event.starts_at), endsAt: new Date(event.ends_at) });
      } catch (error) {
        console.error('Calendar invitation cancellation before deletion failed:', error.message);
        return { cancelFailed: true };
      }
    }

    const result = await client.query('DELETE FROM calendar_events WHERE id = $1 AND calendar_id = $2 AND user_id = $3 RETURNING id', [req.params.eventId, calendarId, req.session.userId]);
    return { deleted: Boolean(result.rows[0]) };
  });
  if (outcome.cancelFailed) return res.status(502).json({ error: 'The invitation could not be cancelled, so the event was not deleted.' });
  if (outcome.notFound || !outcome.deleted) return res.status(404).json({ error: 'Event not found' });

  res.status(204).end();
});

function publicSource(source) {
  const secretValues = source.url ? [source.url, decrypt(source.url)] : [];
  const lastError = typeof source.last_error === 'string'
    ? secretValues.filter(Boolean).reduce((error, secret) => error.replaceAll(secret, '[redacted]'), source.last_error)
    : source.last_error;
  return {
    id: source.id, kind: source.kind,
    displayName: source.display_name, color: source.color, intervalMin: source.interval_min,
    enabled: source.enabled, lastSyncAt: source.last_sync_at, lastError,
  };
}

router.get('/sources', async (req, res) => {
  const result = await query(
    `SELECT id, kind, url, username, display_name, color, interval_min, enabled, last_sync_at, last_error
     FROM calendar_import_sources WHERE user_id = $1 ORDER BY created_at ASC`, [req.session.userId],
  );
  res.json({ sources: result.rows.map(publicSource) });
});

router.post('/sources', async (req, res) => {
  const { kind, url, username, password, displayName, color = null, intervalMin = 60 } = req.body || {};
  if (!['caldav', 'ical_url'].includes(kind) || !url || !displayName) return res.status(400).json({ error: 'kind, url, and displayName are required' });
  if (kind === 'caldav' && (!username || !password)) return res.status(400).json({ error: 'CalDAV sources require username and password' });
  let parsed;
  try { parsed = new URL(url); } catch { return res.status(400).json({ error: 'Invalid source URL' }); }
  if (parsed.protocol === 'webcal:') parsed = new URL(url.replace(/^[^:]+:/, 'https:'));
  if (parsed.username || parsed.password) return res.status(400).json({ error: 'Source URL must not include credentials' });
  if (!['https:', 'http:'].includes(parsed.protocol)) return res.status(400).json({ error: 'Source URL must use http(s)' });
  const policy = await getConnectionPolicy();
  const hostError = await validateHost(parsed.hostname, { allowPrivate: policy.allowPrivateHosts });
  if (hostError) return res.status(400).json({ error: hostError });
  if (parsed.protocol === 'http:') {
    if (!policy.allowPrivateHosts) return res.status(400).json({ error: 'Source URL must use HTTPS' });
    const publicHostError = await validateHost(parsed.hostname, { allowPrivate: false });
    if (!publicHostError) return res.status(400).json({ error: 'HTTPS is required for a public source' });
  }
  const interval = Math.max(15, Math.min(1440, Number.parseInt(intervalMin, 10) || 60));
  try {
    const normalizedUrl = parsed.toString();
    const urlFingerprint = crypto.createHash('sha256').update(normalizedUrl).digest('hex');
    const result = await query(
      `INSERT INTO calendar_import_sources (user_id, kind, url, url_fingerprint, username, password, display_name, color, interval_min)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.session.userId, kind, encrypt(normalizedUrl), urlFingerprint, username || null, password ? encrypt(password) : null, displayName, color, interval],
    );
    const source = result.rows[0];
    scheduleCalendarSource(source);
    const sync = await syncCalendarSource(req.session.userId, source.id);
    if (!sync.ok) {
      // The sync records the failure asynchronously from the insert result;
      // reflect that terminal state in the response so the client can render
      // the persisted source as retryable immediately.
      source.last_error = sync.error;
      return res.status(502).json({ error: sync.error, source: publicSource(source), sync });
    }
    res.status(201).json({ source: publicSource(source), sync });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'A source with this URL already exists' });
    if (error.code === '23514') return res.status(409).json({ error: 'Calendar source URL could not be stored securely' });
    throw error;
  }
});

router.post('/sources/:sourceId/sync', async (req, res) => {
  const result = await syncCalendarSource(req.session.userId, req.params.sourceId);
  if (!result.ok && result.error === 'Calendar source not found') return res.status(404).json({ error: result.error });
  res.json(result);
});

router.delete('/sources/:sourceId', async (req, res) => {
  const existing = await query('SELECT id FROM calendar_import_sources WHERE id = $1 AND user_id = $2', [req.params.sourceId, req.session.userId]);
  if (!existing.rows[0]) return res.status(404).json({ error: 'Calendar source not found' });
  await stopCalendarSource(req.params.sourceId);
  const result = await query('DELETE FROM calendar_import_sources WHERE id = $1 AND user_id = $2 RETURNING id', [req.params.sourceId, req.session.userId]);
  if (!result.rows[0]) {
    releaseCalendarSource(req.params.sourceId);
    return res.status(404).json({ error: 'Calendar source not found' });
  }
  await query('DELETE FROM calendars WHERE user_id = $1 AND external_url = $2', [req.session.userId, `source:${req.params.sourceId}`]);
  releaseCalendarSource(req.params.sourceId);
  res.status(204).end();
});

export default router;
