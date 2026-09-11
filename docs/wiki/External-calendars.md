# External calendars

Inboxora subscribes to **CalDAV** and **ICS/webcal** calendars as pull-only, read-only sources.
Add, sync or remove them from the calendar panel under **Manage sources**.

## Source types

| Type | Needs | Use it for |
| --- | --- | --- |
| **CalDAV** | Server URL, remote username and password (or app password) | Nextcloud, Fastmail, Radicale, Synology and other CalDAV servers. |
| **ICS / webcal** | A calendar URL, or a `webcal://` link | Published `.ics` feeds, holiday calendars, team schedules. |

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
