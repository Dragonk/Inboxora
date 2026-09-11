# Inboxora Wiki

**Inboxora** is a self-hosted unified inbox for email, contacts and calendars. It speaks IMAP,
SMTP, CardDAV and CalDAV, so your data stays on your server and your existing devices keep
working. This Wiki is the canonical documentation for installing, configuring and using it.

Current release: **4.0.0** — see [Release notes 4.0.0](Release-notes-4.0.0.md) for what changed
against the upstream MailFlow fork.

![Inboxora mail list](https://raw.githubusercontent.com/Dragonk/Inboxora/main/media/screenshots/mail-list-desktop.png)

## Start here

| If you want to… | Read |
| --- | --- |
| Install Inboxora on a server | [Installation](Installation.md) |
| Add your first mail account and find your way around | [Getting started](Getting-started.md) |
| Understand threading, the reader and mail actions | [Email and threading](Email-and-threading.md) |
| Configure themes, languages, notifications and plugins | [Configuration](Configuration.md) |
| Use calendars, events and invitations | [Calendar](Calendar.md) |
| Manage contacts, imports and exports | [Contacts and DAV](Contacts-and-DAV.md) |
| Subscribe to external calendars | [External calendars](External-calendars.md) |
| Sync contacts and calendars to your phone (DAVx5) | [Contacts and DAV](Contacts-and-DAV.md) |
| Understand phone and tablet behaviour | [Mobile navigation](Mobile-navigation.md) |
| Harden a deployment | [Security](Security.md) |
| Fix something that is not working | [Troubleshooting](Troubleshooting.md) |
| Upgrade from 3.x or from MailFlow | [Upgrading](Upgrading.md) |
| Build, test or contribute | [Development](Development.md) |

## Core features

### Email

- Multiple IMAP/SMTP accounts with aliases, signatures and per-account colours, plus a
  unified inbox and unified search.
- **Real conversation threading** from a server-side conversation engine: a message and its
  replies become one conversation, while per-folder and per-account physical copies stay
  tracked separately. Expand a thread in the list or read it whole in the conversation reader.
- Native provider thread mapping for Gmail, Outlook/Microsoft 365 and generic IMAP, with manual
  merge, split and lock overrides when automatic grouping gets it wrong.
- Rules, block list, manual spam handling, snooze, archive and bulk actions with undo.
- Sandboxed HTML rendering with remote images blocked by default, attachments, inline images,
  a raw-headers viewer and in-message find.
- Live updates over IMAP IDLE and a WebSocket stream, plus optional Web Push notifications.

### Calendar

- Local writable calendars with month, week, work-week and agenda views, and a day agenda that
  follows your calendar visibility.
- Recurring events (`RRULE`, `RDATE`, `RECURRENCE-ID`, `EXDATE`) expanded with per-event time
  zones; editing one occurrence preserves the series.
- Invitations sent by email with delivery status and retry, and invitations received by mail
  added to a calendar in one click.
- Read-only **CalDAV** and **ICS/webcal** sources, plus anonymous `.ics` feed links.
- A generated **Contact dates** calendar for birthdays and anniversaries.

### Contacts and DAV

- Multiple address books with rich vCard fields, Google CSV import, and Google CSV / Outlook
  CSV / vCard 3.0 export.
- **CardDAV and CalDAV servers** with `.well-known` discovery and conflict detection, so DAVx5,
  Thunderbird and native clients sync both ways.
- **Revocable application passwords** for DAV clients, so TOTP- and SSO-protected accounts
  still work on your phone without sharing the login password.

### Interface and platform

- Desktop layout with resizable panels and a compact mode, plus a phone shell with a navigation
  drawer, floating actions and system Back support.
- Nine interface languages, ~24 themes, five reader layouts and configurable swipe actions.
- Installable PWA with an unread badge and push notifications; Electron desktop and
  Android/Capacitor shells are present and being stabilised.

## Screenshots

Captured from the running application: desktop at 1440×900 and phone at 390×844. The full set is
committed in [`media/screenshots/`](https://github.com/Dragonk/Inboxora/tree/main/media/screenshots).

| Email | Calendar | Contacts |
| --- | --- | --- |
| [Mail list](https://raw.githubusercontent.com/Dragonk/Inboxora/main/media/screenshots/mail-list-desktop.png) | [Month](https://raw.githubusercontent.com/Dragonk/Inboxora/main/media/screenshots/calendar-month-desktop.png) | [Details](https://raw.githubusercontent.com/Dragonk/Inboxora/main/media/screenshots/contacts-desktop.png) |
| [Conversation reader](https://raw.githubusercontent.com/Dragonk/Inboxora/main/media/screenshots/mail-conversation-desktop.png) | [Week](https://raw.githubusercontent.com/Dragonk/Inboxora/main/media/screenshots/calendar-week-desktop.png) | [Editor](https://raw.githubusercontent.com/Dragonk/Inboxora/main/media/screenshots/contact-editor-desktop.png) |
| [Threaded list](https://raw.githubusercontent.com/Dragonk/Inboxora/main/media/screenshots/mail-threaded-list-desktop.png) | [Agenda](https://raw.githubusercontent.com/Dragonk/Inboxora/main/media/screenshots/calendar-agenda-desktop.png) | [DAV access](https://raw.githubusercontent.com/Dragonk/Inboxora/main/media/screenshots/settings-dav-access-desktop.png) |
| [Phone mail](https://raw.githubusercontent.com/Dragonk/Inboxora/main/media/screenshots/mail-list-mobile.png) | [Phone calendar](https://raw.githubusercontent.com/Dragonk/Inboxora/main/media/screenshots/calendar-month-mobile.png) | [Phone contacts](https://raw.githubusercontent.com/Dragonk/Inboxora/main/media/screenshots/contacts-mobile.png) |

## About this Wiki

The reviewed source of every page lives in
[`docs/wiki/`](https://github.com/Dragonk/Inboxora/tree/dev/docs/wiki) and is published with
`scripts/publish-wiki.sh`. If you spot an error, open an issue or a pull request against
`docs/wiki/` rather than editing the Wiki directly, so the change is reviewed together with the
code.

Inboxora is an independently developed fork of [MailFlow](https://github.com/maathimself/mailflow)
by [maathimself](https://github.com/maathimself), licensed
[AGPL-3.0-only](https://github.com/Dragonk/Inboxora/blob/dev/LICENSE).
