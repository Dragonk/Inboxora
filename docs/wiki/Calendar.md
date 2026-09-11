# Calendar

Inboxora has first-class calendars: local writable calendars you own, read-only calendars
imported from other services, and a generated calendar for contact dates. Month, week, work-week
and agenda views share the same selected date and the same visibility filters.

![Calendar month view](https://raw.githubusercontent.com/Dragonk/Inboxora/main/media/screenshots/calendar-month-desktop.png)

## Views and navigation

- **Month** — a fixed 42-day grid that includes adjacent months, with up to three events per
  day plus a **+N more** chip.
- **Week** and **work week** — a time grid with a working-hours band, a "now" line and
  side-by-side layout for overlapping events. Work week shows only your working days.
- **Agenda** — the active month grouped by day, all-day events first.
- On a phone the week grid is wider than the screen, so it opens **centred on today** rather
  than on the first day of the week; when today is not in view (a stored week, or a work week
  that excludes a weekend), it opens on the selected day instead. Pan sideways to reach the
  rest of the week. Selecting a day inside the visible week never moves the grid sideways.
- The **day agenda** panel sits beside the grid on wide screens and opens as a sheet on smaller
  ones. It lists every event for the selected day, respecting calendar visibility.
- The **mini-month** in the sidebar changes the active date; the grid follows in every view.
- First day of the week, working days and working hours come from **Settings → Calendar**.
- The view you used last is remembered per device.
- Selecting an event opens a **preview** first; editing is one action away. Imported events open
  a read-only preview.

| Week on a phone | Agenda on a phone |
| --- | --- |
| ![Week view on a phone](https://raw.githubusercontent.com/Dragonk/Inboxora/main/media/screenshots/calendar-week-mobile.png) | ![Agenda view on a phone](https://raw.githubusercontent.com/Dragonk/Inboxora/main/media/screenshots/calendar-agenda-mobile.png) |

## Local calendars

Local calendars are writable: create, rename, recolour and delete them from the calendar panel.
Deleting a calendar asks you to confirm its name. Events in a local calendar can be created,
edited and deleted, and are published to DAV clients through CalDAV.

## Recurring events, time zones and all-day events

- Recurrence (`RRULE`, `RDATE`) is expanded on the server from the original start time, and
  exceptions (`EXDATE`, `RECURRENCE-ID`, cancelled occurrences) are respected.
- Occurrences are projected in their own time zone, so imported events show at the correct local
  time.
- If a series cannot be fully expanded, the view tells you the series is incomplete instead of
  silently showing a partial month.
- **Expanded occurrences are cached per event for the whole month you are looking at**, keyed by
  the event's version, so once a month has been opened every other view of it — stepping through
  its weeks, switching between the month grid and the agenda, coming back later in the same
  session — is served instantly. An edit, an import or an external sync gives the event a new
  version, which invalidates its entry immediately. A series whose expansion fails is cached
  briefly (30 seconds) and then retried, so one problematic series cannot slow every calendar
  view. See `CALENDAR_PROJECTION_*` in [`.env.example`](../../.env.example) for the sizing knobs.
- The **first** view of a month that contains long-running recurring series still takes a moment:
  a series has to be walked from its own start date, and that cost grows with the age of the
  series. Only that first expansion is expensive; everything after it is cached.
- **Editing a recurring event changes only the occurrence you opened**; the series, its rule and
  the other occurrences are preserved. Creating new recurrence rules from scratch is not
  currently offered in the interface.
- All-day events use dates without times, and multi-day events span every day from their start
  up to, but not including, their end date.

## Event descriptions

Event descriptions are edited as rich text and rendered in the preview through the same
sanitised, script-free pipeline that renders message bodies. Plain-text descriptions written by
other clients become readable paragraphs with clickable links. The description is also stored as
a plain-text fallback with an HTML alternative, so other calendar clients display it correctly.

## Invitations you send

- Invitations are sent as a separate email with an `invitation.ics` attachment from an account
  **you choose explicitly**; the account must have SMTP configured and enabled.
- Updating an invitation increments its sequence number, so recipients see the change rather
  than a duplicate.
- Removing an attendee, or changing the sending account, sends a cancellation to the affected
  attendees only. Deleting an event that had invitations cancels them first.
- Sending is idempotent: retrying a failed delivery does not create a second event, and a
  genuinely undelivered invitation is resent.
- The event dialog shows the delivery status and offers **Retry save** while delivery is
  pending. A default sending account can be preselected under **Settings → Calendar**.

## Invitations you receive

Messages that contain a calendar invitation show a compact **invitation card** in the reader. It
deliberately carries only the date, the target calendar and the action — the message itself already
shows the title above and the body below, and the card sits between them:

- **Add to calendar** copies the event into a local calendar of your choice. It does **not** send
  an RSVP to the organizer.
- An invitation you have already added says so, and offers **Remove from calendar** instead of
  adding it a second time.
- Adding the same invitation again updates the existing event instead of duplicating it, and an
  older version of an invitation never overwrites a newer one.
- A **cancelled** invitation never offers to add the event. If you had added it, the card offers
  to remove that copy; if you had not, it simply explains the cancellation.
- Removing an automatically imported event is limited to the copy the message created, and is
  refused once you have taken the event over by inviting attendees yourself. A cancellation older
  than the copy on file is ignored, so a late retraction cannot delete a newer update.
- Events added from mail keep a link back to the original message, even when it lives in another
  account or folder.

## Visibility and layout

- Calendar visibility switches are personal: hiding a calendar never deletes data or
  disconnects a source.
- The list/rail width is shared with Mail and Contacts, while the day agenda keeps its own width;
  both are remembered.
- The active view and the panel widths are stored per device.

## Contact dates

**Contact dates** is a generated, read-only calendar. Birthdays and anniversaries stored on your
contacts appear as all-day yearly events, including dates stored **without a year**, which repeat
in every matching year. Its name and colour can be changed per user, and it can be hidden like
any other calendar. See [Contacts and DAV](Contacts-and-DAV.md).

## Imported calendars

Read-only calendars come from **CalDAV** or **ICS/webcal** subscriptions — see
[External calendars](External-calendars.md) — or from a CardDAV-synced account. They are never
modified by Inboxora: imported events open in a preview without editing controls.

## Sharing a calendar as a link

Any selection of calendars you own can be published as an anonymous read-only `.ics` feed with a
secret link. The link can be rotated or revoked at any time, and it supports conditional
requests so calendar clients refresh efficiently. Anyone with the link can read the calendar, so
treat it like a password.

## DAV access from other applications

The same calendars are available over CalDAV, which is how DAVx5, Thunderbird and iOS/Android
calendars sync them. Clients sign in with a **DAV application password**, never your login
password — see [Contacts and DAV](Contacts-and-DAV.md).
