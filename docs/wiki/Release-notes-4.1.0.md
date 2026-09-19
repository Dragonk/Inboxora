# Release notes 4.1.0

**Status:** released 2026-09-19 · **Previous version:** 4.0.4 · **Type:** minor

## What this release is

4.1.0 adds the **native provider integration layer**: connecting Google and Microsoft accounts so
Inboxora can pull their **contacts and calendars** directly, instead of relying on a feed URL or a
CSV export. It also hardens the DAV server, and fixes several defects found while doing so.

The policy it implements is deliberately asymmetric, because the two providers are not in the same
position:

- **Google is optional.** Mail keeps working over IMAP/SMTP with an **app password**, exactly as
  before. Registering a Google OAuth client adds the contacts and calendars pull; it does **not**
  migrate mail, does not ask for Gmail permissions, and not configuring it leaves the app-password
  path fully available.
- **Microsoft needs the connection for mail.** Outlook.com and Microsoft 365 no longer accept a
  mailbox password, so those accounts need an authorized connection. Microsoft mail itself still
  travels over OAuth2 IMAP/SMTP in this release; the **Graph mail transport is not part of 4.1.0**
  (see limitations).

Everything the providers deliver is **pulled read-only**. Editing, deleting or removing an imported
collection through Inboxora is refused with a reason rather than silently undone at the next refresh:
the provider is the writer of its own data, and Inboxora does not pretend otherwise.

## Connecting accounts

An administrator configures the provider once, under **Settings → Integrations → Email providers**,
and each user then authorizes their own account. The two roles stay separate, and configuring an
application creates no account.

- **Google**: Client ID, Client Secret and the exact redirect URI, with a step-by-step procedure and
  the card reporting readiness per method. **There is no Google device-code option** and none is
  offered: Google's limited-input device flow does not carry the Gmail, Calendar or People scopes.
- **Microsoft**: Client ID and tenant, with **two independent methods** — the browser flow (which
  needs a secret and the callback) and the **device code** (which needs neither, only *Allow public
  client flows* in Entra). Either can be configured without the other, and switching one off is
  enforced rather than cosmetic.
- **Per-method readiness** distinguishes "configured" from "working conditions present", the card
  states each provider's policy in place, and a provider, a method or the whole layer can be turned
  off — including installation-wide with `PROVIDER_INTEGRATIONS_ENABLED=0`, which also stops the
  sync paths.

Disconnecting an account revokes its grant and deletes its stored tokens; the imported data stays,
and reconnecting re-links the same collections rather than duplicating them.

## Added

- Provider contracts and a registry, with additive schema (`0101`–`0106`): connections, grants,
  remote links, sync state, operations, an outbox and notice preferences.
- The Google vertical end to end: OAuth with PKCE, the Calendar and People adapters, discovery,
  scheduled refresh, collection settings, connector status, per-collection enable/disable.
- Microsoft Graph contacts, and the Microsoft device-code flow with a per-flow id, owner checks,
  separate readiness and server-side polling limits.
- A `dev`-tagged image publication from the integrating branch.

## Fixed

- **Device-code polling** could make the server call Microsoft once per poll; a poll arriving before
  the provider's interval is now answered from the flow's own state.
- The **refresh schedule ignored `Retry-After`**; a throttled provider now doubles the wait towards a
  ceiling, with jitter, and a healthy pass returns to the normal cadence.
- A **CalDAV time-range query** returned every recurring candidate, including series that never
  occur inside the window; the recurrence projection now decides.
- **DAV report dispatch** used a substring search, so a multiget naming a resource whose filename
  contains another report's name was read as that report; the root element decides.
- The **DAV and OIDC response bodies** were unbounded; both are capped and refuse the excess.
- An **ICS import could overwrite an invitation-owned event**; the import now leaves those untouched
  and reports a protected count.
- A **provider refresh could re-enable a collection** the user had disabled.

## Configuration and migration requirements

- Apply migrations **`0101`–`0106` in order, before rolling out the application**. They are
  additive; no existing table, column or row is rewritten.
- New optional variables: `PROVIDER_INTEGRATIONS_ENABLED` (`0` disables the whole provider layer,
  including the sync paths) and `PROVIDER_SYNC_INTERVAL_MINUTES` (refresh cadence; `0` leaves
  syncing to the user). Both are documented in `.env.example` and the wiki.
- No provider credentials are required: with none configured, mail, contacts, calendars and DAV
  behave as in 4.0.4.

## Known safe limitations

- **Provider data is read-only.** Write-back, mutation journalling and the external CalDAV/CardDAV
  client are not in this release, so an imported collection cannot be edited, deleted or removed
  from Inboxora.
- **Graph mail and the Gmail API mail transport are not implemented.** Microsoft mail continues over
  OAuth2 IMAP/SMTP; Google mail continues with an app password. The two-transport documentation
  therefore describes one transport.
- **The migration prompt with *Ignore* and "do not show again" is not in this release.** What exists
  is the requirement stated on the Microsoft card, and the enforced provider/method/installation
  switches. The dismissal controls belong to the migration work.
- **No metrics are exported**, and logs carry a safe code rather than structured correlation and
  operation identifiers; both are recorded as outstanding.
- The provider card has **no "test configuration" action**: readiness reports that the fields are
  present, not that the provider accepts them, so a mistyped secret reads as ready until an
  authorization fails at the provider.
- Device-code, browser and API paths are verified by tests against faked providers and a real
  database; **no real Google or Microsoft application was registered**, so the end-to-end
  authorization against the live providers is **NOT RUN** rather than passing.

## Verification

- Backend: 2275 tests, typecheck and lint clean.
- Frontend: 2655 tests, typecheck, lint and a production build.
- Database: 99 integration tests across twelve suites on a fresh PostgreSQL 16 with the full
  migration chain applied in order.
- Browser: 205 passed, 0 failed across the desktop and phone projects.
- Documentation screenshots: 30 images, all referenced and non-empty.
