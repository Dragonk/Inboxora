# Development changes — unreleased

These changes are on the development branch and ship with the next release. For the
current stable release, see [Release notes 4.3.6](Release-notes-4.3.6.md). Older
versions are listed in [Archive](Archive.md).

## Removed: ntfy / UnifiedPush

- **Push is built into Inboxora now.** The Android app registers with the `live`
  transport: no endpoint, no distributor app — it authenticates with its push device
  token over the WebSocket it keeps open anyway. The server no longer registers,
  validates or contacts any user-supplied push URL, so the ntfy service, its
  reverse-proxy routes and its environment keys can be removed from a deployment.
- Existing `unifiedpush` registrations are migrated to `live` by
  `0172_live_push_transport.sql`; the app re-registers on its next start anyway.
- FCM stays available as the optional provider transport for builds compiled with
  their own `google-services.json`.

## Changed

- **Calendar reminder cascade.** A per-event override with *enabled* now wins over
  a muted calendar and even over a muted global default, so one pinned event can
  ring as an alarm while everything else stays silent. The delivery mode
  (notification vs insistent alarm) inherits through the whole cascade: event
  override → calendar `notify_mode` (new, `0173_calendar_notify_mode.sql`) → global
  preference.

## Validation

- Backend: `npm run typecheck`, `npm run lint`, full vitest suite (340 files, 4333
  tests passed).

## Upgrade requirements

Run migrations `0172_live_push_transport.sql` and `0173_calendar_notify_mode.sql`
(additive; no new configuration keys).
