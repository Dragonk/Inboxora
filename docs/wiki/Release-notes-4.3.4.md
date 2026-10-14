# Inboxora 4.3.4

Released **2026-10-14**.

[Downloads](https://github.com/Dragonk/Inboxora/releases/tag/v4.3.4) ·
[Changelog](https://github.com/Dragonk/Inboxora/blob/v4.3.4/docs/CHANGELOG.md) ·
[Upgrading](Upgrading.md#upgrading-to-434)

Inboxora 4.3.4 exposes external calendars and contacts (including Google and Microsoft accounts, as well as external CalDAV and CardDAV subscriptions) over Inboxora's built-in CalDAV and CardDAV servers.

## Added

- **Expose external collections over CalDAV and CardDAV.** Calendars and contacts synchronized from external accounts (Google, Microsoft Graph, remote CalDAV/CardDAV sources) are now exposed through Inboxora's CalDAV (`/caldav/`) and CardDAV (`/carddav/`) endpoints.
- **Configurable DAV sharing for provider collections.** The DAV sharing mode (`off`, `read_only`, `read_write`) can now be changed on external calendars and address books in settings, keeping the local collection and its `integration_collections` link synchronized.

## Changed

- **Default DAV sharing mode for synchronized collections.** New calendar and address book collections synchronized from external providers now default to `dav_mode = 'read_write'` instead of `off`, making them immediately discoverable and readable by external CalDAV/CardDAV clients.
- **Honest DAV privilege advertising.** In line with the provider capability model, external collections that do not support direct DAV protocol mutations advertise honest read-only DAV privileges to connecting CalDAV/CardDAV clients. Local collections retain full read-write capabilities.

## Database migration

- `0170_expose_external_collections_over_dav.sql`
  - Required order: runs immediately after `0169_deduplicate_conversation_ingest_failures.sql`.
  - Applied automatically on backend application startup.
  - Updates `calendars`, `address_books`, and `integration_collections` where `dav_mode = 'off'` to `'read_write'` so existing external collections become available over CalDAV and CardDAV.

## Upgrade requirements

Back up PostgreSQL and `.env` as usual, then deploy matching **4.3.4** backend and frontend images.
Migration 0170 runs automatically on startup. No provider re-consent is needed and there are no new
required configuration keys.

Use one of the immutable stable image tags:

- `ghcr.io/dragonk/inboxora-backend:4.3.4`
- `ghcr.io/dragonk/inboxora-frontend:4.3.4`

`v4.3.4` and `latest` point to the same multi-architecture AMD64/ARM64 manifests after release
publication. Android 4.3.4 uses `versionCode 4030400`. Windows, Linux and Android artifacts are
attached to the GitHub release after the signed native build completes.
