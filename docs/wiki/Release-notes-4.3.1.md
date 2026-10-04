# Inboxora 4.3.1

Released **2026-10-04**.

[Downloads](https://github.com/Dragonk/Inboxora/releases/tag/v4.3.1) ·
[Changelog](https://github.com/Dragonk/Inboxora/blob/v4.3.1/docs/CHANGELOG.md) ·
[Upgrading](Upgrading.md#upgrading-to-431)

Inboxora 4.3.1 is a maintenance release for 4.3.0. It fixes duplicate rows in expanded mail
threads and includes several provider, notification, rendering and CI reliability corrections.
There are no new database migrations or environment variables in this release.

## Fixed

- **Duplicate messages in expanded thread lists.** Some native providers expose the same logical
  email as more than one physical folder/provider copy. Inboxora 4.3.0 preserved those physical
  copies for correct provider actions, but the list also rendered each copy as a separate row.
  4.3.1 separates those concerns: the list renders one row per logical message while the backing
  physical copies remain available for read, star, move, archive and synchronization work. The
  thread count shown in the list follows the logical display rows as well.
- **Native provider push setup.** Gmail `mail_label` discovery is now treated as mail capability
  when enabling a Google push connection, matching the native Graph `mail_folder` path.
- **Native push fan-out.** An unexpected failure while handling one registered device no longer
  stops delivery attempts or accounting for the user's other devices.
- **CardDAV privilege parsing.** XML attributes on DAV privilege elements no longer interfere with
  capability detection, so annotated read/write privileges are interpreted correctly.
- **Message pane layout.** The div-based message renderer now restores original inline
  scroll-container styles before remeasurement and on cleanup, preventing nested content/quotes
  from getting stuck after resizing.
- **Theme fonts.** Retro theme fonts no longer remain selected after switching back to a normal
  theme because inherited object properties are no longer treated as theme names.

## Development and CI

Pull-request validation now plans work from the files changed by the PR. Documentation-only or
narrowly scoped changes can skip unrelated browser, PostgreSQL and runtime suites, while the
required final gates remain explicit. Additional regression tests were added around provider
configuration, search error paths, AI preferences/actions, theme fonts, recent folders and sender
favicons.

## Upgrade requirements

Back up PostgreSQL and `.env` as usual, then deploy matching **4.3.1** backend and frontend images.
No schema migration follows `0168_alias_default_recipients.sql`, no provider re-consent is needed,
and there is no new configuration key.

Use one of the immutable stable image tags:

- `ghcr.io/dragonk/inboxora-backend:4.3.1`
- `ghcr.io/dragonk/inboxora-frontend:4.3.1`

`v4.3.1` and `latest` point to the same multi-architecture AMD64/ARM64 manifests after release
publication. Android 4.3.1 uses `versionCode 4030100`. Windows, Linux and Android artifacts are
attached to the GitHub release after the signed native build completes.
