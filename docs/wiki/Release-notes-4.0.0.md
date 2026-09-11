# Release notes 4.0.0

**Status:** preparing the release · **Previous version:** 3.4.0

## Why 4.0.0

Inboxora 3.x was a mail client. 4.0.0 is a personal information suite: the same application now
also owns your **calendar**, your **contacts**, and the **DAV endpoints** that sync them to your
phone. That is a change of scope, not a feature increment, and it is why this release steps the
major version rather than continuing the 3.x line.

Concretely, four things happened at once:

1. **A new subsystem for mail threading.** The conversation engine models conversations, logical
   messages and physical copies, maps provider thread identifiers (Gmail, Outlook, generic IMAP),
   and supports manual overrides, diagnostics and rebuilds. It changes how every mailbox is read.
2. **Three new product areas.** Calendar, Contacts, and CalDAV/CardDAV servers with revocable DAV
   application passwords.
3. **A rebuilt interface.** A new shell with resizable panels for Mail, Contacts and Calendar,
   plus a reworked phone layout and self-hosted typography.
4. **New deployment surface.** New database migrations, new endpoints, new settings, new
   credentials, and a new image contract for the release.

A minor version could not honestly describe that. See [Upgrading](Upgrading.md) for the practical
upgrade path.

## New in 4.0.0

### Email

- Server-side **conversation engine**: conversations, logical messages, physical copies,
  `Message-ID` identity with a fingerprint fallback, `In-Reply-To`/`References` parenting, and
  provider thread mapping for Gmail (`X-GM-THRID`) and Outlook (`Thread-Index`).
- Manual **merge, split, move and lock** overrides with **threading diagnostics** and a dry-run
  **rebuild** per account.
- Two independent views: a **threaded message list** and a **conversation reader**, plus quote
  folding, per-copy actions and per-copy read state.
- **Rules**, block list, snooze, one-click unsubscribe, categories, unified search and improved
  send reliability, including idempotent sending and Sent-copy handling.
- Sandboxed rendering with remote images blocked by default and an address/domain allow-list.

### Calendar

- Local writable calendars with month, week, work-week and agenda views and a day agenda.
- Recurrence with exceptions and per-event time zones, projected on the server.
- Event descriptions rendered through the same sanitised pipeline as message bodies.
- **Invitations sent by email** with sequences, cancellations, idempotency and retry, and
  **invitations received by mail** added to a calendar in one click without sending an RSVP.
- Read-only **CalDAV** and **ICS/webcal** sources and anonymous `.ics` feed links.
- A generated **Contact dates** calendar for birthdays and anniversaries.

### Contacts and DAV

- Multiple address books with rich vCard fields and read-only CardDAV imports.
- **Google CSV import** and Google CSV / Outlook CSV / vCard 3.0 export.
- **CardDAV and CalDAV servers** with `.well-known` discovery, ETag/If-Match conflict handling,
  sync tokens with tombstones and stable resource names.
- **Revocable DAV application passwords** so TOTP- and SSO-protected accounts sync to phones.
- A **CardDAV client** for pulling a remote server into read-only local books.

### Interface and platform

- The Ink-based shell, resizable panels, compact mode, and a phone layout with a drawer,
  floating actions, safe areas and system Back handling.
- Nine interface languages and a rebuilt settings surface, including a **DAV access** tab.
- PWA with an unread badge and Web Push; Electron and Android/Capacitor shells under
  stabilisation.

## Compatibility

- Existing preferences (theme, fonts, layout, widths, notifications) are **kept**, not reset.
- Threading is **off by default**; existing mail reads exactly as before until you enable it.
- Legacy identifiers from the MailFlow fork are retained deliberately so in-place upgrades keep
  their data. See
  [`docs/technical-identifier-audit.md`](https://github.com/Dragonk/Inboxora/blob/dev/docs/technical-identifier-audit.md).
- CardDAV and CalDAV clients authenticate with application passwords; primary login passwords are
  rejected on DAV endpoints.

## Known limitations

- No scheduled send, no undo-send delay, no send quota.
- No automatic spam classifier; spam handling is manual.
- Recurrence rules are read and expanded, but the interface does not author new `RRULE`s.
- No backup/restore feature in the application; back up PostgreSQL and `.env` yourself.
- Native desktop and Android builds are not release-ready.

## Detailed changelog

The exhaustive, change-by-change list against the upstream MailFlow fork — including the
migration inventory and the rationale for each new area — is published in
[`docs/CHANGELOG.md`](https://github.com/Dragonk/Inboxora/blob/dev/docs/CHANGELOG.md) with this release.
