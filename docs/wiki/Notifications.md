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
        └── Native    ──▶ push_devices        (Android)
                              │
                              ▼
                    built-in ntfy at ${APP_URL}/push
                              │
                              ▼
                    UnifiedPush distributor (ntfy Android app)
                              │
                              ▼
                    Inboxora Android builds the notification locally
```

## Browser Web Push (unchanged)

Setting `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` keeps the existing behaviour:
the service worker (`frontend/public/sw.js`) shows the rich notification
(sender, subject, deep link, unread badge) and the browser subscription is stored
in `push_subscriptions`. Adding native push does not change this path.

## Android — instant notifications

### How it works, in one paragraph

Inboxora does not use Firebase. Instead the Docker stack includes **ntfy**, an
open-source UnifiedPush server, published on the **same domain** as Inboxora at
`${APP_URL}/push`. On the phone you install the **ntfy** app, point it at
`https://your-domain/push`, and Inboxora registers a random endpoint with your
own Inboxora server. When mail arrives, Inboxora sends only an anonymous
`{"type":"mail.changed","eventId":"..."}` event through ntfy; the app wakes and
fetches the real notification details from your own Inboxora server.

No central Inboxora server, no extra domain, no extra certificate. One domain.

### Why a separate app is required

Android only lets a killed app be woken by a push channel. Inboxora supports the
open **UnifiedPush** standard, whose on-device half is a *distributor* app. The
recommended distributor is [ntfy](https://f-droid.org/packages/io.heckel.ntfy/),
which talks to the ntfy server that ships with Inboxora. Any other compatible
UnifiedPush distributor works too.

Without a distributor, Inboxora still works normally and the periodic
WorkManager reconciler keeps unread state in sync — you simply do not get
notifications while the app is closed.

### Step by step

```text
1. Install the Inboxora Android app.
2. Install ntfy (F-Droid, or the link shown in Inboxora).
3. In ntfy, set the server to:  https://your-domain/push
4. Open Inboxora.
5. Go to Settings -> Notifications.
6. Turn on Instant notifications.
7. Check that the status reads "Active" with the push server shown.
```

Inboxora detects the distributor automatically, registers the endpoint
automatically, and never asks you to copy an endpoint or token. In the settings
card you can tap *Open ntfy* to jump straight to the app and *Check again* to
re-register.

### What the push provider sees

ntfy carries **only** an opaque wake-up:

```json
{ "type": "mail.changed", "eventId": "<message uuid>" }
```

It never sees the sender, subject, addresses, body, attachments or account
names. The app wakes on that event and fetches the notification details from the
user's own server (`GET /api/push/native/messages/:id`), then builds the native
notification locally. The event id is the internal message UUID, which is also
the deduplication key.

### Device registration

`POST /api/push/devices` (requires a logged-in session) stores one row per
install:

| column | meaning |
| --- | --- |
| `user_id` | owner, taken from the session — never from the request body |
| `device_id` | app-generated stable id (UUID kept in app storage) |
| `platform` | `android` |
| `transport` | `unifiedpush` (or the optional experimental `fcm`) |
| `endpoint` | distributor endpoint, **encrypted at rest** |
| `token_prefix`, `token_hash` | the Inboxora device token, hashed (bcrypt) |
| `app_version`, `created_at`, `updated_at`, `last_seen`, `failure_count`, `disabled_at` | bookkeeping |

The response contains a one-time **device token** (`mf_push_<uuid>.<secret>`),
stored on-device AES-GCM encrypted with an Android Keystore key (never in
plaintext; the user's password is never copied to native storage). Registering
again rotates it, so a lost token self-heals. `GET /api/push/devices` lists
metadata only.

### Background authentication

Background requests authenticate with the device token
(`Authorization: Bearer mf_push_…`) against the native-only mount
`/api/push/native/*`:

- `GET /api/push/native/messages/:id` — notification details for one event
  (ownership enforced in SQL).
- `GET /api/push/native/inbox` — latest unread message + authoritative unread
  total (reconciliation snapshot).

The device token has no access to accounts, admin, send or any other API; it is
revocable and scoped to those two reads. Delete/Star notification actions use the
WebView session cookie (with the required `X-Requested-With` CSRF header).

### Deduplication

The same message can reach the device over the WebSocket, native push and the
reconciler. All three key on the immutable message UUID:

- the server suppresses a repeated dispatch for the same `userId:eventId` within
  60 s (bounded, in-process);
- the server includes `eventId` in the opaque payload;
- the Android side keeps a bounded (200 entries / 10 min TTL), persistent dedup
  cache, and derives a deterministic notification id from `eventId`, so a repeat
  for a message already shown is dropped and an update replaces the same card
  instead of stacking. Arrivals are grouped into one expandable notification.

### WorkManager fallback and reconciliation

WorkManager is **not** the notification channel. The periodic worker (~15 min,
Android-scheduled) now:

- reads `GET /api/push/native/inbox` (device token) or the legacy unread-counts
  endpoint (session cookie), compares the unread total with its baseline and
  only then asks the shared notification path to post the newest unread message;
- runs through the same dedup cache, so it cannot repeat a push notification;
- also re-asserts the push registration, recovering from a rotated endpoint or a
  pruned server row.

### Multi-device

Each device is an independent row. Dispatch isolates every device: a permanent
provider rejection (404/410) disables only that row; a transient failure only
increments `failure_count`. A broken endpoint never blocks Web Push or the other
devices.

### Logout, host change, revocation

- Sign-out deletes **this** device's registration
  (`DELETE /api/push/devices/:deviceId`) while the session is still valid, then
  clears the local endpoint and device token; other devices are untouched.
- Changing or resetting the Inboxora host clears the native registration and the
  dedup cache before the new host is saved, so no notification survives for the
  old account/host.
- `POST /api/push/devices` re-registers after a fresh login.

## Using an external ntfy

If you already run your own ntfy, point Inboxora at it and drop the bundled one:

```env
PUSH_BASE_URL=https://push.example.com
PUSH_ALLOW_PRIVATE_ENDPOINTS=false
```

```bash
docker compose -f docker-compose.yml -f docker-compose.external-ntfy.yml up -d
```

The override moves the bundled `ntfy` service into an unused profile, so it is
not started. Point the ntfy Android app at `PUSH_BASE_URL`; the `/push` path on
the Inboxora domain is then unused. The endpoint must be HTTPS (or, for a LAN
install with `PUSH_ALLOW_PRIVATE_ENDPOINTS=true`, HTTP on a private address).

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `APP_URL` | — | Public origin. The UnifiedPush base becomes `${APP_URL}/push`. |
| `PUSH_BASE_URL` | unset | Advanced: an external ntfy base. Overrides `${APP_URL}/push`. |
| `PUSH_ALLOW_PRIVATE_ENDPOINTS` | `false` | Allow a private/LAN (and http) UnifiedPush endpoint. Off by default (SSRF guard). |
| `NTFY_CACHE_DURATION` | `12h` | How long the bundled ntfy keeps an undelivered event. |
| `NTFY_DATA` | `ntfy_data` volume | Where the bundled ntfy stores its cache/auth database. |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | off | Browser Web Push (unchanged). |
| `FCM_SERVICE_ACCOUNT_JSON` | unset | Optional/experimental FCM transport for builds with their own Firebase project. Not required. |

Nothing above is required: with no configuration the web app and PWA Web Push
work exactly as before, the bundled ntfy is ready at `/push`, and the Android
app uses it as soon as a distributor is installed.

## Reverse proxy requirements

The bundled nginx (`frontend/nginx.conf`) already routes `/push/*` to ntfy,
stripping the prefix and upgrading WebSockets. If you put your own proxy
(Zoraxy, Nginx, Traefik, Caddy, Cloudflare, …) in front of Inboxora, it must:

- **preserve the `/push` path** and forward it to the Inboxora frontend (do not
  strip it there — the bundled nginx strips it for ntfy);
- support **WebSocket upgrade** (`Upgrade` / `Connection`) for `/push/*/ws`;
- pass `X-Forwarded-For` and `X-Forwarded-Proto`;
- not impose a short idle timeout — the UnifiedPush socket is long-lived. A
  read timeout of at least a few minutes (the bundled nginx uses 3600 s) is
  recommended;
- terminate TLS with a valid certificate (Android refuses cleartext push).

Example for an external nginx fronting the Inboxora container:

```nginx
location /push/ {
    proxy_pass         http://127.0.0.1:8080;   # Inboxora frontend nginx
    proxy_http_version 1.1;
    proxy_set_header   Upgrade $http_upgrade;
    proxy_set_header   Connection "upgrade";
    proxy_set_header   Host $host;
    proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;
}
```

Cloudflare and other CDNs must have WebSockets enabled for the zone.

## Troubleshooting

- **"Additional app required"** — no UnifiedPush distributor is installed.
  Install ntfy (the card links to it).
- **"ntfy is installed but not connected"** — the distributor's server is not set
  to this Inboxora's `/push` URL, or registration has not completed. Set the
  server in ntfy and tap *Check again*. See
  [Troubleshooting](Troubleshooting.md).
- **`/push` returns 502** — the bundled ntfy container is not running
  (`docker compose ps ntfy`), or an external ntfy with the override is expected.
- **Notifications delayed after the app is closed** — Android battery
  optimization is often the cause; exempt ntfy and Inboxora. Detailed steps are
  in [Troubleshooting](Troubleshooting.md).

## Privacy implications

- ntfy (your own server) learns only that *some* device received *some* opaque
  event. It cannot read the mailbox.
- Anonymous access to ntfy is restricted to UnifiedPush topics (`up` + 12 random
  base62 characters generated on-device, ~71 bits, never derived from a user id
  or address). Everything else is denied: the instance is not a public topic
  server.
- The Inboxora server remains the only party that sees mail content, and it is
  the user's own server. Device endpoints/tokens are encrypted at rest and are
  never written to normal logs.


## Manual device test (not automated in CI)

CI verifies the server, ntfy and the `/push` proxy; it cannot verify a physical
Android device. Run this once on a real phone before declaring the Android build
release-ready:

```text
Setup
  1. Install the Inboxora APK and the ntfy app.
  2. In ntfy, set the server to https://<your-domain>/push.
  3. Open Inboxora -> Settings -> Notifications. Wait for "Active".
  4. Keep a stopwatch ready; the target is a few seconds from arrival.

For each state, send yourself a mail from another account and time the
notification:
  A. Inboxora open in the foreground   -> notification within seconds,
                                          no duplicate from the in-app toast
  B. Home button (app backgrounded)     -> notification within seconds
  C. Removed from recent apps           -> notification within seconds
  D. Process killed by Android          -> notification within seconds
  E. Screen locked                      -> notification within seconds
  F. Device idle / Doze (screen off,
     unplugged, ~30 min)                -> notification still arrives
  G. Send five mails quickly            -> all arrive or are grouped, no loss,
                                          no pointless duplicates

Also verify the action buttons on the notification: Open opens the right
message, Reply opens the composer with the right context, Delete and Star apply
without opening the app.

If a state fails, see the Android section in
[Troubleshooting](Troubleshooting.md) — most failures are battery optimization
suspending ntfy, or a reverse proxy closing the /push WebSocket.
```

