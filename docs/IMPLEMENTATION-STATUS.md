# Implementation status against the v4 plan (P00–P14)

This is the honest per-package status of the v4 delivery (`Inboxora-plan-wdrozenia-v4.md`) on the
integration branch `dev`. It records what is **verified and integrated**, what is partial, and what
has not been started, with the commit that delivered each piece so the claims can be checked with
`git show <sha>`.

Nothing here is aspirational: a package is only marked delivered when its behaviour is covered by
tests — including integration tests against a real PostgreSQL where persistence, leases or cursors
are involved — and merged to `origin/dev`.

Last verified on `dev` at `953ba4be`: backend typecheck, lint and **2233 tests**; frontend
typecheck, lint, production build and **2644 tests**. `main` has not been touched by this work.

## Status

| Package | Status | Delivered (commit) | Missing |
| --- | --- | --- | --- |
| P00 — preparation/audit | n/a | — | Prepared against the existing baseline; no code artefact. |
| P01 — shared provider contracts | **partial** | `abbe2b9b` | The contracts and the registry are wired (the registry is read by the mail paths). `providers/capabilities.ts` is imported only by its own tests, so the capability table is not yet consulted in production. |
| P02 — additive schema (connections, grants, remote links, operation journal, outbox, notice preferences) | delivered | `abbe2b9b` (connections/grants/remote links, `0101`), `78b8c182` (journal/outbox, `0102`), `d4592756` (`0104`), `d7b8ceb9` (`0105`), `1a84536d` (`0106`) | `account_notice_preferences` exists but is unused until P12. |
| P03 — operation journal, sync leases, domain outbox | **partial** | `78b8c182` | The leases are wired: the Google and Microsoft connectors take them on every run. The **operation journal and the domain outbox are delivered and tested (16 cases) but nothing in production calls them** — they are the intended vehicle for P10 write-back and the P12 cutover, so they are dormant until those land. |
| P04 — OAuth flows and token service | mostly delivered | `ee788ca8` (Google web flow), `d4592756` (single-flight refresh + CAS), `524a5f00` (Microsoft refresh), `c30d13ba` (Microsoft Graph provider flow), `d4927e09` (Google flow in the UI), per-feature Google connect buttons; this session: `940d629a` (refresh re-reads the grant under the lease), `7dd0572d` + `3ed99007` (disconnect a connection, from the card), `bf9f340f` (the provider and per-method switches are enforced, not just reported) | Provider **device-code** authorization (the mailbox device flow exists; the Graph provider flow is browser-only). |
| P05 — mobile drawer gesture | delivered | `f76e1a40`, regression fixed in `143eca15` | Reachability verified and test-pinned: the pref defaults on, has a switch, persists through the server allow-list, and the hook's content/drawer/backdrop refs are attached to real elements, so the listeners cannot be attached to nothing. |
| P06 — send/draft ledger, attachment and MIME limits | **not started** | — | Durable upload/send ledger, separated file/total/MIME/HTTP limits, draft preservation on failure. See the note below on what is already enforced. |
| P07 — native Microsoft Graph adapters | **partial** | `524a5f00`, `c30d13ba`, `a9a3f975` (contacts), `d545ff45`, `c08fb7ae`, `f4d4fac1` | **Graph mail adapter** (blocks P12), Graph calendar adapter, provider device flow. |
| P08 — Gmail API mail adapter | **not started** | — | Labels/folders, message and thread ingest, attachments. |
| P09 — Google Calendar/People + MS Graph calendar/contacts | **partial** | `29bf023e` (People), `71558193` + `c8ea8383` (Calendar with generated VTIMEZONE), `d4927e09` + `8aff1d1e` (UI), `a2973f94` (schedule); Microsoft contacts under P07 | Microsoft Graph **calendar** adapter. |
| P10 — external CalDAV/CardDAV read-write, ICS/VCF/CSV import | **partial** | `6cf1a4bf` (vCard import), `6cccd470` (iCalendar import); Google CSV import pre-existed | External CalDAV/CardDAV **write-back** client. |
| P11 — DAV server hardening | mostly delivered | `0afab53d` (discovery/classes), `58f2c809` (strong `If-Match`), `d7b8ceb9` (per-collection visibility/mode), `1a84536d` (per-password ceiling), `db97a1af` (WebDAV `If` header), `6c6584cb` + `811a50d8` (connector status visibility) | Write-through result reporting, any remaining `DAV:` classes the plan lists. |
| P12 — account migration/cutover, MS-required and Google-recommended notices | **not started** | `acd1bf78` + `35451f02` cover the notices | The **notices** exist: the Microsoft card states that Outlook.com and Microsoft 365 no longer accept a mailbox password, and Google's recommendation is stated in that provider's own description. The **migration/cutover** is not started and stays deliberately blocked: a migration flow must not point users at a mail transport that does not exist yet (needs P07b/P08). |
| P13 — hardening, E2E, release notes | **partial** | `065b3f86` (provider setup procedure); i18n kept at nine locales throughout | End-to-end suite for the new flows, release notes for a chosen version. |
| P14 — final integration, CI, publish images | **not started** | — | Publish both `:dev` images and smoke-test the pair. Needs a release version and registry authorization. |

