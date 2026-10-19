# Development changes — unreleased

These changes are on the development branch and ship with the next release. For the
current stable release, see [Release notes 4.3.7](Release-notes-4.3.7.md). Older
versions are listed in [Archive](Archive.md).

## Added

- **MCP calendar reminder tools.** External AI integrations can now manage
  calendar reminders: global defaults (`get_reminder_settings`,
  `update_reminder_settings`), per-calendar defaults (`list_calendars` now
  exposes them, `update_calendar` changes them), per-event overrides
  (`get_event_reminder`, `update_event_reminder`, `delete_event_reminder`)
  and a `list_reminders` preview of what a device will ring. Reading needs
  `calendar.read`, changing needs `calendar.write`; reminder overrides stay
  local to Inboxora and are never written back to providers.

## Fixed

- **Phone-width reminder settings.** The calendar reminder lead-time chips wrap
  instead of shrinking into unreadable slivers, the lead/mode pair stacks on phones,
  upcoming reminder rows wrap with a compact date, and delivery-warning rows let their
  fix buttons flow to the next line.
- **Android notifications after a reboot.** The boot receiver now creates the
  notification channels before starting the live push foreground service and the
  reminder sync - until the app was opened at least once after a reboot, new-mail
  and reminder notifications posted to not-yet-existing channels and dropped.

## Validation

- Frontend: `npm run typecheck`, `npm run lint`, full test suite, `npm run build`
  passed.
- Backend: `npm run typecheck`, `npm run lint` and the test suite, including the
  MCP PostgreSQL integration test, passed.
- Android: `:app:compileDebugJavaWithJavac`, `:app:testDebugUnitTest` passed.
