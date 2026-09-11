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
under **Settings → Integrations** first. Google mail accounts are connected with a Google app
password.

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
- **Native push** (Android app only), reported as *connected*, *unavailable*,
  *permission denied* or *background fallback*. When notification permission is
  denied the screen links straight to the Android settings.

See [Notifications and background delivery](Notifications.md) for the transports,
the data that does and does not pass through an external provider, the required
environment variables, and device revocation.

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
