# Inboxora Wiki

**Inboxora** is a self-hosted unified inbox for email, contacts and calendars, with
IMAP/SMTP, native Google/Microsoft APIs, CalDAV and CardDAV.

Latest release: **[Inboxora 4.3.0](Release-notes-4.3.0.md)**.
[Downloads](https://github.com/Dragonk/Inboxora/releases/tag/v4.3.0) ·
[Upgrading](Upgrading.md#upgrading-to-430) · [Archive](Archive.md)

4.3.0 adds native MCP connections for external AI applications, secure in-app attachment
previews, per-alias default CC/BCC, provider-backed search improvements and several large-mailbox
query optimizations. MCP is disabled by default and attachment preview processing remains bounded.

![Inboxora mail list](https://raw.githubusercontent.com/Dragonk/Inboxora/main/media/screenshots/mail-inbox-desktop.png)

## Start here

| Task | Guide |
| --- | --- |
| Install the server, Docker images or native apps | [Installation](Installation.md) |
| Create an account and learn the workspace | [Getting started](Getting-started.md) |
| Read, compose, schedule and organize mail | [Email and threading](Email-and-threading.md) |
| Manage accounts, defaults, appearance and retention | [Configuration](Configuration.md) |
| Configure Google/Microsoft applications and consent | [Provider setup](Provider-setup.md) |
| Connect external AI applications with MCP | [External AI applications (MCP)](MCP.md) |
| Use events, invitations, recurrence and calendars | [Calendar](Calendar.md) |
| Manage books or connect other DAV clients | [Contacts and DAV](Contacts-and-DAV.md) |
| Connect CalDAV or ICS subscriptions | [External calendars](External-calendars.md) |
| Configure Web Push and native notifications | [Notifications](Notifications.md) |
| Navigate on a phone or tablet | [Mobile navigation](Mobile-navigation.md) |
| Upgrade while preserving data and credentials | [Upgrading](Upgrading.md) |
| Move a MailFlow 3.3.0 deployment | [Migrating from MailFlow](Migrating-from-MailFlow.md) |
| Diagnose an error or inspect maintenance progress | [Troubleshooting](Troubleshooting.md) |
| Secure or contribute to the application | [Security](Security.md) / [Development](Development.md) |

## Release documentation

[Release notes 4.3.0](Release-notes-4.3.0.md) contains the current feature changes,
limitations and migration order. **[Archive](Archive.md)** contains every older release-note
page, including 4.2.0. The Archive sidebar group is collapsed; existing page URLs and release
bookmarks remain valid. [Development changes](Release-notes-Unreleased.md) is reserved for
work after the latest release.

## Platforms and integrations

Use the web app or install it as a PWA, connect a Windows/Linux desktop app, or use the Android
app. Native apps connect to your existing server. Android notifications while the app is closed
require a UnifiedPush distributor; synchronization and device notifications are separate.

Mail accounts keep their configured IMAP/SMTP or native Gmail/Graph transport. Switching a
mailbox is explicit and in place. Calendar/contact authorization and per-collection write-back
are separate choices. Local metadata and selected caches are stored by Inboxora; cache expiry
never deletes the provider's mail. Read the relevant guide before enabling remote collection
deletion, which is distinct from local disconnection.

## About this Wiki

The reviewed source is in
[`docs/wiki/`](https://github.com/Dragonk/Inboxora/tree/main/docs/wiki) and is published with
`scripts/publish-wiki.sh`. Propose documentation changes in that source so they are reviewed
with the application. Screenshots live in the main repository and are checked by CI.

Inboxora is an independent [MailFlow](https://github.com/maathimself/mailflow) fork by
[Dragonk](https://github.com/Dragonk), with thanks to upstream author
[maathimself](https://github.com/maathimself), under
[AGPL-3.0-only](https://github.com/Dragonk/Inboxora/blob/main/LICENSE).