## Verification performed on a fresh database

The whole chain was re-applied **from zero** on an empty PostgreSQL 16 and every gated integration
suite was then run against that database, so the provider stack is proven on a schema a new
installation would actually have rather than on one evolved in place:

- all 109 migrations apply in order with no error, and the provider tables
  (`provider_connections`, `oauth_grants`, `integration_collections`, `remote_object_links`,
  `provider_operations`, `domain_outbox`, `sync_states`, `account_notice_preferences`) all exist
  afterwards;
- 89 integration tests pass across eleven suites: the provider authorization-flow table, Google and
  Microsoft token refresh (including the two-worker race), the operation journal and outbox, the
  Google and Microsoft contact syncs, the Google calendar sync, the provider disconnect and its reconnect cycle, and the DAV HTTP
  integration. The
  contact suites also assert the `sync_states` bookkeeping the connector status line reads: a success
  must leave a success time and clear the error, and a failure after the lease is taken must record
  both the code and the time, so that data source is regression-protected rather than verified once
  by reading the code.

## Documentation verification

The plan requires the documentation to match the built code (DO07), so the wiki was checked
mechanically rather than by reading: every API/OAuth path, DAV endpoint and environment-style
identifier quoted across `docs/wiki/*.md` was grepped against the sources.

Result: no documentation errors. Of 7 distinct paths and 46 identifiers, the five that the first
pass could not find in `backend/src` or `frontend/src` are all legitimate references to something
outside the application's own code — `SHCNF_FLUSH` is an Electron shell flag used by
`frontend/packages/electron/`, `POSTGRES_DB` and `INBOXORA_VERSION` are variables of the operator's
own container environment named in install and upgrade commands, `MAILFLOW_VERSION` refers to the
previous product's images in the migration guide, and `AADSTS50011` is a Microsoft-side error code
that by definition appears in their response, not in our code. They are recorded here so the next
reader does not re-open the same question.

## API contract check

The endpoints added in this work were re-checked against the fields the frontend actually reads,
field by field, rather than assumed: the three connector status payloads
(`configured`/`connected`/`connections` plus `books[]` or `calendars[]` and their five per-row
fields), the per-connection sync results, the three import payloads (`{ imported }`), and the route
error shape, which `api.ts` turns into the thrown message the UI displays.

The check is recorded because it is cheap and it found a real defect the previous round — the
calendar status endpoint was missing `lastErrorAt`, so the dialog rendered an empty
`… ( )`. On this pass every field matched. Re-run it after touching any of these endpoints.

## DAV visibility of imported data (verified, not assumed)

Whether data written by the connectors and the importers reaches DAV clients depends on
database triggers rather than on the routes, so it was verified directly against PostgreSQL
16 with the full migration chain rather than inferred from the code:

