# Inboxora 4.3.8

Released **2026-10-19**.

[Downloads](https://github.com/Dragonk/Inboxora/releases/tag/v4.3.8) -
[Changelog](https://github.com/Dragonk/Inboxora/blob/v4.3.8/docs/CHANGELOG.md) -
[Upgrading](Upgrading.md#upgrading-to-438)

Inboxora 4.3.8 is a fix-and-polish release for the notifications and reminders
introduced in 4.3.6/4.3.7, and it opens the reminder system to external AI
integrations over MCP.

## Fixed

- **Phone-width reminder settings.** The calendar reminder lead-time chips wrap
  instead of shrinking into unreadable slivers, the lead/mode pair stacks on
  phones, upcoming reminder rows wrap with a compact date, and delivery-warning
  rows let their fix buttons flow to the next line.
- **Android notifications after a reboot.** The boot receiver now creates the
  notification channels before starting the live push foreground service and the
  reminder sync - until the app was opened at least once after a reboot, new-mail
  and reminder notifications posted to not-yet-existing channels and dropped.
- **Reminders for fresh events.** The on-the-fly reminder fallback for events the
  occurrence worker has not built yet keyed its rows by a column the query never
  selected, so reminders for freshly created or edited events never reached the
  preview or a device until the worker caught up.

## Added

- **MCP calendar reminder tools.** External AI integrations can now manage
  calendar reminders: global defaults (`get_reminder_settings`,
  `update_reminder_settings`), per-calendar defaults (`list_calendars` now
  exposes them, `update_calendar` changes them), per-event overrides
  (`get_event_reminder`, `update_event_reminder`, `delete_event_reminder`)
  and a `list_reminders` preview of what a device will ring. Reading needs
  `calendar.read`, changing needs `calendar.write`; reminder overrides stay
  local to Inboxora and are never written back to providers.

## Known safe limitations

- The persistent foreground-service card Android requires still exists on
  Android 14+; its channel is `IMPORTANCE_MIN` and can be hidden (or swiped away)
  without stopping the live socket. MIUI/HyperOS may show foreground-service
  cards regardless of the channel priority.
- Reminder overrides are Inboxora-local and are never written back as VALARM
  data to Google/Microsoft/CalDAV providers.

## Upgrade requirements

No database migration, no new environment variable and no compose change:
the standard upgrade steps apply. Deploy matching backend and frontend **4.3.8**
images or install the updated desktop/Android apps. Android 4.3.8 uses
`versionCode 4030800`; update the APK so notification channels exist right after
a reboot. See [Upgrading](Upgrading.md#upgrading-to-438).

## Validation

- Backend: `npm run typecheck`, `typecheck:strict`, `npm run lint`, full vitest
  suite including the MCP PostgreSQL integration test passed in CI.
- Android: `:app:compileDebugJavaWithJavac`, `:app:testDebugUnitTest` passed.
- Frontend: `npm run typecheck`, `npm run lint`, full test suite and
  `npm run build` passed.
