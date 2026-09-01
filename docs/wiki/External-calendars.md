# External calendars

Inboxora imports **CalDAV** and **ICS/webcal** sources as pull-only, read-only calendars. Add, sync or remove them from Calendar panel → Manage sources.

- CalDAV requires a dedicated remote username and app password; do not reuse an Inboxora primary password.
- Credentials are encrypted at rest and are never returned by the API or displayed after submission.
- URL validation blocks unsafe hosts according to the server connection policy. Public sources require HTTPS.
- Source sync runs independently; an error is shown for the source without blocking other calendars.
- Removing a source removes its local read-only projection, not the remote calendar.
