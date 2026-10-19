# Notifications and background delivery

Inboxora delivers new-mail notifications over one canonical event and a set of
independent transports. Nothing detects "new mail" twice: IMAP IDLE / the mail
sync persists the message, and a single dispatcher fans the event out to every
channel.

```text
IMAP IDLE / mail sync
        │  new message persisted (messages.id = immutable event id)
        ▼
buildMailNotificationEvent()          src/services/mailNotificationEvent.ts
        │
        ▼
dispatchMailNotification()            src/services/pushDispatcher.ts
        │
        ├── Web Push  ──▶ push_subscriptions  (browser / installed PWA)
        └── Native    ──▶ push_devices        (Android)
                              │
                              ▼
                    built-in live push: an always-on WebSocket
                    to this server, authenticated by device token
                              │
                              ▼
                    Inboxora Android builds the notification locally
```

## Browser Web Push (unchanged)

Setting `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` keeps the existing behaviour:
the service worker (`frontend/public/sw.js`) shows the rich notification
(sender, subject, deep link, unread badge) and the browser subscription is stored
in `push_subscriptions`. Adding native push does not change this path.

## Desktop app (Electron) — native notifications

The Electron build does **not** use Web Push, VAPID or the server push dispatcher.
It reuses the WebSocket the app already has:

```text
WebSocket new_messages
        ▼
renderer (useWebSocket)  ──▶  preload (contextBridge)
                                  ▼
                          Electron main process
                                  ▼
                     Electron `Notification`  ──▶  OS notification
```

Consequences worth knowing:

- **No VAPID is required** for desktop notifications. They work on any install.
- Notifications arrive while the window is visible, minimized or hidden in the
  tray. After **Quit** the process is gone and nothing can arrive — that would
  need a WNS/APNs/background-service architecture, which is out of scope.
- **No duplicates.** Inside the desktop shell the app does not register its
  service worker at all (`public/sw.js` only ever handled Web Push) and Settings
  replaces the Web Push card with the system notification card. On the first run
  after upgrading from a build that *did* expose the browser card, an existing
  push subscription is unsubscribed and its registration removed, so a stale
  subscription cannot keep raising OS notifications next to the Electron ones.
  Web Push remains the browser/PWA path, unchanged.
- **The status is honest.** `Notification.isSupported()` only says the process
  *can* raise a notification; Windows silently drops toasts when the user turned
  them off for Inboxora. The card therefore shows the Inboxora switch and the
  operating-system state separately (read from the Windows notification
  registry; reported as unknown on Linux/macOS, where no equivalent is exposed),
  and words the plain enabled state as "enabled in Inboxora" rather than
  "system notifications are active". The state is re-read whenever the window
  regains focus — including right after using the shortcut below — so the card
  reflects a change the user just made in the operating system. A test that the
  OS confirmed also outranks a stale "turned off" reading.

### Settings

**Settings → Notifications → *System notifications***:

- a switch for new-mail notifications;
- a status line that distinguishes "enabled in Inboxora", "system notifications
  are working" (only after a confirmed test), "turned off in your operating
  system" and "unsupported";
- **Send test notification**, which shows a real OS notification through the full
  renderer → preload → IPC → Electron `Notification` path and reports what the
  operating system actually did: confirmed (Electron's `show` event), sent but
  *not* confirmed (no event arrived, e.g. a Linux session without a notification
  daemon), or the failure the OS reported. A silently blocked Windows toast is
  therefore visible as a failure instead of being reported as success;
- a shortcut that opens the operating system's notification settings (Windows:
  *ms-settings:notifications*, macOS: Notifications preference pane). It is
  always available where the platform supports it, not only after a failure.
  Linux has no portable settings URI, so the button is not offered there.

The preference is stored locally, per installation, in the Electron config file
under `app.getPath('userData')` (`desktopNotifications.enabled`, default `true`) —
deliberately not an account setting, so a home computer can notify while another
device stays quiet. It is independent of the notification-sound setting, which is
unchanged.

Notifications are suppressed in the **main process** when the switch is off, so no
other code path can show them by accident. Clicking a notification restores,
shows and focuses the existing window and opens the specific message; it never
creates a second Inboxora window.

### Window title bar

