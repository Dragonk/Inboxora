# Notifications and background delivery

Inboxora delivers new-mail notifications over one canonical event and a set of
independent transports. Nothing detects "new mail" twice: IMAP IDLE / the mail
sync persists the message, and a single dispatcher fans the event out to every
channel.

```text
IMAP IDLE / mail sync
        │  new message persisted (messages.id = immutable event id)
        ▼
buildMailNotificationEvent()          src/services/mailNotificationEvent.js
        │
        ▼
dispatchMailNotification()            src/services/pushDispatcher.js
        │
        ├── Web Push  ──▶ push_subscriptions  (browser / installed PWA)
        └── Native    ──▶ push_devices        (Android: UnifiedPush or FCM)
```

## Browser Web Push (unchanged)

Setting `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` keeps the existing behaviour:
the service worker (`frontend/public/sw.js`) shows the rich notification
(sender, subject, deep link, unread badge) and the browser subscription is stored
in `push_subscriptions`. Adding native push does not change this path.

## Native Android push

### Why not the WebView's Web Push?

Android's `WebView` does not implement the Push API. Inside a Capacitor app
`reg.pushManager` is `undefined`, so the PWA subscription code cannot run and no
subscription is ever created. Even if it could, a killed app has no WebView
process to receive the event. Native push must therefore go through an Android
notification transport, not the browser one.

### Transports

The app picks the first transport it can, and the choice is invisible to the
server beyond the registered `transport` value:

1. **UnifiedPush** (default, self-hosted-first). The device uses a UnifiedPush
   distributor (ntfy, NextPush, …), which may itself be self-hosted. On
   `onNewEndpoint` the app registers that endpoint with its Inboxora server; the
   server later POSTs the opaque event to it. No central service and no
   server-side push credentials.
2. **FCM** (optional). Only active in an Android build compiled with its own
   `google-services.json`. The server then needs that project's service-account
   JSON (`FCM_SERVICE_ACCOUNT_JSON`) to send.

If neither is available the app silently falls back to the WorkManager
reconciler (see below); the web app is unaffected.

### What the push provider sees

The provider carries **only** an opaque wake-up:

```json
{ "type": "mail.changed", "eventId": "<message uuid>" }
```

It never sees the sender, subject, addresses or body. The app wakes on that
event and fetches the notification details from the user's own server
(`GET /api/push/native/messages/:id`), then builds the native notification
locally. The event id is the internal message UUID, which is also the
deduplication key.

### Device registration

`POST /api/push/devices` (requires a logged-in session) stores one row per
install:

| column | meaning |
| --- | --- |
| `user_id` | owner, taken from the session — never from the request body |
| `device_id` | app-generated stable id (UUID kept in app storage) |
| `platform` | `android` |
| `transport` | `unifiedpush` or `fcm` |
| `endpoint` | distributor URL / FCM token, **encrypted at rest** |
| `token_prefix`, `token_hash` | the Inboxora device token, hashed (bcrypt) |
| `app_version`, `created_at`, `updated_at`, `last_seen`, `failure_count`, `disabled_at` | bookkeeping |

