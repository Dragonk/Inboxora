export async function persistInboundCalendarInvitation({ query, messageId, invitation }) {
  return query(`
    INSERT INTO inbound_calendar_invitations (
      message_id, method, state, uid, recurrence_id, sequence, summary,
      organizer, starts_at, ends_at, all_day, timezone, raw_ical
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    ON CONFLICT (message_id) DO UPDATE SET
      method = EXCLUDED.method,
      state = EXCLUDED.state,
      uid = EXCLUDED.uid,
      recurrence_id = EXCLUDED.recurrence_id,
      sequence = EXCLUDED.sequence,
      summary = EXCLUDED.summary,
      organizer = EXCLUDED.organizer,
      starts_at = EXCLUDED.starts_at,
      ends_at = EXCLUDED.ends_at,
      all_day = EXCLUDED.all_day,
      timezone = EXCLUDED.timezone,
      raw_ical = EXCLUDED.raw_ical,
      parsed_at = NOW(),
      updated_at = NOW()
  `, [
    messageId, invitation.method, invitation.state, invitation.uid,
    invitation.recurrenceId, invitation.sequence, invitation.summary,
    invitation.organizer, invitation.startsAt, invitation.endsAt,
    invitation.allDay, invitation.timeZone, invitation.raw,
  ]);
}