- **Calendars:** inserting a `calendar_events` row advances `calendars.sync_version` and sets
  `sync_token` to `sync-<version>`, which is the value the CalDAV endpoint advertises. The
  `.ics` import therefore no longer writes a token of its own — a random UUID it used to
  write replaced a well-formed one.
- **Contacts:** inserting a `contacts` row advances `address_books.sync_version`, from which
  the advertised CardDAV token `urn:inboxora:carddav:<book>:<version>` is derived. The
  importer's `bumpSyncToken` refreshes the `getctag` that older clients poll and is *not* what
  notifies collection-sync clients; that is now documented at the helper so it is neither
  relied on nor removed by mistake.

## Known failing end-to-end tests (open, must be fixed before release)

The Playwright suite is not part of the gates that were run during this work, and running it
found two things the unit and contract tests could not:

1. **Fixed:** `contacts-address-books.spec.ts` asserted that renaming an address book sends
   `{ name }` only. The rename dialog deliberately sends the book's DAV access as well, so the
   assertion had been stale since that dialog learned to edit both. The expectation now includes
   `davMode` and the spec passes.
2. **Fixed:** three mobile-navigation tests in `calendar.spec.ts` failed because the drawer
   stayed fully on screen after a module navigation and intercepted the next click. Root cause
   was in the drawer gesture hook: after animating, it handed styling back to React by *clearing*
   the inline transform. React does not re-apply a style it has already committed, so the drawer
   was left with no transform at all — rendering at its layout position, fully open — while the
   state said closed. A navigation click also fires `blur`, which aborts the gesture sequence and
   triggers exactly that path. It now restores the value React owns for the current state.
   Verified: the three tests pass, the full `chromium-desktop` project is green (123 passed, 59
   skipped), and the drawer-related specs pass on `chromium-mobile-390`.

Run the suite with:
`PLAYWRIGHT_BROWSERS_PATH=$PWD/../.pw-browsers npx playwright test --project=chromium-desktop`

## End-to-end verification across the viewport matrix

The Playwright suite was run on every configured project after the drawer fix, because the
regression it found was a mobile-layout bug that unit and contract tests had passed straight
through:

| Project | Result |
| --- | --- |
| `chromium-desktop` | 123 passed, 0 failed, 59 skipped |
| `chromium-mobile` (Pixel 7) | 81 passed, 0 failed, 101 skipped |
| `chromium-tablet`, `chromium-mobile-390`, `chromium-mobile-landscape` | 171 passed, 0 failed, 204 skipped |

Re-run after the later interface work (the disconnect control, the readiness gates and the new
strings), and again after the connector-card spec was added: `chromium-desktop` **124 passed,
0 failed** and the two mobile projects **189 passed, 0 failed**, so the changes since the first run
are covered by this gate too, not only by the unit suites.

`chromium-tablet` runs only the `v3-*` specs by configuration, so its coverage is narrower than
the others by design.

Run it with:

```
cd frontend
PLAYWRIGHT_BROWSERS_PATH=$PWD/../.pw-browsers npx playwright test --project=chromium-desktop
```

This is the gate that should run alongside the unit suites for anything touching layout,
navigation or the drawer; it is the only one that caught the drawer covering the page after a
navigation while every unit test passed.

### What is gated, and what is only verified

Reading the workflows rather than assuming them gives this picture. "Verified" means it was run
manually during this work and passed; "gated" means a workflow runs it for a `dev` push.

| Layer | Local default | CI on push to `dev` | CI on PR |
| --- | --- | --- | --- |
| Backend and frontend unit / contract tests | runs | **gated** (`ci.yml`) | gated |
| Real-PostgreSQL integration (provider sync, token refresh, OAuth flow table, DAV) | skipped — needs `DB_*` | **not gated** (`ci.yml` has no database service; the PG workflow is PR-to-`main` and runs one specific file) | not gated |
| Browser E2E, five projects | skipped unless run explicitly | **not gated** (`conversation-v2-playwright.yml` is `pull_request`-only) | gated |

So two of the three layers were verified but never gated, and the work was integrated by pushing
directly to `dev`. That is the complete explanation for two real defects surviving many rounds of
per-round verification: the verification was real, and narrower than it looked.