The desktop window uses Electron's `titleBarStyle: 'hidden'` with the Window
Controls Overlay instead of `frame: false`. The Inboxora bar carries Back,
Forward, Search (the existing Inboxora search engine, also `Ctrl+E` / `Cmd+E`) and
Settings, while minimize / maximize / close and close-to-tray stay native OS
behaviour. On Windows and Linux the `File / Edit / View / Window / Help` menu bar
is removed; its accelerators are re-registered on the window (`Ctrl+R` reload,
`F11` full screen, `Ctrl+W` close → tray, `Ctrl+M` minimize, `Ctrl+,` Change
Inboxora Host), and the tray keeps New Mail, Sync, Show/Hide, Change Host and Quit.

Back and Forward walk **Inboxora's own view history** (a bounded list of
surface + account + folder + open message + Settings tab), not
`webContents.navigationHistory`. Inboxora navigates by swapping Zustand state, so
the browser history never contained "the message I had open" or "the Calendar
view" — only real document loads such as login and OIDC. The application history
also keeps the existing origin/OIDC navigation policy as the only thing that can
put a document into the browser history.

Restoring a message works even when its folder page has been replaced in the
meantime (the normal case after visiting another folder or account). The exact row
id is tried first, so Back returns the copy the user was actually reading; only when
that row is gone does it fall back to the durable reference — the RFC `Message-ID`
header when the row exposed one, scoped to the message's account, else the row id —
through the same lookup the deep-link path uses. Both halves matter: the physical
row id is not stable (a move or re-sync can give the message a new one, and a lookup
by the old id would then find nothing), while a lookup by Message-ID alone would
prefer the INBOX copy of a message that also exists in Archive. The resolved row is
parked where the reading pane can render it, and a row that came back under a new id
replaces the history entry in place instead of counting as a new navigation, so
Forward survives. The Settings overlay starts below the title bar, so Back / Forward
/ Search / Settings stay clickable while Settings is open; that matters because Back
out of Settings requires Forward to be reachable to return.

## Desktop app (Electron) — default email app (Windows)

Windows does not let an application make itself the default handler, so Inboxora
registers itself as an *available* one and hands the choice to the user:

