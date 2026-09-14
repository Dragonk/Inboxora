import type { TFunction } from 'i18next';

/** A calendar row as these helpers read it: the API's identity/appearance fields plus the
 * contacts-source markers the localization checks. */
interface ContactCalendar {
  id: string;
  source?: string | null;
  custom_name?: boolean | null;
  name?: string | null;
  color?: string | null;
  description?: string | null;
  [key: string]: unknown;
}

/** A calendar event as these helpers read it, including the contacts metadata the backend attaches. */
interface ContactDateEvent {
  source?: string | null;
  calendar_id?: string | null;
  summary?: string | null;
  contact_date_label?: string | null;
  contact_name?: string | null;
  calendar_custom_name?: boolean | null;
  calendar_name?: string | null;
  [key: string]: unknown;
}

// Stored/imported date labels are data. Only standard labels are translated.
export function contactDateLabel(label: string | undefined, t: TFunction): string | undefined {
  switch (String(label || '').trim().toLowerCase()) {
    case 'birthday': return t('contacts.fields.birthday');
    case 'anniversary': return t('contacts.fields.anniversary');
    case 'name day': return t('contacts.fields.nameDay');
    case 'other': return t('contacts.emailTypes.other');
    default: return label;
  }
}

export function localizeContactCalendar(calendar: ContactCalendar, t: TFunction): ContactCalendar {
  if (calendar.source !== 'contacts' || calendar.id !== 'contacts-birthdays') return calendar;
  return { ...calendar, name: calendar.custom_name ? calendar.name : t('calendar.contactDates'), description: t('calendar.contactDatesDescription') };
}

export function localizeContactEvent<T extends ContactDateEvent>(event: T, t: TFunction): T & ContactDateEvent {
  if (event.source !== 'contacts' || event.calendar_id !== 'contacts-birthdays') return event;
  // Metadata avoids parsing user names/custom labels containing colons. The
  // fallback supports an older backend during a rolling frontend update.
  const summary = String(event.summary || '');
  const separator = summary.indexOf(': ');
  const label = event.contact_date_label ?? (separator >= 0 ? summary.slice(0, separator) : null);
  if (label == null) return event;
  const name = event.contact_name ?? (event.contact_date_label == null && separator >= 0 ? summary.slice(separator + 2) : null);
  return {
    ...event,
    summary: t('calendar.contactDateEvent', { label: contactDateLabel(label, t), name: name || t('calendar.unnamedContact') }),
    calendar_name: event.calendar_custom_name ? event.calendar_name : t('calendar.contactDates'),
  };
}

// vCard permits birthdays without a year; use a leap year only for formatting.
export function formatContactDate(value: string | undefined, locale: string | undefined): string {
  const date = String(value || '').slice(0, 10);
  const partial = /^--\d{2}-\d{2}$/.test(date);
  const parsed = new Date(`${partial ? `2000-${date.slice(2)}` : date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString(locale, partial ? { month: 'long', day: 'numeric' } : undefined);
}