Recipes to close the two gaps, left unapplied because CI cost is an operator decision:

- **Database suites** — add a job to `ci.yml` with a `postgres:16-alpine` service and the `DB_*`
  variables, then run the gated files, e.g.
  `npx vitest run src/services/providerAuthService.integration.test.ts src/services/providerTokenService.integration.test.ts src/services/providerOperations.integration.test.ts src/services/providers/google src/services/providers/microsoft src/routes/davPg.integration.test.ts`
  with `REQUIRE_DAV_POSTGRES=1`. These pass against a fresh database with the full migration chain,
  so the job would also prove the migrations apply.
- **Browser suite** — add `push: branches: [dev]` to `conversation-v2-playwright.yml`, or integrate
  through a pull request so its existing trigger applies.

## Concurrency note on the refresh lease

A successful token store releases the refresh lease as part of writing the new token. That leaves
a window in which a worker that read an *expired* grant before another worker stored a fresh one
can acquire the now-free lease and refresh a second time with the token it read earlier. Where the
provider keeps its refresh token that is harmless; where it rotates one — Microsoft does — the
second exchange can invalidate the first worker's result, so the grant is now re-read under the
lease and a token that has become usable is returned instead of refreshing again.

Covered by the two-worker race test, which is the check that exposed the window: it failed once on
a fresh database, and passes repeatedly after the fix.

## Collection columns and their owners

`integration_collections` carries `enabled`, `source_access`, `user_access` and `dav_mode`. Only the
three connectors write them and **nothing reads them today**, so their values are inert: the
effective permissions come from `address_books`/`calendars` (`source`, `read_only`, `dav_mode`),
which the REST and DAV guards do read. `enabled` is the exception — the refresh schedule filters on
it.

That asymmetry is why a refresh no longer re-asserts any of them. Writing fields nothing reads looks
harmless, but `enabled` is read, and re-asserting it meant a disabled collection was switched back
on by the next sync. When P10/P12 give these columns readers, the sync must continue to leave them
to whoever owns them.

## Wired versus dormant

Reading the import graph rather than trusting the package list corrects two rows above: some of
this work is delivered and tested but not yet *called*. `syncCoordinator`'s leases run on every
connector sync, and the provider registry is consulted by the mail paths — but
`providerOperations.ts` (the journal and outbox) and `providers/capabilities.ts` have no production
importer.

That is not a defect: they were built as the vehicle for P10 write-back and the P12 cutover, and
those packages have not started. It does mean "delivered" in the table above should be read as
"the code exists and its tests pass", not "the application exercises it" — which is what the
per-package column now says for P01 and P03.

## The integrations card now has browser coverage

No spec referenced the integrations status, the card or its sub-tabs, so the browser suite's green
result said nothing about the connector interface this work changed. `e2e/integrations-card.spec.ts`
now drives it from the payload it renders — it opens Settings → Integrations → *Dostawcy poczty
e-mail*, expands the provider rows, and asserts:

- the Microsoft requirement is stated and names the account it applies to;
- the Google recommendation still comes from the provider description that predates this work, so
  the card does not contradict it;
- each connected account is listed, and disconnecting issues a request for **that** account rather
  than a provider-wide guess.

The full desktop project with it is 124 passed, 0 failed.

The related finding stands and is not fixed here: that Google description asserts the app-password
alternative **unconditionally**, and agrees with `traditionalImapAvailableInInboxora` only because
the flag is a constant `true`. If the traditional route is ever removed, the description is the text
to make conditional.

## Reported flags that are constants

Two readiness fields remain reported and unread, and both are constants rather than probes, so the
next reader does not mistake them for wired capability:

- `google.traditionalImapAvailableInInboxora` — hardcoded `true` in both readiness builders. The
  Google card now reads it before claiming an app-password alternative exists, so the statement
  follows the flag instead of asserting the capability, but the flag itself is not computed from
  anything.
- `deviceCode.supported` — `true` for Microsoft, `false` for Google with `reason: 'not_supported'`,
  also constants. The cards do not need them, because the Google card has no device section and the
  Microsoft one is gated on `deviceCode.ready`.

