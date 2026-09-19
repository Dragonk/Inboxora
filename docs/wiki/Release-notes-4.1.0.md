# Release notes 4.1.0

**Status:** prepared on `dev`, **not released** — a version is released when `dev` is merged to `main`
· **Previous version:** 4.0.4 · **Type:** minor

## What this release is

4.1.0 adds the **native provider integration layer**: connecting Google and Microsoft accounts so
Inboxora can pull their **contacts and calendars** directly, instead of relying on a feed URL or a
CSV export. It also builds the **native Microsoft Graph mail adapter** — the code that reads, files
and flags Microsoft mail through Graph instead of IMAP — hardens the DAV server, and fixes several
defects found while doing so.

The policy it implements is deliberately asymmetric, because the two providers are not in the same
position:

- **Google is optional.** Mail keeps working over IMAP/SMTP with an **app password**, exactly as
  before. Registering a Google OAuth client adds the contacts and calendars pull; it does **not**
  migrate mail, does not ask for Gmail permissions, and not configuring it leaves the app-password
  path fully available.
- **Microsoft needs the connection for mail.** Outlook.com and Microsoft 365 no longer accept a
  mailbox password, so those accounts need an authorized connection. Microsoft mail travels over
  OAuth2 IMAP/SMTP, and the **native Graph transport is now implemented and wired** (read, file,
  flag and **send** through the single send seam); no account is migrated to it in this release, so
  an existing account keeps using IMAP/SMTP until the in-place cutover (see limitations).

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
  enforced rather than cosmetic. Both methods exist for the **mailbox** sign-in and for the **Graph
  connector**: the connector no longer requires a callback or a secret to be authorized, so a
  public-client registration is enough to pull contacts and calendars.
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
- The **capability model** that decides collection access in the production request path, and the
  **typed provider-mutation layer** with an operation journal: a claim is committed before the
  provider call, so a recovered non-idempotent operation is parked as `outcome_unknown` rather than
  run a second time.
- The Graph connector's **device-code authorization**: the provider connection can be created by a
  public client — no secret and no callback — with the device code, the provider's poll interval and
  the last poll held on the flow row, so a restart does not strand a pending authorization. Requires
  migration **`0110`**.
- The **native Microsoft Graph mail adapter** (`backend/src/services/providers/microsoft/`): mail
  folder discovery and management (create, rename, delete, empty, ensure), message metadata sync
  with a per-folder delta cursor and a `410` rebuild, body and attachments (single, inline and ZIP),
  read/unread and star, mark-all-read, source headers, move, archive, single and bulk delete,
  spam/ham, snooze in both directions, conversation grouping on Graph's `conversationId`, and GTD
  label folders and copy removal. Every write goes through the shared mutation layer.
- Additive schema for the above (`0107`–`0109`): the mail-folder collection link, the message's
  provider identity with a partial unique index, and the operation payload that makes the pending
  pool drainable.
- The **send pipeline onto the canonical model, and its Graph transport**: one composition of the
  message, an explicit delivery envelope, a transport seam that binds an account to SMTP or Graph,
  and a Graph send that is **draft-first** — Graph JSON (so `bccRecipients` carries blind recipients
  out of band), attachments added inline or through a resumable upload session, then the send — with
  `accepted` / refused-before-acceptance / unknown-outcome told apart so an uncertain send is parked
  rather than retried.
- A `dev`-tagged image publication from the integrating branch. **The `dev` images are development
  builds, not this release**: 4.1.0 is released when `dev` is merged to `main`.

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

- Apply migrations **`0101`–`0110` in order, before rolling out the application**. They are
  additive; no existing table, column or row is rewritten. `0110` adds three nullable columns to
  `oauth_authorization_flows` for the device authorization and must be applied before a device flow
  is started, not merely before the application starts.
- New optional variables: `PROVIDER_INTEGRATIONS_ENABLED` (`0` disables the whole provider layer,
  including the sync paths) and `PROVIDER_SYNC_INTERVAL_MINUTES` (refresh cadence; `0` leaves
  syncing to the user). Both are documented in `.env.example` and the wiki.
- No provider credentials are required: with none configured, mail, contacts, calendars and DAV
  behave as in 4.0.4.

## Known safe limitations

- **Provider data is read-only.** Write-back, mutation journalling and the external CalDAV/CardDAV
  client are not in this release, so an imported collection cannot be edited, deleted or removed
  from Inboxora.
- **Graph mail is an adapter, not yet a transport for anyone.** The code paths above are exercised by
  tests and reachable for an account marked as a native Graph account, but **no account is migrated to
  it in this release** — the in-place cutover (P12) is not part of 4.1.0 — so an existing Microsoft
  account keeps reading mail over OAuth2 IMAP/SMTP. **Sending over Graph is implemented and wired**:
  a native account's send is created as a Graph draft, its attachments are uploaded, and only then is
  it sent, with an unknown outcome parked rather than retried; because no account is native yet, this
  path is exercised by tests rather than by live accounts. **Graph drafts are implemented**: saving a
  draft for a native account creates the provider's own draft (blind recipients stay out of band),
  re-saving patches that same object rather than leaving two, and deleting removes it at Microsoft
  first. **Provider-side search and the reply/forward dependencies are not implemented.** The Gmail API
  mail transport is not in this release either; Google mail continues with an app password.
- **Provider data is read-only, and so are imported calendars and address books.** Write-back, the
  external CalDAV/CardDAV client and provider CRUD (calendar and contacts create/update/delete) are
  not in this release, so an imported collection cannot be edited, deleted or removed from Inboxora.
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

Measured on `dev` at `dbf6077b`, with each gate's own exit status read rather than inferred from a
pipeline:

- Backend: **2523 tests passed, 117 skipped** (206 files passed, 14 skipped), typecheck and lint clean.
- Frontend: **2690 tests passed, 0 failed**, typecheck, lint and production build clean.
- Database: **215 integration tests across 21 suites** on PostgreSQL 16, with the full migration chain
  (113 migrations) applied to a fresh, empty database created for the purpose and dropped afterwards.

Not re-run for this revision, and therefore **NOT RUN** rather than passing:

- The **browser suite** and the documentation screenshots — last measured on the earlier 4.1.0 cut
  (205 browser tests across the desktop and phone projects; 30 screenshots referenced and non-empty).
- The **new CI jobs on a GitHub runner**: the workflow definitions and every path they reference were
  checked statically, but the jobs have not executed on a runner.
- **Live provider acceptance**: no real Google or Microsoft application is registered, so authorization
  against the live providers is **NOT RUN**. The DAV server has not been exercised with **DAVx⁵**.
- The **runtime smoke of a published image pair** against `/api/health`, `/api/version` and a basic
  login is **NOT RUN**.

A static review or a mocked test does not stand in for any of the above.
