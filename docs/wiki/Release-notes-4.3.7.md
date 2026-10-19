# Inboxora 4.3.7

Released **2026-10-19**.

[Downloads](https://github.com/Dragonk/Inboxora/releases/tag/v4.3.7) ·
[Changelog](https://github.com/Dragonk/Inboxora/blob/v4.3.7/docs/CHANGELOG.md) ·
[Upgrading](Upgrading.md#upgrading-to-437)

Inboxora 4.3.7 makes push fully built-in: the external ntfy server and the UnifiedPush
distributor pipeline are gone. The Android app registers with the built-in `live`
transport and keeps its own authenticated WebSocket to the server - the foreground
service introduced in 4.3.6 - so push works out of the box with no distributor app, and
the server no longer registers, validates or contacts any user-supplied push URL. The
Android settings card gains one-tap delivery warnings and an action that hides the
persistent foreground card from the shade, the reminder delivery mode now cascades per
calendar and per event, and a reverse-proxy fix finally routes the Android live push
WebSocket through the bundled nginx - without it, live push could not connect through a
Docker deployment at all.

## Added

- **Hide the live-push card.** Android requires a foreground service to show a
  notification, but it is `IMPORTANCE_MIN` and the settings screen has an action
  that opens the channel settings where the card can be turned off entirely —
  the socket keeps running, only the persistent card disappears from the shade.
- **Delivery warnings.** The notifications card in the Android app warns - with
  a one-tap fix - when battery optimization, a missing exact-alarm permission or
  a dropped live socket would silently break delivery, and the persistent-card
  row links straight to the channel settings where the card can be hidden.
- **Delivery mode per calendar and per event.** The reminder delivery mode
  (regular notification vs insistent alarm) can now be chosen per calendar and
  per event in the UI, with an inherit default; it sits as a sub-option under
  the lead time.

## Removed: ntfy / UnifiedPush

- **Push is built into Inboxora now.** The Android app registers with the `live`
  transport: no endpoint, no distributor app — it authenticates with its push device
  token over the WebSocket it keeps open anyway. The server no longer registers,
  validates or contacts any user-supplied push URL, so the ntfy service, its
  reverse-proxy routes and its environment keys can be removed from a deployment.
- Existing `unifiedpush` registrations are migrated to `live` by
  `0172_live_push_transport.sql`; the app re-registers on its next start anyway.
- FCM stays available as the optional provider transport for builds compiled with
  their own `google-services.json`; such builds never run the live socket (or its
  foreground notification) at all — the provider wakes them.
- On Android the UnifiedPush connector dependency, the distributor discovery,
  install and help actions, and the `InboxoraPushService` receiver are gone: no
  ntfy app to install and configure, push works out of the box.
- **Deployment cleanup.** The compose files no longer ship the `ntfy` service
  or its volume, `docker-compose.external-ntfy.yml` and the `push-stack` CI
  workflow are gone, nginx no longer routes `/push`, `/up` or `/v1`, and
  `PUSH_BASE_URL`, `PUSH_ALLOW_PRIVATE_ENDPOINTS` and the `NTFY_*` keys left
  `.env.example`. Deployments can remove the ntfy container, its volume and
  any hand-written proxy routes for it.

## Changed

- **Calendar reminder cascade.** A per-event override with *enabled* now wins over
  a muted calendar and even over a muted global default, so one pinned event can
  ring as an alarm while everything else stays silent. The delivery mode
  (notification vs insistent alarm) inherits through the whole cascade: event
  override → calendar `notify_mode` (new, `0173_calendar_notify_mode.sql`) → global
  preference.

## Fixed

- **Live push behind the bundled nginx.** The Android live push WebSocket (`/api/push/native/ws`) rode under the standard `/api/` proxy, which drops the upgrade headers and closes idle sockets after 60 s, so the live push service could never connect through the bundled reverse proxy. Both server blocks (and the native-install template) now route it as an exact-match location with WebSocket upgrade and a 24 h read timeout. If you run your own proxy in front of Inboxora, make sure it passes WebSocket upgrades for that path as well.

## Known safe limitations

- **Hiding the card does not stop the service.** The live socket keeps running when the
  persistent card is hidden; Android still lists the running foreground service in the
  system settings.
- **Exact alarms on Android 14+** are still denied by default for new installs; without
  `SCHEDULE_EXACT_ALARM` the reminder timing uses `setAndAllowWhileIdle` and can drift by
  a few minutes in Doze. The settings card deep-links to the permission screen.

## Upgrade requirements

> **Warning: the compose deployment changes shape in 4.3.7.** The `ntfy` service, its
> volume and the `docker-compose.external-ntfy.yml` override are gone from the compose
> files. After the standard pull and `docker compose up -d`, remove the leftovers yourself:
> `docker rm -f mailflow-ntfy`, then find the old volume with `docker volume ls` (it is
> named like `<project>_ntfy_data`) and remove it. Delete `PUSH_BASE_URL`,
> `PUSH_ALLOW_PRIVATE_ENDPOINTS` and any `NTFY_*` keys from `.env` - they are ignored now.
> A hand-written reverse proxy must pass WebSocket upgrades for `/api/push/native/ws`
> (and `/ws`) with a long read timeout and must not strip the path. See
> [Upgrading](Upgrading.md#upgrading-to-437) for the full checklist.

- Run migrations `0172_live_push_transport.sql` and `0173_calendar_notify_mode.sql`
  (additive; no new configuration keys).
- Android devices need the new APK (`versionCode 4030700`) for the live transport
  and the delivery warnings.

## Validation

- Backend: `npm run typecheck`, `npm run lint`, full vitest suite (340 files, 4333
  tests passed).
- Android: `:app:compileDebugJavaWithJavac`, `:app:testDebugUnitTest` passed.
- Frontend: `npm run typecheck`, `npm run lint`, full test suite (3935 tests),
  `npm run test:i18n` (2699 checks) and `npm run build` passed; native locale
  catalogs unchanged.
- CI planner: `node --test scripts/ci-plan.test.mjs
  scripts/release-source.test.mjs` passed, and `docker compose config` accepts
  both compose files with the ntfy service removed.

