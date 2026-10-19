# Inboxora 4.3.6

Released **2026-10-19**.

[Downloads](https://github.com/Dragonk/Inboxora/releases/tag/v4.3.6) ·
[Changelog](https://github.com/Dragonk/Inboxora/blob/v4.3.6/docs/CHANGELOG.md) ·
[Upgrading](Upgrading.md#upgrading-to-436)

Inboxora 4.3.6 adds native live push for the Android app and calendar reminders
with a server-side lead-time cascade. The Android app keeps its own authenticated
WebSocket connection to the server, so new mail raises a native notification with
reply, delete and star actions without any push distributor, and the notification is
dismissed as soon as the message is read on any device. Calendar reminders are
resolved on the server — global defaults, per-calendar enable and lead time,
per-event override — so every device sees the same schedule, and the Android app
fires them as regular notifications or as insistent full-screen alarms.

## Added

- **Native live push (Android, no distributor needed).** The app runs its own
  foreground WebSocket service, authenticated with the push device token. New
  mail raises the same notification with reply/delete/star actions as before,
  and a notification disappears as soon as the message is read on any device:
  the live socket cancels it instantly, a periodic `read-check` reconciles
  after reconnects, and the WebView cancels through the JS bridge. UnifiedPush
  and FCM keep working as fallback transports; the service starts only when a
  device token is saved.
- **Calendar reminders with a cascade.** Lead times are computed on the server
  (global default, per-calendar enable/lead-time, per-event override), so every
  device sees the same schedule. The Android app syncs the next window (a
  periodic worker and a boot receiver refresh it) and fires either a normal
  notification or an insistent ringing alarm with a full-screen alert, like the
  stock calendar app. Global defaults, per-calendar switches and per-event
  overrides have dedicated settings UI in all nine languages.

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
