# Development changes — unreleased

These changes are on the development branch and ship with the next release. For the
current stable release, see [Release notes 4.3.5](Release-notes-4.3.5.md). Older
versions are listed in [Archive](Archive.md).

## Added

- **Native live push (Android, no distributor needed).** The app can run its own
  foreground WebSocket service to the server, authenticated with the push device
  token. New mail raises the same notification with reply/delete/star actions as
  before, and — unlike distributor-based push — a notification disappears as soon as
  the message is read on any device: the live socket cancels it instantly, a periodic
  `read-check` reconciles after reconnects, and the WebView cancels through the JS
  bridge. UnifiedPush and FCM keep working as fallback transports; the service starts
  only when a device token is saved.
- **Calendar reminders with a cascade.** Lead times are computed on the server
  (global default, per-calendar enable/lead-time, per-event override), so every device
  sees the same schedule. The Android app syncs the next window (a periodic worker and
  a boot receiver refresh it) and fires either a normal notification or an insistent
  ringing alarm with a full-screen alert, like the stock calendar app. Global defaults,
  per-calendar switches and per-event overrides have dedicated settings UI in all nine
  languages.

## Known safe limitations

- **Exact alarms on Android 14+.** `SCHEDULE_EXACT_ALARM` is denied by default for new
  installs; the reminders card links to the system permission screen. Without it,
  reminder timing uses `setAndAllowWhileIdle` and can drift by a few minutes in Doze.
- **The contact-dates calendar** (`contacts-birthdays`) is not part of the reminder
  cascade.
- **Reminder overrides are server-local.** They are not written back to provider
  calendars as VALARM components; provider events keep their own alarms.
- **The live service is a foreground service.** Android shows a persistent live-push
  notification while it runs; it uses the `specialUse` type because it is long-lived.

## Validation

- Backend: `npm run typecheck`, `npm run lint`, full vitest suite (341 files, 4343 tests passed).
- Android: `:app:compileDebugJavaWithJavac`, 22 JVM tests passed.
- Frontend: `npm run typecheck`, `npm run lint`, `npm test` (3933 tests), `npm run test:i18n` (2697 checks), `npm run build`.

## Upgrade requirements

Run migration `0171_calendar_reminder_settings.sql` (additive: two columns on
`calendars` and one new per-event override table). No new configuration keys; Android
devices need the new APK for live push and reminders.