If either capability ever becomes configurable, the flag has to be computed before the description
around it can be trusted.

## Reachability check on the mobile gesture

A preference-gated feature can pass every test and still be unreachable — off by default, with no
switch, or with its listeners attached to refs that no element fills. Checked directly: the
preference defaults to on, `AdminPanel` renders a switch bound to it, its value survives a reload
through the server-side allow-list, and the gesture hook's content, drawer and backdrop refs are
each attached to a real element. A contract test now pins those four facts, so removing the switch
or the allow-list entry fails the suite rather than silently making the feature unconfigurable.

## Closed: the Microsoft device switch is enforced server-side

The saved configuration's `deviceEnabled` was read only to *report* readiness, so switching the
method off left `POST /oauth/microsoft/device` starting it. The route now reads the stored
configuration and answers `403` with a clear message when the method is switched off, and treats an
absent or unreadable row as "not switched off" rather than failing closed. The endpoint previously
had **no test at all**; it now has five, covering the unauthenticated, unconfigured, switched-off,
working and unreadable-configuration paths.

## Closed: the provider and per-method switches are enforced

`integration_config` stores `enabled` per provider and `webEnabled` / `apiEnabled` per method, and
none of them gated anything — a provider or method switched off stayed startable while the readiness
card still called it enabled. Both halves are now done together, because either alone is an
inversion: the report would say "unavailable" over a working route, or a route would refuse behind a
card that offers it.

- `services/providerSwitches.ts` reads the stored switches, defaulting to on for an absent row or an
  unreadable configuration — a configuration that cannot be read has not switched anything off. It
  lives in a service, not beside the settings routes, so the route modules that enforce it stay
  importable on their own.
- Enforced in `GET /oauth/microsoft`, `GET /oauth/provider/microsoft`,
  `POST /oauth/microsoft/device` and `GET /oauth/google`.
- The readiness report derives `enabled`, the browser readiness and the device readiness from the
  same switches, so the card stops offering a flow at the moment the flow stops accepting it.
- Covered by tests at every site: provider off and method off for each of the three Microsoft
  entry points and the Google one, plus the existing readiness cases.

## Closed: disconnecting a connected provider account

A provider account can now be disconnected from the interface. `POST
/api/integrations/provider-connections/:id/disconnect` is owner-scoped and does the conservative
thing: it revokes the grant, deletes the stored access and refresh tokens instead of leaving them
encrypted at rest, takes the connection out of service so no schedule touches it, and disables its
collections so nothing refreshes. **It deletes no imported data** — contacts, calendars and events
stay visible, because removing them is a separate decision and not a side effect of disconnecting.
Reconnecting the same account reactivates it through the normal flow and re-links the same
collections by remote id.

`/api/integrations/status` reports the caller's own connections per provider — ids only, never a
credential — and the card lists them with a **Disconnect** control, so the state needed to use the
endpoint is visible rather than only available over the API.

## Known limitations of what is delivered

- Pulled Google and Microsoft contacts and Google calendars are **read-only** in Inboxora: REST and
  DAV refuse to edit a collection whose source is not local, and the source is the writer. The
  authorization requests read-only scopes to match, so nothing asks for access it never uses.
- Imported collections also **cannot be deleted** from Inboxora: the delete path requires a local
  source, so an imported book or calendar stays visible (frozen after a disconnect) rather than being
  removable. That is deliberate — the source is the writer, so removing the copy would only invite the
  next refresh to recreate it (the foreign key clears the link rather than failing, so the delete
  would appear to work and silently undo itself). Pinned by tests for all three sources.
- An event Inboxora owns because invitations were sent for it is protected on every write path: the
  CalDAV `PUT` refuses it, the invitation ingest respects its sequence, and the `.ics` import now
  leaves it unchanged and reports the count rather than replacing it. The DAV
  side of that rule is pinned by tests for both protocols, including that a provider collection
  advertises read only even when its DAV mode says read-write.
