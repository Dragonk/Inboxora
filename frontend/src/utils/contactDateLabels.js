// Stored/imported date labels are data. Only standard labels are translated.
export function contactDateLabel(label, t) {
  switch (String(label || '').trim().toLowerCase()) {
    case 'birthday': return t('contacts.fields.birthday');
    case 'anniversary': return t('contacts.fields.anniversary');
    case 'name day': return t('contacts.fields.nameDay');
    case 'other': return t('contacts.emailTypes.other');
    default: return label;
  }
}

export function localizeContactCalendar(calendar, t) {
  if (calendar.source !== 'contacts' || calendar.id !== 'contacts-birthdays') return calendar;
  return { ...calendar, name: t('calendar.contactDates'), description: t('calendar.contactDatesDescription') };
}

export function localizeContactEvent(event, t) {
  if (event.source !== 'contacts' || event.calendar_id !== 'contacts-birthdays') return event;
  // Metadata avoids parsing user names/custom labels containing colons. The
  // fallback supports an older backend during a rolling frontend update.
  const separator = String(event.summary || '').indexOf(': ');
  const label = event.contact_date_label ?? (separator >= 0 ? event.summary.slice(0, separator) : null);
  if (label == null) return event;
  const name = event.contact_name ?? (event.contact_date_label == null && separator >= 0 ? event.summary.slice(separator + 2) : null);
  return {
    ...event,
    summary: t('calendar.contactDateEvent', { label: contactDateLabel(label, t), name: name || t('calendar.unnamedContact') }),
    calendar_name: t('calendar.contactDates'),
  };
}
