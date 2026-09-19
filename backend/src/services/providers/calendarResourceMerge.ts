import ICAL from 'ical.js';

/**
 * Merge a provider calendar batch into the one stored resource (P09/P07d).
 *
 * The merge is **provider-neutral**: it works on the iCalendar text a provider adapter produced, so
 * Google's and Microsoft's batches go through one implementation of the RFC 4791 rule below.
 *
 * RFC 4791 requires every component of a recurring set — the master and its
 * `RECURRENCE-ID` overrides — to live in the **same** calendar object resource.
 * An incremental sync may deliver only a changed override, only the master, or a
 * subset of both, so the adapter cannot simply replace the resource: it must
 * update exactly the components the batch carries and preserve the rest.
 *
 * Provider-owned fields are replaced, but a field the batch does not mention keeps
 * its stored value, and alarms/extension properties are never touched.
 */

/** The properties the adapter owns on a VEVENT; anything else is preserved. */
const PROVIDER_FIELDS = [
  'uid', 'dtstamp', 'dtstart', 'dtend', 'duration',
  'summary', 'description', 'location', 'url',
  'organizer', 'attendee', 'rrule', 'exdate', 'rdate',
  'status', 'sequence', 'transp',
] as const;

function parse(raw: string): ICAL.Component | null {
  try {
    const root = new ICAL.Component(ICAL.parse(raw));
    return root.name === 'vcalendar' ? root : null;
  } catch {
    return null;
  }
}

function recurrenceIdOf(event: ICAL.Component): string | null {
  const value = event.getFirstPropertyValue('recurrence-id');
  return value ? value.toString() : null;
}

/** Replace the owned properties of `target` with those of `source`. */
function copyOwnedProperties(target: ICAL.Component, source: ICAL.Component): void {
  for (const field of PROVIDER_FIELDS) {
    target.removeAllProperties(field);
    for (const property of source.getAllProperties(field)) {
      target.addProperty(new ICAL.Property(structuredClone(property.toJSON())));
    }
  }
  // An override carries its RECURRENCE-ID; a master must not.
  const sourceId = recurrenceIdOf(source);
  if (sourceId) {
    target.removeAllProperties('recurrence-id');
    target.addProperty(new ICAL.Property(structuredClone((source.getFirstProperty('recurrence-id') as ICAL.Property).toJSON())));
  }
}

/**
 * Merge one provider-generated VCALENDAR into the stored resource. Returns the new
 * resource text, or null when the batch cannot be read (the caller keeps the
 * stored resource rather than writing a broken one).
 */
export function mergeProviderCalendarResource(existingRaw: string | null | undefined, incomingRaw: string): string | null {
  const incoming = parse(incomingRaw);
  if (!incoming) return null;
  const incomingMaster = incoming.getAllSubcomponents('vevent').find(event => !event.hasProperty('recurrence-id')) ?? null;
  const incomingOverrides = incoming.getAllSubcomponents('vevent').filter(event => event.hasProperty('recurrence-id'));

  if (!existingRaw) return incomingRaw;
  const root = parse(existingRaw);
  // An unreadable stored resource is replaced by the batch instead of being lost.
  if (!root) return incomingRaw;

  // A VTIMEZONE the batch carries supersedes the stored definition for that TZID.
  for (const zone of incoming.getAllSubcomponents('vtimezone')) {
    const tzid = zone.getFirstPropertyValue('tzid');
    if (!tzid) continue;
    const stored = root.getAllSubcomponents('vtimezone').find(candidate => candidate.getFirstPropertyValue('tzid') === tzid);
    if (stored) root.removeSubcomponent(stored);
    root.addSubcomponent(new ICAL.Component(structuredClone(zone.toJSON())));
  }

  const storedMaster = root.getAllSubcomponents('vevent').find(event => !event.hasProperty('recurrence-id')) ?? null;
  if (incomingMaster) {
    if (storedMaster) {
      copyOwnedProperties(storedMaster, incomingMaster);
    } else {
      // Overrides without a master would be an invalid resource, and the master
      // must precede them, so rebuild the component list with the master first.
      const existingOverrides = root.getAllSubcomponents('vevent').filter(event => event.hasProperty('recurrence-id'));
      for (const event of root.getAllSubcomponents('vevent')) root.removeSubcomponent(event);
      root.addSubcomponent(new ICAL.Component(structuredClone(incomingMaster.toJSON())));
      for (const event of existingOverrides) root.addSubcomponent(event);
    }
  }

  for (const override of incomingOverrides) {
    const id = recurrenceIdOf(override);
    const storedOverride = id
      ? root.getAllSubcomponents('vevent').find(event => recurrenceIdOf(event) === id) ?? null
      : null;
    if (storedOverride) copyOwnedProperties(storedOverride, override);
    else root.addSubcomponent(new ICAL.Component(structuredClone(override.toJSON())));
  }

  return root.toString();
}