- Recurring Google events keep their timezone through a **generated VTIMEZONE**; the generator reads
  the platform time-zone database, so a rule change needs no code change.
- Microsoft Graph calendar events are **not** imported yet, so they cannot hit the Windows→IANA
  timezone naming problem the plan warns about.
- The provider refresh runs in-process on a timer (default 15 minutes, one pass 30 seconds after
  start). There is no external scheduler, so a stopped server does not refresh — by design for now.
- Provider error codes surfaced in the UI are the recorded domain codes, not the providers' raw
  messages.

## How to continue the remaining packages

Entry points and constraints discovered while building what exists. They are recorded so the next
session does not have to rediscover them, not as a design that has been agreed.

**P07b — Microsoft Graph mail adapter.** Reuse `services/providers/microsoft/graphApiClient.ts` and
take `graphContactsSync.ts` as the template: discovery, `integration_collections`, `remote_object_links`,
a cursor in `sync_states` under the P03 lease, and per-object idempotent upserts. The open problem is
**not** the Graph calls but the account model: messages, folders and threads are keyed to
`email_accounts` (an IMAP account), while a provider grant belongs to a `provider_connection`, so the
adapter has to target an account. The plan is explicit that this switch is an explicit migration with
recorded intent, a configuration revision check and a checkpoint — **not** a silent transport change,
and the old engine must be stopped before the new one writes. `provider_operations.ts` and the
operation journal already exist for that work; read §12 of the plan before choosing the shape.

**P07d — Microsoft Graph calendar adapter.** The client, `utils/icalTimezone.ts` and
`utils/icalText.ts` already exist, and the Google calendar adapter
(`googleCalendar.ts` + `googleCalendarSync.ts` + `googleCalendarMerge.ts`) is a close template,
including the merge that keeps a series and its overrides in one resource. The hazard is time zones:
Graph returns **Windows** zone names (`Central European Standard Time`), which `icalTimezone.ts`
cannot resolve because it reads IANA ids. Decide deliberately between requesting
`Prefer: outlook.timezone="UTC"` (exact instants, but a local-time recurring series would drift
across DST unless the RRULE is converted) and adding a Windows→IANA table (keeps wall time, needs
maintenance). Do not ship either without a test that pins a summer and a winter occurrence.

**P08 — Gmail adapter.** `googleApiClient.ts` and `googleContactsSync.ts` are the templates; labels
map to folders and Gmail threads to the local thread model. It shares the P06/P07b account-model
question and should be designed together with it rather than twice.

**P06 — what is already enforced, and why the obvious slice is not one.** `send.ts` already
rejects more than 100 attachments and a total above 25 MB, and the HTTP body limit is 35 MB with a
route-aware 413 message. A *per-file* limit on top of that would be redundant while it equals the
total, and making it smaller is a product policy decision rather than something to infer — so the
real remaining work is (a) the MIME/content-type dimension, (b) counting **forwarded** attachments
against the same total, which today are validated by count only and whose sizes are known only after
the IMAP fetch, and (c) the durable ledger with draft preservation. Those need a limit definition
shared with the composer rather than a constant chosen inside the route.

**P10 — external CalDAV/CardDAV write-back.** The read-only pieces and the `remote_object_links`
rows are in place, and `provider_operations.ts` was written for exactly this: a write is an
operation with a generation, a terminal state and a typed failure, and a conflict must surface as a
domain code rather than an overwrite. The existing rule that a collection whose `source` is not
local refuses writes is what keeps an unimplemented write-back from silently doing nothing.

**P13/P14.** Needs the two decisions below before anything can be published: the release notes file
is named after a version, and publishing the images needs registry authorization.

## Open questions for the maintainer

1. **Release version** for `docs/wiki/Release-notes-<version>.md`. The repository requires release
   notes for every user-visible change and does not allow inferring a version, so the entries for
   this work are collected under `## [Unreleased]` in `docs/CHANGELOG.md` until a version is chosen.
2. **Registry/CI authorization** to publish `ghcr.io/dragonk/inboxora-backend:dev` and
   `...-frontend:dev` and smoke-test the pair (P14).
