# External calendars

Inboxora subscribes to **CalDAV** and **ICS/webcal** calendars as pull-only, read-only sources.
Add one from **Settings → Calendar → Calendar subscriptions** or from the calendar panel under
**Manage sources**, which is also where you sync, reschedule and remove them.

## Source types

| Type | Needs | Use it for |
| --- | --- | --- |
| **CalDAV** | Server URL, remote username and password (or app password) | Nextcloud, Fastmail, Radicale, Synology and other CalDAV servers. |
| **ICS / webcal** | A calendar URL, or a `webcal://` link | Published `.ics` feeds, holiday calendars, team schedules. |

## Add a subscription in two steps

The fastest route is **Settings → Calendar → Calendar subscriptions**. Paste a name and the feed
URL and choose **Subscribe**. Inboxora accepts an `https://` link or the `webcal://` link a website
hands out; a `webcal://` link is converted to `https://` automatically. The source starts syncing
straight away and appears as a read-only calendar named after the entry you added.

The same list is available from the calendar panel under **Manage sources**, which is also where you
remove a subscription, run **Sync now**, inspect a failure and change its cadence.

### Holiday calendars

The **Public holidays** block in the same settings section adds a country's holidays as an ordinary
ICS subscription. Inboxora does **not** ship a holiday database: picking a country only resolves to
the matching read-only ICS feed published by the
[Thunderbird holiday calendar project](https://www.thunderbird.net/calendar/holidays/), and the
ordinary external-calendar sync pulls it like any other source. The calendar arrives as
**Holidays — <country>**, can be hidden or recoloured like any other calendar, and is refreshed
daily because holidays change at most once a year.

Inboxora deliberately does not generate holidays itself: moving feasts, statutory changes and
regional variants are exactly the kind of data the Thunderbird project already maintains and
updates. If a country is missing from the picker, add its `https://` or `webcal://` feed through
the subscription form above. Holiday calendars are subject to the same connection and credential
rules as every other source.

## Sync schedule

Every source has its own interval, chosen when you add it and editable at any time from its row in
**Manage sources** (15, 30 or 60 minutes, 3, 6, 12 or 24 hours; the default is hourly). Pick it
from how often the feed actually changes: a busy shared team calendar is worth polling every 15
minutes, a public holiday calendar is not.

Changing the interval re-arms the schedule immediately — the server does not need a restart, and
the wait does not stay tied to the old interval. **Sync now** ignores the schedule and refreshes a
single source straight away.

## Behaviour

- Sources are **pull-only**. Inboxora never writes to the remote calendar.
- Each source keeps its own sync schedule (15 minutes to 24 hours, default hourly), and one source
  failing never blocks the others.
- Removing a source removes only the local read-only copy; the remote calendar is untouched.
- Events removed from the remote feed are removed locally as well, so the local copy tracks the
  source.
- If a source returns something unusable, Inboxora keeps the last healthy copy and reports the
  problem instead of wiping your calendar. A genuinely empty calendar does clear the local copy.
- Each source shows its last sync time, last error category and any skipped entries.

## Credentials and safety

- Use a **dedicated remote username and app password** for CalDAV. Never reuse your Inboxora
  primary password, and never use your main account password for the remote service if it
  offers app passwords.
- Source credentials are encrypted at rest, are never returned by the API, and are not displayed
  again after you submit them.
- Error messages are redacted so a URL containing a secret cannot leak into the interface or a
  log.
- Source URLs are validated against the server connection policy: unsafe hosts are rejected, and
  public sources must use HTTPS. URLs that embed credentials are refused.
- `webcal://` links are converted to `https://`.

## Sharing one of your calendars as a link

The reverse direction is also supported: publish your own calendars as an anonymous read-only
`.ics` feed.

- Choose which owned calendars the feed contains and create a secret link.
- The link can be **rotated** (new secret, old link stops working) or **revoked** at any time.
- Failures are answered identically so the link cannot be probed for valid tokens, and repeated
  failures are rate-limited.
- The feed supports conditional requests, so subscribed clients refresh efficiently.

Anyone holding the link can read those calendars. Treat it like a password and rotate it if it
leaks.
