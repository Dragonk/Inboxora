# Configuration

Everything user-facing is configured inside Inboxora, from the gear icon in the sidebar or the
user menu. Preferences belong to your account and follow you between browsers, except where
noted.

## Accounts

**Settings → Accounts** manages the mail accounts Inboxora synchronises.

| Setting | What it does |
| --- | --- |
| Provider preset | Fills IMAP/SMTP defaults for Gmail, Yahoo, iCloud or a custom server. |
| IMAP / SMTP host, port, TLS | `none`, `STARTTLS` or `SSL` per protocol. |
| Username / password | Usually the full address; for Gmail and others, an app password. |
| Sender name, colour | Used in the sidebar and on outgoing mail. |
| Aliases | Additional send-as addresses with their own Reply-To and signature. |
| Signature | Sanitised HTML per account, overridable per alias. |
| Unified inbox | Include or exclude this account from All Inboxes, unified search and totals. |
| Folder mappings | Sent, Drafts, Trash, Spam and Archive folders, auto-detected from IMAP flags. |
| Sync actions | Sync folders now, reconnect, re-index for search, toggle inbox categorisation. |

Microsoft 365 accounts use OAuth2 and need an administrator to register an Azure application
under **Settings → Integrations → Email providers**, where both providers are configured side by
side rather than in two competing places.

**Google has two methods and neither is forced.** An administrator can register a Google Cloud OAuth
client to enable the API-based integrations — connecting a Google account to pull its **contacts**
and **calendars** read-only — and a Google mailbox can equally be used with an **app password** over
IMAP/SMTP. Connecting the API does not migrate mail and does not ask for Gmail permissions, and not
configuring it leaves the app-password path fully available. The card states the recommendation rather
than a requirement.

**Microsoft is the other way round**: Outlook.com and Microsoft 365 no longer accept a mailbox
password, so mail for those accounts needs the API connection, and the card says so.

One further limit belongs here because it is about sending rather than about providers:
`MAIL_MAX_MESSAGE_BYTES` caps one **composed** message, counted on the server with headers, base64 growth and
separators included, and defaults to 25 MiB — Gmail's raw-message limit, the lowest an installation is likely to
meet. A message above it is refused with `413 MESSAGE_TOO_LARGE` and the real byte count **before** anything is
dispatched. Raising it raises no provider's own limit: passing this check means the installation accepted the
message, not that the provider will.

It also does not raise the **attachment upload** guard, which is a different quantity: the request that carries
attachments is base64 and therefore about a third larger than the files, so that guard measures the **wire** size
(25 MB of attachments, around 34 MB encoded, with headroom for the rest of the payload) and refuses with
`413 ATTACHMENT_TOO_LARGE` before any attachment is read from a mailbox; the uploads-plus-forwarded total refuses as
`413 MESSAGE_TOO_LARGE`. Raising `MAIL_MAX_MESSAGE_BYTES` without raising that one changes
nothing for a large attachment; the two are separate on purpose, and neither replaces the other.

Two switches govern the provider layer:

- `PROVIDER_SYNC_INTERVAL_MINUTES` — how often already-pulled collections are refreshed (15 by
  default); `0` disables the schedule and leaves syncing to the user.
- `PROVIDER_INTEGRATIONS_ENABLED` — `0` stops this installation offering or starting **any**
  provider authorization and stops the sync paths too, so an installation that must not call a
  provider does not; unset means enabled. The per-provider and per-method switches in the card narrow
  a configured installation further.

The same Entra application is also what the **Microsoft Graph** API integration uses. Its
authorization entry point is `/oauth/provider/microsoft` and it asks only for the scopes of the
purpose it was started with (`mail_migration`, `calendar_enable` or `contacts_enable`), so granting
calendars never grants the mailbox. It is deliberately separate from `/oauth/microsoft`, which is
the existing mailbox sign-in.

Step-by-step registration for both providers — the exact redirect URIs, environment variables,
permissions and a troubleshooting table — is in
[Connecting Google and Microsoft accounts](Provider-setup.md).

## Appearance

**Settings → Appearance** groups theme, layout and typography.

- **Theme mode** — **Follow system** switches automatically between your light and dark default
  as the operating system changes; **Always light** and **Always dark** pin one appearance
  regardless of the system.
- **Default light theme** and **Default dark theme** — choose the theme for each appearance
  separately from the roughly two dozen built-in themes. The light list and the dark list are
  picked independently, so a paper theme and a night theme can live side by side.
- **Ink** is the default light theme and **Dark ink** — its dark counterpart, dark paper with the
  same fountain-pen indigo accent — is the default dark theme. A fresh profile therefore follows
  the system and uses Ink in light mode and Dark ink in dark mode without any configuration.
- **Currently active** — the theme actually rendering right now, which depends on the mode and,
  under **Follow system**, on the operating system.
- **Layout** — focused, compact, comfortable, wide or vertical split; interface density; mobile
  navigation position (top or bottom).
- **Fonts and language** — multiple font pairings, a font-size scale from 80 % to 130 %, and
  nine interface languages: English, German, French, Spanish, Italian, Russian, Chinese
  (Simplified), Polish and Czech.

A theme chosen before separate defaults existed is kept: it becomes the default for its own
appearance and selects **Always light** or **Always dark**, so an upgrade never changes the look.