The response contains a one-time **device token** (`mf_push_<uuid>.<secret>`).
It is stored on-device AES-GCM encrypted with an Android Keystore key (never in
plaintext, and the user's password is never copied to native storage). Registering
again rotates it, so a lost token self-heals. `GET /api/push/devices` lists
metadata only — endpoints and tokens are never returned.

### Background authentication

Background requests authenticate with the device token
(`Authorization: Bearer mf_push_…`) against the native-only mount
`/api/push/native/*`:

- `GET /api/push/native/messages/:id` — notification details for one event
  (ownership enforced in SQL).
- `GET /api/push/native/inbox` — latest unread message + authoritative unread
  total (reconciliation snapshot).

The device token has no access to accounts, admin, send or any other API; it is
revocable (row deleted / disabled) and scoped to those two reads. Delete/Star
notification actions still use the WebView session cookie (with the required
`X-Requested-With` CSRF header), preserving the existing authorization model.

### Deduplication

The same message can reach the device over the WebSocket, native push and the
reconciler. All three key on the immutable message UUID:

- the server suppresses a repeated dispatch for the same `userId:eventId` within
  60 s (bounded, in-process);
- the server includes `eventId` in the opaque payload;
- the Android side keeps a bounded (200 entries / 10 min TTL), persistent dedup
  cache in SharedPreferences, and derives a deterministic notification id from
  `eventId`, so a repeat for a message already shown is dropped and an update
  replaces the same card instead of stacking. Arrivals are grouped into one
  expandable notification via a group summary.

### WorkManager fallback and reconciliation

WorkManager is **not** the notification channel anymore. The periodic worker
(~15 min, Android-scheduled) now:

- reads `GET /api/push/native/inbox` (device token) or the legacy unread-counts
  endpoint (session cookie), compares the unread total with its baseline and
  only then asks the shared notification path to post the newest unread message;
- runs through the same dedup cache, so it cannot repeat a push notification;
- also re-asserts the push registration, recovering from a rotated provider
  token or a pruned server row.

### Multi-device

Each device is an independent row. Dispatch isolates every device: a permanent
provider rejection (404/410, FCM `UNREGISTERED`) disables only that row; a
transient failure only increments `failure_count`. A broken endpoint never
blocks Web Push or the other devices.

### Logout, host change, revocation

- Sign-out deletes **this** device's registration
  (`DELETE /api/push/devices/:deviceId`) while the session is still valid, then
  clears the local endpoint and device token; other devices are untouched.
- Changing or resetting the Inboxora host clears the native registration and the
  dedup cache before the new host is saved, so no notification survives for the
  old account/host. (A server that is permanently abandoned prunes the stale row
  after its retention window.)
- `POST /api/push/devices` re-registers after a fresh login.
- Admin/DB revocation: delete or disable the `push_devices` row; the next
  background request gets 401 and the app drops its local token.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | off | Browser Web Push (unchanged). |
| `VAPID_SUBJECT` | `APP_URL` | Contact for the push service. |
| `FCM_SERVICE_ACCOUNT_JSON` | off | Raw or base64 Firebase service-account JSON. Enables the optional FCM transport. |
| `PUSH_ALLOW_PRIVATE_ENDPOINTS` | `false` | Allow a UnifiedPush distributor on a private/LAN address. Off by default (SSRF guard). |

Nothing above is required: with no configuration the web app and PWA Web Push
work exactly as before, and the Android app uses UnifiedPush if a distributor is
installed, otherwise the WorkManager reconciler.

## FCM and self-hosting

An FCM registration token is bound to the Firebase project of the app that
obtained it. That has two consequences worth stating plainly:

- A **prebuilt** APK shipping the Inboxora project's `google-services.json`
  could only be messaged by an Inboxora-controlled sender — i.e. a central
  relay. That is why prebuilt builds should not bake in such a project.
- A **self-hosted** server can only send FCM to an APK that was built with the
  **same** Firebase project. So FCM is offered as bring-your-own-project:
  build the APK with your `google-services.json`, set
  `FCM_SERVICE_ACCOUNT_JSON` on your server, and no third party needs to see
  anything beyond the opaque event.

UnifiedPush avoids this trade-off entirely and is the recommended transport.

## Troubleshooting

- **No notification while the app is killed.** Check Settings → Notifications:
  the native row reports *connected* / *unavailable* / *permission denied*. If it
  says *unavailable*, install a UnifiedPush distributor (or the app build has no
  Firebase project); *permission denied* links to Android notification settings.
- **"Invalid endpoint" on registration.** The server rejected the endpoint URL
  (non-HTTPS, or a private host without `PUSH_ALLOW_PRIVATE_ENDPOINTS=true`).
- **Duplicate notifications.** The dedup cache is keyed by message id; a client
  that was reinstalled within the TTL can briefly re-notify once, which is the
  safe direction.
- **After switching servers, old notifications.** Confirm the app was signed out
  or the host changed in-app (both clear the registration); otherwise delete the
  `push_devices` row for that user.

## Privacy implications

- The external provider (UnifiedPush distributor or FCM) learns only that *some*
  device received *some* opaque event. It cannot read the mailbox.
- The Inboxora server remains the only party that sees mail content, and it is
  the user's own server.
- Device endpoints/tokens are encrypted at rest and are never written to normal
  logs; dispatch failures log a transport and a row id, not a token.