- the installer (and every app start) writes the email-client capabilities under
  `HKCU\Software\Clients\Mail\Inboxora` (name, description, icon, and the `mailto`
  URL association) plus the `Inboxora.mailto` ProgID with its
  `shell\open\command`, and lists the app in `RegisteredApplications`. That is what
  makes Inboxora appear under **Settings → Default apps** for both *Email* and the
  `mailto:` link type. On Windows the app deliberately does **not** call Electron's
  `setAsDefaultProtocolClient()`, which would write a second, legacy
  `HKCU\Software\Classes\mailto` handler and claim the generic key just by being
  launched; the installer also removes such a legacy handler when an earlier build
  left one (only while it is still Inboxora's own command). After the registry
  writes, the shell is told the associations changed
  (`SHChangeNotify(SHCNE_ASSOCCHANGED)` with `SHCNF_FLUSH`) — from the installer
  natively and from the app on re-registration, where the wait for it is bounded
  (2 s) and best-effort. Without that notification Windows keeps serving a cached
  association list, so the Default apps page opened immediately afterwards would
  still show the old state;
- **Settings → Notifications → Default email app** reports whether Inboxora is the
  current handler (read from the `mailto` `UserChoice\ProgId` Windows keeps),
  re-asserts the registration with *Set as default*, and opens the Windows
  default-apps page where the user confirms it: the per-app page
  (`ms-settings:defaultapps?registeredAppUser=Inboxora`) on Windows 11, the general
  list on Windows 10, which only has that. The card states plainly that Windows asks
  for that confirmation, instead of implying the button does it alone;
- "registered" means the registration is *complete* — the `mailto` URL association
  points at Inboxora's ProgID, the `RegisteredApplications` entry points at its
  capabilities, and the ProgID still has a launch command. A half-written
  registration (an interrupted upgrade, a cleaned-up key) reports
  "not registered" and the button repairs it, **even when Windows still points at
  Inboxora**: a handler that cannot launch is not a working default, and showing it
  as the default would also hide the repair;
- the state is re-read when the window regains focus, so returning from Windows
  Settings shows the result.

Outside Windows there is nothing to configure, and the card says so rather than
offering a button that cannot work. `mailto:` links that Windows hands to Inboxora
open the composer through the existing deep-link/second-instance path.

## Android — instant notifications

### How it works, in one paragraph

Inboxora does not use Firebase. The Android app keeps its own WebSocket
connection to your Inboxora server - an always-on `specialUse` foreground
service authenticated with the device's push token - and receives new-mail,
flag-change and mail-state events directly from it. Push is built into
Inboxora: no push service, no distributor app, no extra domain, no extra
certificate. When a message is read on any device, its notification is
dismissed everywhere.

FCM remains an optional transport for builds compiled with their own
`google-services.json`; those builds never run the live socket.

### Why a foreground service

Android only lets a killed app be woken by a push channel. Inboxora's live-push
service keeps that channel itself: the WebSocket runs in a foreground service,
so Android shows a low-priority system notification for it. The settings card
links straight to the channel settings where that card can be hidden from the
shade - the socket keeps running.

Keep Inboxora exempt from battery optimization (the settings card offers the
exemption with one tap), or Android will suspend the socket and delay
notifications.

### Step by step

```text
1. Install the Inboxora Android app and log in.
2. Go to Settings -> Notifications.
3. Allow notifications if asked (the card deep-links to the setting when denied).
4. Check that the status reads "Active"; fix any warning the card shows
   (battery optimization, exact-alarm permission for reminders, dropped socket).
5. Optionally hide the low-priority live-push card via the card's link.
```

Inboxora registers the device automatically and never asks you to copy an
endpoint or token. In the settings card you can tap *Check again* to
re-register.

### What the live connection carries

The device WebSocket carries **only** an opaque wake-up:

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
| `transport` | `live` (or the optional `fcm` for google-services builds) |
| `endpoint` | empty for `live`; legacy distributor endpoints, **encrypted at rest** |
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

The same message can reach the device over the WebView WebSocket, native push and the
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

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `APP_URL` | — | Public origin; the Android app's live push WebSocket connects to it. |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | off | Browser Web Push (unchanged). |
| `FCM_SERVICE_ACCOUNT_JSON` | unset | Optional FCM transport for builds with their own Firebase project. Not required. |

Nothing above is required: with no configuration the web app and PWA Web Push
work exactly as before, and the Android app opens its live push socket to the
same origin as soon as you log in — no extra service, endpoint or app.

## Reverse proxy requirements

The bundled nginx (`frontend/nginx.conf`) already upgrades the `/ws` WebSocket
and hands it to the backend. If you put your own proxy (Zoraxy, Nginx, Traefik,
Caddy, Cloudflare, ...) in front of Inboxora, it must:

- **preserve the `/ws` path** — do not strip or rewrite it; the bundled
  nginx performs the WebSocket hop to the backend;
- support **WebSocket upgrade** (`Upgrade` / `Connection`) for `/ws`;
- pass `X-Forwarded-For` and `X-Forwarded-Proto`;
- not impose a short idle timeout — the live push socket is long-lived. A
  read timeout of at least a few minutes (the bundled nginx uses 3600 s) is
  recommended;
- terminate TLS with a valid certificate (Android refuses cleartext push).

Example for an external nginx fronting the Inboxora container:

```nginx
# Forward everything to the Inboxora frontend; it performs the /ws upgrade
# itself. Preserve the original path and scheme.
location / {
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

- The settings card shows a **battery optimization** warning — Android will
  suspend the live socket. Use the card action and set Inboxora to
  *Unrestricted*. Detailed steps are in [Troubleshooting](Troubleshooting.md).
- The settings card shows an **exact alarm** warning — reminders need
  `SCHEDULE_EXACT_ALARM` on Android 14+. Grant *Alarms & reminders* via the
  card action, then *Check again*.
- The settings card shows a **dropped socket** warning — the live WebSocket
  is not connected. Tap *Check again*; if it persists, check the reverse proxy
  requirements above (WebSocket upgrade and idle timeout for `/ws`).
- **Notifications delayed after the app is closed** — Android battery
  optimization is often the cause; set Inboxora to *Unrestricted*. Detailed
  steps are in [Troubleshooting](Troubleshooting.md).

## Privacy implications

- There is no third-party push hop: the live socket connects the device
  straight to the user's own Inboxora server, authenticated with a device
  token that never leaves the account. No push payload ever transits an
  external topic server.
- Optional FCM builds (compiled with their own `google-services.json`) route
  notifications through the operator's own Firebase project; the default
  build never talks to Firebase at all.
- The Inboxora server remains the only party that sees mail content, and it is
  the user's own server. Device endpoints/tokens are encrypted at rest and are
  never written to normal logs.


## Manual device test (not automated in CI)

CI verifies the server and the `/ws` proxy route; it cannot verify a physical
Android device. Run this once on a real phone before declaring the Android build
release-ready:

```text
Setup
  1. Install the Inboxora APK and log in to https://<your-domain>.
  2. Open Inboxora -> Settings -> Notifications. Wait for "Active" and
     resolve any delivery warning the card shows.
  3. Keep a stopwatch ready; the target is a few seconds from arrival.

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
suspending the app, or a reverse proxy closing the live (/ws) WebSocket.
```

## Manual desktop test (not automated in CI)

CI exercises the main-process logic with unit tests and a stubbed Electron
(`desktop-settings.test.cjs`), and the renderer helpers with `desktopShell.test.ts`.
It cannot boot a signed build, so run this once on the built installer of each
released desktop target — **Windows and Linux**, the two platforms the packaging
workflow builds — before declaring a desktop release ready. macOS packaging is not
part of `publish-apps.yml` yet (it needs Apple Developer ID signing and
notarisation secrets), so there is no `.dmg` to test.

```text
Notifications (built installer, not electron:dev)
  1. Inboxora open                -> new mail shows an OS notification
  2. Inboxora minimized           -> notification still appears
  3. Inboxora hidden in the tray  -> notification still appears
  4. Switch off                   -> no notification at all
  5. Switch back on               -> notifications work again
  6. "Send test notification"     -> a real OS notification appears
  7. Click the test notification  -> the window is restored and focused
  8. Click a new-mail notification-> the correct message opens
  9. Send one mail                -> exactly one notification (no Web Push duplicate)
 10. Restart Inboxora             -> the on/off choice survived

Upgrade from a build with browser Web Push enabled
  - Settings must show "System notifications" (not the Web Push card)
  - send one mail: exactly one notification, never two
  - the old subscription is gone (Application -> Service Workers is empty)

Windows notifications blocked by the OS
  - turn Inboxora notifications off in Windows Settings
  - the card must say the OS has them turned off (not "working") and offer
    "Open system notification settings"
  - the test button must report a failure rather than success
  - turn them back on in Windows, return to Inboxora *without* reopening Settings:
    the status must update on focus

Windows default email app
  - Settings -> Notifications -> "Default email app" is present (Windows only)
  - with Outlook as the default: the card says Inboxora is registered but not the
    default, and offers "Set as default"
  - "Set as default" writes the registration and opens Windows Default apps — the
    per-app page for Inboxora on Windows 11, the general list on Windows 10 — where
    Inboxora is listed for Email and for the mailto: link type, already reflecting the
    registration (not the state from before it)
  - merely launching Inboxora must not create HKCU\Software\Classes\mailto; only the
    Inboxora.mailto ProgID and the RegisteredApplications entry appear
  - upgrading over a build that did write that legacy key must remove it on install
    (and leave a foreign handler in place if the command is not Inboxora's)
  - with a deliberately damaged registration (delete
    HKCU\Software\Clients\Mail\Inboxora\Capabilities\URLAssociations\mailto), the card
    must report "not registered" rather than "registered", and "Set as default" must
    repair it
  - after picking Inboxora there and returning, the card reads "Inboxora is your
    default email app" without reopening Settings
  - clicking a mailto: link in another app opens the Inboxora composer
  - on Linux/macOS the card says the choice is Windows-only and offers no button

Title bar
  - drag the window; double-click the empty part of the bar
  - minimize / maximize / restore / close-to-tray from the native controls
  - Back and Forward across: mail list -> message -> Calendar -> Contacts ->
    Settings, then all the way back and forward again; disabled states at both ends
  - Back from Settings returns to the surface Settings was opened from
  - with Settings open, Back / Forward / Search / Settings are still clickable
  - Back to a message that lives in another folder or account: the message opens
    (it is re-fetched), not just the mailbox
  - if the message was moved or re-synced in the meantime (new row id), Back still
    opens it and Forward still returns to where you were
  - if the same mail exists in two folders (INBOX + Archive), Back returns the copy
    you were reading, not the INBOX twin
  - search uses the Inboxora search engine; Ctrl+E / Cmd+E focuses it
  - Settings opens the existing Settings screen at Notifications
  - Ctrl+R reload, F11 full screen, Ctrl+W close-to-tray, Ctrl+M minimize,
    Ctrl+, Change Inboxora Host
  - dark mode and light mode (the native control symbols follow the theme)
  - Windows scaling at 100% / 125% / 150% and the minimum window size
  - no File / Edit / View / Window / Help bar is visible (Windows/Linux)
  - the browser build shows none of the above (no desktop title bar)
```