| Appearance on desktop | Appearance on a phone |
| --- | --- |
| ![Appearance settings](https://raw.githubusercontent.com/Dragonk/Inboxora/main/media/screenshots/settings-appearance-desktop.png) | ![Appearance settings on a phone](https://raw.githubusercontent.com/Dragonk/Inboxora/main/media/screenshots/settings-appearance-mobile.png) |

## Mail behaviour

**Settings → Appearance → Layout** also holds the reading and composing preferences:

- **Group messages into conversations** — the threaded list.
- **Conversation reader** — open whole conversations in the reading pane.
- **Rebuild conversations** — re-group the mail already in your mailbox, for accounts that were
  imported or migrated from elsewhere. It always asks for confirmation and starts in dry-run
  mode; see [Email and threading](Email-and-threading.md#grouping-mail-that-already-exists).
- Rich text or plain-text composing, and whether the Reply button replies to the sender or to
  everyone.
- Message previews, quick actions on hover, mobile sender avatars, and paginated or infinite
  scrolling with a page size.
- Sync cadence for mail and for the folder structure.
- When a message is marked read: immediately, after a short delay, or manually.

## Notifications

**Settings → Notifications** controls:

- The notification sound — none, a built-in sound, or your own audio file.
- The unread count badge on the app icon.
- **Web Push**, which needs the VAPID keys from the server environment
  ([Installation](Installation.md)). On iOS the app must be added to the Home Screen first.
- **Instant notifications** (Android app only). Inboxora ships **ntfy** as a
  UnifiedPush server on the same domain. Enter `${APP_URL}` (the origin, with no
  path) in the ntfy app. After installing
  the ntfy app on the phone and pointing it at that URL, the settings card shows
  *Active* with the provider (ntfy) and the push server. If no distributor app is
  installed it explains that one is needed and links to it; if notification
  permission is denied it links straight to the Android settings. Without a
  distributor, mail still syncs in the background.

See [Notifications and background delivery](Notifications.md) for the transport,
the data that does and does not pass through ntfy, the environment variables, and
device revocation.

Mail that a rule marks as read never raises a sound, toast or push notification.

## Privacy

**Settings → Privacy** manages remote content:

- Block remote images globally (the default), or allow them for individual messages.
- Manage the allow-list of addresses and domains.
- Optional Gravatar avatars — off unless you enable them.

## Swipe actions and shortcuts

- **Swipe actions** (phone) — assign an action to a left or right swipe: star, archive, delete,
  mark read, reply, reply all or nothing.
- **Shortcuts** — every keyboard shortcut can be rebound, with conflict detection and a reset to
  defaults.

## Calendar preferences

**Settings → Calendar** holds the calendar defaults:

- First day of the week (Monday or Sunday).
- Working days and working hours, used by the week and work-week views.
- The account used by default when sending calendar invitations.

The calendar panel itself remembers the last view you used, per device.

## Signatures, profile and lock screen

- **Signatures** are edited per account (and per alias) in **Settings → Accounts**.
- **Profile** — display name and avatar.
- **Screen lock** — an optional PIN (4–6 digits) with an automatic lock after 1, 5, 15 or 30
  minutes.

## Administration

Administrators see additional tabs, grouped as **Account & Mail**, **Calendar**, **Display**,
**Security & Integrations** and **Administration**:

| Tab | Purpose |
| --- | --- |
| Accounts | Mail accounts for every user on the instance. |
| Notifications | Instance-level notification defaults. |
| Rules / Block list | User rules and blocked senders. |
| Categories | Enable categories, tune Social sources, re-categorise existing mail. |
| Cleanup (beta) | Per-account bulk-mail summary and bulk archive/trash. |
| Calendar | The calendar defaults described above. |
| Appearance | Theme, layout, language and fonts, plus instance-wide custom CSS. |
| Shortcuts | Default keyboard shortcuts. |
| Security | TOTP, screen lock, login protection, mail-server connection policy, MFA enforcement, login log. |
| DAV access | Application passwords for CardDAV and CalDAV clients. |
| Integrations | Microsoft 365 OAuth app, remote CardDAV account, Todoist. |
| AI Assistant / AI Actions | Optional OpenAI-compatible provider and prompt shortcuts. |
| Plugins (beta) | Plugin activation; the GTD/Triage plugin ships with Inboxora. |
| Users | Users, invitations and the system email account. |
| SSO | OIDC providers and password-login control. |
| About | Version, build identifiers, licence, diagnostics report. |

![About settings](https://raw.githubusercontent.com/Dragonk/Inboxora/main/media/screenshots/settings-about-desktop.png)

The **About** tab is where you find the running version and both build identifiers — include them
when reporting a problem. The same panel generates the redacted diagnostics report described in
[Troubleshooting](Troubleshooting.md), and it is reachable on a phone like every other tab:

<img src="https://raw.githubusercontent.com/Dragonk/Inboxora/main/media/screenshots/settings-about-mobile.png" width="280" alt="About settings on a phone">

### Mail server connection policy

The Security tab controls what mail and calendar servers Inboxora may talk to: private and local
addresses, insecure TLS and non-standard ports are each gated. Tighten these on an instance that
must not be used to reach internal services.

### System email

**Settings → Users → System email** configures the SMTP account used for invitations, password
resets and email one-time codes. Without it, invitation mail falls back to the first SMTP-enabled
account owned by an administrator.

## Settings that are not in the interface

A few values exist only in the environment or in the database:

- `UPDATE_CHECK_DISABLED` turns off the server-side release check.
- `IMAP_MAX_PERSISTENT_PER_HOST` caps always-on IMAP connections per host.
- The conversation engine's automated-series segmentation mode is not exposed in the interface.
