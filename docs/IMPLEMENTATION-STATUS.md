# Implementation status against the v4 plan (P00–P14)

This is the honest per-package status of the v4 delivery (`Inboxora-plan-wdrozenia-v4.md`) on the
integration branch `dev`. It records what is **verified and integrated**, what is partial, and what
has not been started, with the commit that delivered each piece so the claims can be checked with
`git show <sha>`.

Nothing here is aspirational: a package is only marked delivered when its behaviour is covered by
tests — including integration tests against a real PostgreSQL where persistence, leases or cursors
are involved — and merged to `origin/dev`.

**This document has two halves, and the split is deliberate rather than cosmetic.** Everything down
to the end of the *Status* table below is the state at the commit named here. Everything under
**History — failed approaches, corrections and long diagnostics** is the audit trail: attempts that
were reverted, verdicts that were corrected, and the long diagnostic paths that produced the current
rows. It is kept because its lessons are load-bearing, and it must never be read as a claim about the
present. Earlier revisions mixed the two inside the table itself, which is how a reader could take a
four-attempt saga — or a superseded delivery report — for a current status.

Last re-measured on `dev` at `b9177c3f`: backend typecheck, lint and **2422** unit tests
(**116 skipped** across 14 files); frontend typecheck, lint, production build and **2685** tests;
**188** database integration tests across **18** suites on a fresh PostgreSQL 16 with the full
**112**-migration chain — and, since the CI slice, verified the same way a new installation would
experience it: a database created empty for the purpose, the chain applied from zero, the suites run
against it, then dropped. That suite's one load-sensitive assertion has since been
**fixed rather than discounted**: `calendarResponsiveness.test.ts` bounded the pooled expansion's
event-loop lag at an absolute 100 ms and was observed failing at 162 ms on a machine that was busy
running another gate, with the pool working exactly as designed. Its bounds are now relative to the
inline run on the same machine — a starved timer records *no* samples, so the sample counts and the
lag comparisons still fail if the worker pool stops being used, while a busy runner can no longer fail
it. The browser matrix and the published-image smoke pair are deliberately
**not** part of this measurement: they are reported where they belong, under P13 and P14.
`main` has not been touched by this work.

> Superseded figures, kept so a reader who saw them is not left guessing: this header previously
> claimed verification at `953ba4be` with **2233** backend and **2644** frontend tests, and the
> report below was written at `f12727f6`/`48b94cbf` and re-measured at `d0b93bf4`. Those numbers
> were true of those commits and are not true of this one.

## Status

| Package | Status | Delivered (commit) | Missing |
| --- | --- | --- | --- |
| P00 — preparation/audit, **CI repair** | **delivered** | this work: `ci.yml` (`backend-database`, `pipefail` default), `conversation-v2-playwright.yml` (`push: [dev]`) | `ci.yml` runs `typecheck`, `build`, `lint` and the unit tests on every push, and now also a **`backend-database` job**: `postgres:16-alpine`, the migration chain applied to an empty database with the application's own runner, then the provider/DAV integration suites. The **browser matrix is on the `dev` gate** too, via a `push: [dev]` trigger. Every workflow that pipes sets `bash -euo pipefail`, so a pipeline's status is the real one — the failure mode that once put a red suite on `dev` behind a green-looking pipe. What is **not** verified is the GitHub plumbing itself: neither job has run on a runner, so action versions, cache paths and service wiring are unproven while the commands are exercised by hand. |
| P01 — shared provider contracts | **mostly delivered** | `abbe2b9b`, this work: `b0381b77` | The contracts, the registry and the capability table now **decide every collection operation**: the REST and DAV write guards, the DAV advertised privileges, the calendar delete and the contacts read-only flag all ask `services/providerAccess.ts`, which combines the origin adapter's declared support with the collection's own access and the device password's ceiling. Two things remain: the interface still derives calendar-event editability from `source === 'local'` in `CalendarSidebar.tsx` and `CalendarEventPreview.tsx` even though the server now reports the correct `read_only`, and **no remote adapter declares `writeThrough` yet**, so the model's answer for a provider-owned collection is "refused" until P09/P10 implement those writes. |
| P02 — additive schema (connections, grants, remote links, operation journal, outbox, notice preferences), **backfill of existing sources** | **partial** | `abbe2b9b` (connections/grants/remote links, `0101`), `78b8c182` (journal/outbox, `0103`–`0105`) | The schema is delivered, additive and preserves existing IDs. The **upgrade half is now covered**: `providerSchemaUpgrade.integration.test.ts` creates its own database, applies the chain up to the provider migrations, seeds existing rows, applies every migration from `0101` onwards (now `0101`–`0109`) and asserts those rows and their IDs survive — green inside the 161-test gate. Still missing: the **backfill** of existing sources, so today's ICS subscriptions, CardDAV accounts and IMAP accounts are still described only by their own older tables and the provider layer does not know about them; and `source_connections` has **no reader and no writer** in production code, so the external-source half of the schema is schema only. The four attempts that produced the upgrade case are in *History*. |
| P03 — operation journal, sync leases, domain outbox, **common ingest and mutation services** | **mostly delivered** | `78b8c182`, this work: `d89c42a3` | Leases are wired — the Google and Microsoft connectors take them on every run. The journal is now on a **production write path**: `services/providerMutationService.ts` gives mail, calendar and contacts adapters one typed contract (`confirmed`, `accepted`, `pending`, `retryable`, `conflict`, `permanent`, `outcome_unknown`), commits the claim **before** the provider call, parks a recovered non-idempotent operation as `outcome_unknown` instead of re-running it, and reports `outcome_unknown` rather than success when it loses its claim. The first adapter is an IMAP flag write, used by the read and star endpoints. Remaining: the IMAP path still hands an unconfirmed change to the pre-existing in-memory reconciler rather than to the journal's own pool, there is no calendar/contacts/send adapter yet, and `domainOutbox.ts` still has **no production enqueuer**. The `pending` pool *is* read now — the Graph mail sync drains scheduled flag mutations through it (`7076f4e1`). |
| P04 — OAuth flows and token service | mostly delivered | `ee788ca8`, `d4592756`, `524a5f00`, `c30d13ba`, `d4927e09`, `940d629a`, `7dd0572d` + `3ed99007`, `bf9f340f` | **Provider device-code authorization**: the mailbox device flow exists, but the Graph provider flow is browser-only. |
| P05 — mobile drawer gesture | delivered | `f76e1a40`, regression fixed in `143eca15` | Reachability verified and test-pinned: the pref defaults on, has a switch, persists through the server allow-list, and the hook's refs are attached to real elements. |
| P06 — send/draft ledger, attachment and MIME limits | **not started** | — | Durable send/draft operation state, separately enforced file / total / MIME / HTTP limits, per-provider effective limits, Graph upload sessions and interrupted-upload recovery, and draft preservation across a failed upload. Partly enforced today and worth naming so the package is not read as untouched: `send.ts` refuses more than 100 attachments and a total above 25 MB, `MAIL_MAX_MESSAGE_BYTES` counts the **composed** message and refuses with `413 MESSAGE_TOO_LARGE` before dispatch (tested), and the HTTP body limit is 35 MB with a route-aware message. |
| P07 — native Microsoft Graph adapters | **partial** | `524a5f00`, `c30d13ba`, `a9a3f975` (contacts), `d545ff45`, `c08fb7ae`, `f4d4fac1`, this work: `705b13bc` (folders), `011b2251` (messages), `7076f4e1` (flags), `08f40ad1` (body), `90bd9d02` (delete), `7ff67202` (move/archive), `694141eb` (spam/ham), `ed3dbc18` (snooze), `30372761` (bulk-delete), `24355f76` (mark-all-read), `de85be4d` (headers), `b9177c3f` (attachment zip) | Delivered: the Graph contacts adapter and sync, the mailbox device flow, and **twelve P07b slices** — (1) mail folder discovery, projected onto the local `folders` model with canonical paths for Outlook's well-known folders, linked by the immutable Graph folder id (`0107`); (2) **message metadata sync** with a per-folder delta cursor, identity in `messages.provider_message_id` (`0108`), the local-wins flag window and a `410` rebuild that reconciles; (3) **flag mutations over the shared layer** with a durable retry drained by the next sync (`0109`), and a permanent refusal undone rather than kept locally; (4) **body and attachments** read on demand, sanitised and cached in the shared columns, with inline images embedded and downloads addressing the Graph attachment id; (5) **delete**, which reuses the IMAP path's Trash-vs-permanent decision, re-homes the local row onto the identity a Graph move returns, and is declared non-idempotent so a recovered claim is parked rather than re-run; (6) **move and archive** to an arbitrary folder through both bulk routes, on the same helper, with Graph rows deliberately kept out of the IMAP delete-and-re-insert statement; (7) **spam and ham marking**, which had bypassed the dispatch entirely and failed on a native account, now on the same move with the verdict and training row written only after the provider confirms; (8) **snooze, both directions**, with the `Snoozed` folder created on the provider and discovered, and the wakeup moved onto the same shared helper; (9) **bulk delete**, both the permanent removal and the Trash move, with a shared `deleteGraphMessagePermanently` that single-message delete also uses; (10) **mark all as read**, one flag mutation per unread message, with the unread list taken before the local update flips it; (11) **source headers** read from Graph's `internetMessageHeaders` rather than reconstructed, with the pointless IMAP attempt removed from that path; (12) **the attachment ZIP**, one provider fetch per file under the same per-file ceiling, with the naming and packaging shared with the IMAP path. The shared helper is now the single implementation of the "adopt the identity a Graph move returns" rule for every Graph move. Missing: conversation persistence, rules/GTD verification, drafts and send, the **Graph calendar adapter**, and the **provider device flow**. Graph is therefore **not yet a mail transport**: the account still reads mail over IMAP/SMTP. |
| P08 — Gmail API mail adapter | **not started** | — | Labels rather than pretended folders, message/thread ingest, incremental history, body/attachments, mutations, drafts and send. Google keeps its supported IMAP/SMTP app-password path; the move to the API is **recommended, not required**, with an *Ignore* + "do not show again" suppression stored server-side per user **and** per account. |
| P09 — Google Calendar/People + MS Graph calendar/contacts | **partial** | `29bf023e` (People), `71558193` + `c8ea8383` (Calendar with generated VTIMEZONE), `d4927e09` + `8aff1d1e` (UI), `a2973f94` (schedule); Microsoft contacts under P07 | Delivered: discovery with per-collection switches, read-only pulls for Google People, Google Calendar (VTIMEZONE included) and Microsoft contacts, and the refresh schedule. Missing: **all provider-side CRUD** — no adapter issues anything but `GET` (verified: no `POST`/`PATCH`/`DELETE` in `googlePeople.ts`, `googleCalendar.ts` or `graphContacts.ts`) — and **Microsoft calendars are not imported**. A read-only collection must stay read-only once writes exist. |
| P10 — external CalDAV/CardDAV read-write, ICS/VCF/CSV import | **partial** | `6cf1a4bf` (vCard import), `6cccd470` (iCalendar import); Google CSV import pre-existed | The **external CalDAV/CardDAV write-back client**: `PUT`/`DELETE` on an imported collection is currently refused (correctly) instead of being forwarded to the source through the mutation layer. ICS-URL stays read-only; a locally imported ICS copy may be locally editable. |
| P11 — DAV server hardening | mostly delivered | `0afab53d`, `58f2c809`, `d7b8ceb9`, `1a84536d`, `db97a1af`, `6c6584cb` + `811a50d8` | Protocol hardening is delivered and tested (discovery, strong `If-Match`, per-collection visibility/mode, per-password ceiling, WebDAV `If`, refusals carrying a `DAV:error` body). Open: **the real-client acceptance run is NOT RUN** — no DAVx⁵, Thunderbird or macOS client has talked to the server — and the DV06 rows for large body, deep XML, traversal and CRLF remain NOT RUN. |
| P12 — account migration/cutover, MS-required and Google-recommended notices | **partial** (notices) / **not started** (migration) | `acd1bf78` + `35451f02` cover the notices | The **Microsoft requirement notice** is delivered (shown per entry, deliberately without a permanent "do not show again") and the **Google recommendation** text exists. The **migration/cutover is not started**, and is deliberately blocked on P07b/P08: an in-place migration must not point users at a mail transport that does not exist. No automatic fallback to Microsoft IMAP/SMTP. |
| P13 — hardening, E2E, release notes | **partial** | `065b3f86`, `6cccd470` + `6cf1a4bf`, the DAV work under P11, the browser gate and the acceptance reports; i18n at nine locales | Delivered: the 4.1.0 release and its notes (W19 met), the wiki pages, current UI copy, the unsupported-operations list, the W-list/matrix reports and the browser gate. Open: **metrics (§25.2)** — none exist and the logs carry no `correlationId`, `operationId` or provider request id; the §25.1 performance comparison; and the real-client DAV run. The installation-wide `PROVIDER_INTEGRATIONS_ENABLED` switch is enforced at the four authorization flows **and** the three sync routes; the call-site tracing that verified it is in *History*. |
| P14 — final integration, CI, publish images | **not delivered** — three separate parts, split below | — | `P14` is **not** one thing, and calling it delivered because images exist in a registry is exactly the error this split prevents. |

**P14, split into its three parts.** Only the first is done, and one of the remaining two has never
been run at all:

| P14 part | State | Evidence |
| --- | --- | --- |
| image build + registry verification | **done** | Published from one commit, `035f60ab1843a4a60c1d6379a0d5dbaec9304324` (the 4.1.0 release), by dispatched workflow run `35425837287`. Both `ghcr.io/dragonk/inboxora-backend:dev` and `ghcr.io/dragonk/inboxora-frontend:dev` resolve to OCI image indexes carrying `linux/amd64` **and** `linux/arm64`; digests are recorded under *Release 4.1.0 and the image publication*. |
| runtime smoke pair | **NOT RUN** | No container was ever started from the published pair: `/api/health`, `/api/version` and a basic login/UI check on those exact digests are unverified. The digests and platforms are registry facts, not a smoke test. |
| final v4 publication | **not done** | The published images correspond to `035f60ab` (the 4.1.0 release), **not** to the tip of `dev`, and v4 still has open packages (P06, P07b, P08, P09 CRUD, P10, P12). A final publish must wait for the exact final SHA after the scope closes, and then be followed by the smoke pair above. |

## History — failed approaches, corrections and long diagnostics

This section is the audit trail, moved out of the *Status* table so the table states only the current
state. Nothing here is a claim about the present. It is kept in full because the lessons are what
stopped the same mistakes being made twice, and because several of the corrections below are
corrections *of this document*.

### Superseded delivery reports

The document previously carried a "Final report (§30)" written at `f12727f6` on `dev`, re-measured at
`d0b93bf4` after the 4.1.0 release, and a per-section header claiming verification at `953ba4be` with
**2233** backend and **2644** frontend tests. Those figures were true of those commits and are
superseded. The sections that held them — *Final report (§30)*, *State when this was written*, and the
release/publish narrative — remain below as history; the current measurement is in the header at the
top of this file. The report itself was explicitly **not** a declaration of completed delivery, and
the scope it named as missing is still the scope this work owes.

### P02 — four attempts at an upgrade case over populated data

For a long time only the **fresh database** half of the package's acceptance was verified; the
**upgrade** half cost four attempts. The narrative is preserved verbatim, because the obstacles it
names are the ones the next person to touch the migration runner will meet:

The package's acceptance has two halves — **upgrade** and **fresh database** — and only the second is verified: the migration chain has been applied to an empty database repeatedly (109 migrations, then the gated suite), while the **upgrade path over existing data is not exercised anywhere**. `migrationUpgrade.test.ts` reads like it would cover this, but it is a mocked-runner test that asserts the SQL the runner issues for migration 0072's checksum handling; nothing applies 0101–0106 to a populated database and checks that existing rows and their IDs survive. That is the next real-database case for this package, and the piece it needs is now known rather than assumed: **`runMigrations()` takes no arguments** — it applies every pending migration in one go — so the case needs either an optional `toVersion`-style parameter on the runner, or a harness that applies the earlier files itself with the runner skipped. The first exercises the upgrade *path* the criterion is about, including the runner's own bookkeeping; the second only exercises PostgreSQL's behaviour on the DDL. Adding the parameter is therefore the better half of the choice, and it must leave the no-argument behaviour unchanged. An attempt at the second option — a test applying the chain by file — was made and reverted, and it failed on the first obstacle the next attempt will meet: **`CREATE INDEX CONCURRENTLY` cannot run inside a transaction block**, and a file sent to `pg` as one simple query runs as an implicit transaction. That is precisely what the `-- no-transaction` marker in those files is for, so the harness has to honour it — splitting statements for those files, or driving `psql` the way the manual verification does — and the first run of this suite is where that shows up. A second attempt mirrored the runner exactly — strip comment lines, execute each statement of a marked file separately — and **the whole chain then applied by file in a single test process**, which is the piece that was in doubt. It failed afterwards on the test's own seed insert into `contacts`, whose column set it had guessed rather than read. A third attempt supplied the real column list — `contacts.uid` is NOT NULL with no default, which is what the guessed insert had missed — and **the case passed on its own**: the whole chain applied up to the provider migrations, seeded rows survived 0101–0106 with their IDs, and the provider tables came up empty. Then the same file was run **with the rest of the gated set** and it failed, which is the constraint the next attempt must design for: on a shared database another suite applies the migrations first, so the case has nothing left to upgrade and its own guard refuses to pass vacuously. It therefore needs **its own fresh database** (created and dropped by the case, or a dedicated `DB_NAME`), not the shared one the other integration suites deliberately share. The file is not in the tree, but the harness shape it proved is: mirror the runner's `-- no-transaction` handling, seed with the real column list, and isolate the database. **A fourth attempt did isolate it** — the case created and dropped its own database and passed alone (2 tests) — and then **broke the shared run**: executed alongside the other suites, 8 of 12 files failed. So the isolation is necessary but not sufficient: running it alongside the shared suites broke them, 8 files of 12. **Why that happens is not established** — the plausible reading is that a case creating and dropping a database inside a parallel run disturbs its neighbours, but that is an inference from one observation, not a diagnosis, and the earlier version of this note stated the remedy as though it were. What can be said without inference: the case passes alone, and it must not be added to the shared invocation until the failure is understood — a separate invocation is the **suspected** requirement, not a verified one. That is the last thing known about it, and it means the work for P02's upgrade half is test *plumbing* — a second, sequential invocation against its own database — rather than the case itself, which has now been written four times and passed three of them. **The upgrade half is now tested** (`providerSchemaUpgrade.integration.test.ts`): a case creates its own database, applies the chain up to the provider migrations, seeds a calendar, a book and a contact, applies 0101–0106, and asserts those rows and their IDs survive — 99 tests across twelve suites green with it. Four attempts were needed, and one earlier conclusion in this row was wrong: the case appeared to break the shared gated run, which I attributed to running it alongside the others. The failures were `relation "users" does not exist` — the shared database had not been migrated in those runs because the case migrates only its own and I had skipped the step. The obstacles that were real are recorded above: no runner version limit, `CREATE INDEX CONCURRENTLY` needing the marker honoured, and `contacts.uid` being NOT NULL.

### P13 — tracing the installation-wide switch to its call sites

Verifying that `PROVIDER_INTEGRATIONS_ENABLED=0` actually stops every outbound provider call meant
tracing the call sites rather than trusting the switch's own documentation, which had overstated what
it covered. The tracing narrative is preserved because the method — follow every caller, then check
each entry — is the reusable part:

**It now reaches the sync paths too**: the three provider sync routes refuse with `403` and the scheduled refresh reports a run of nothing, so an installation with the layer switched off makes no outbound provider call for collections it pulled earlier either. The gap was found by checking the switch's own documentation against its enforcement, which had overstated it. **Coverage is now complete and verified by tracing the call sites**: the three sync services are called only from the two contacts routes, the calendar route and `runProviderSyncs`, and each of those four entries checks the switch — so no path reaches a provider while the layer is off. The per-provider and per-method switches still say which parts a configured installation offers.

### The same mistakes, named once

Each of these was paid for at least once, and they are collected here so they are not rediscovered:

- **Read the exit status, never the piped tail — and never a chain's.** `cmd | tail` returns *tail's*
  status, so a failing suite reached `dev` behind a green-looking pipe. This happened twice; the second
  time it put a red test on the branch under a commit message claiming a green run. A third variant
  happened later and is worth the sentence: a `typecheck && echo OK; lint && echo OK; tests` chain whose
  output was then **grepped for the test summary** let a failing `tsc` through, and a slice was pushed
  claiming all three gates green. The corrective is the same in all three: run each gate so its own
  exit status is the thing you read, and never cite a gate you did not read the status of.
- **A filename match is not coverage, and tool output belongs to the grep that produced it.** DV06
  was recorded as PARTIAL because three files "matched the XXE theme" in a shell call that ran several
  greps — the output belonged to a different one. The row had no test at all. The same habit produced
  the DV08 error in the opposite direction: a unit-level file was read, the integration suite that
  covered the case was not opened, and covered work was reported as NOT RUN.
- **Do not describe coverage from the wrong source.** This is the single most repeated error in this
  document: seven verdicts were corrected across the audit, and all but one moved in the direction of
  *more* work remaining. Records drift faster than code.
- **A conflict between two requirements is not a bug to force.** Dropping a stored client secret when
  the client id changes satisfies AD07 and breaks AD05, whose test asserts that an omitted secret on
  an edit is preserved. The resolution was the one AD07's own wording names — confirm the effects —
  not the naive fix.
- **A switch nothing reads is not a feature.** The capability table, the provider registry and the
  operation journal were all delivered and tested while no production module imported them. Delivered
  means "the code exists and its tests pass"; wired means a production path uses it. The two are
  different, and the status table above keeps them apart.

### Where the rest of the audit trail lives

The remaining long narratives are in their own sections below rather than in the table: the DAV
request-body cap and the three attempts it needed, the unbounded-body-reader sweep, the coverage audit
of the service layer and the two measurement errors it made first, the W01–W19 verdicts, the execution
matrix (AU/ML/AT/KC/DV/GE/MG/DC/AD/GN/DO/RE), the §8 agent-acceptance procedure, and the §12 send and
attachment specification that is the task list for P06/P07b/P08. They are current where they state a
verdict and historical where they narrate how it was reached, and the reader should treat them the
same way as this section.

## Verification performed on a fresh database

The whole chain was re-applied **from zero** on an empty PostgreSQL 16 and every gated integration
suite was then run against that database, so the provider stack is proven on a schema a new
installation would actually have rather than on one evolved in place:

- all 112 migrations apply in order with no error, and the provider tables
  (`provider_connections`, `oauth_grants`, `integration_collections`, `remote_object_links`,
  `provider_operations`, `domain_outbox`, `sync_states`, `account_notice_preferences`) all exist
  afterwards;
- **P11's acceptance criterion in the plan is a full loop with DAVx⁵**, and that has *not* been
  performed. What is verified is the protocol: discovery, policies, the change log, the preconditions
  and the write paths are exercised by unit, database and browser-level tests, and the requests they
  send are the ones a client sends. Nothing here has talked to an actual DAVx⁵, Thunderbird or
  macOS client, so client-specific behaviour — its exact `PROPFIND` bodies, its retry and error
  handling, its reaction to a refused `PROPPATCH` — is untested. That is the honest boundary of the
  DAV work, and it is the one acceptance criterion in P11 that remains open.
- 188 integration tests pass across eighteen suites: the provider authorization-flow table, Google and
  Microsoft token refresh (including the two-worker race), the operation journal and outbox, the
  provider mutation layer (the claim committed before the provider call, recovery of a crashed claim,
  replay, conflict, retry scheduling and claim fencing), the
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
field by field, rather than assumed: the connector status payloads
(`configured`/`connected` plus `books[]` or `calendars[]` and their per-row fields), the
per-connection sync results, the import payloads, and the route error shape, which `api.ts` turns
into the thrown message the UI displays.

The check is recorded because it is cheap and it found a real defect at the time — the calendar
status endpoint was missing `lastErrorAt`, so the dialog rendered an empty `… ( )`.

**What it covered then is not what those payloads are now**, so the scope is restated rather than
left implied:

- the import payloads gained a **`protected` count** with the invitation guard, and the card renders
  it;
- `connections` is no longer a count but the **array of the caller's own connections**, added for the
  disconnect control, and that control uses each entry's `id`;
- the status payloads gained **`graph`** (the connector's own readiness), **`mailPolicy`** and
  **`traditionalImapAvailableInInboxora`**, each of which the card reads;
- the disconnect endpoint answers **`{ connectionId, collectionsDisabled }`**, which the card
  discards by design — it refreshes the status instead;
- the DAV refusals and the request-too-large answer are **XML and `413` bodies**, not JSON, and are
  asserted where they live (P11) rather than here.

Each of those was checked as it was added, which is why the list is longer than the check; re-running
the whole set after touching any of these endpoints is still the right habit.

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

## What running the end-to-end suite found, and what happened to it

The Playwright suite was not among the gates run while this work was built, and running it found two
things the unit and contract tests could not. Both are now resolved, and the suite has been run
repeatedly since (see the matrix below), so nothing here is outstanding:

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

## The plan's execution matrix (`Macierz-testow-do-uzupelnienia.md`)

The delivery archive carries a second gate artifact beside W01–W19: an execution matrix of numbered
scenarios across **AU** (authorization), **ML** (mail), **AT** (attachments), **KC** (contacts and
calendars) and more, with columns ID / scenario / level / state / SHA-evidence. In the archive **every
row still reads `NIEURUCHOMIONY`** (not started).

It is not reproduced here, because copying it would create a second copy to drift. What belongs here is
which rows this work can already evidence, so the next session fills the matrix in the plan's own file
rather than reconstructing it:

| Row | Scenario | Evidence in this repository |
| --- | --- | --- |
| AU07 | Two workers refresh the same grant in parallel; no new refresh token is lost | `providerTokenService.integration.test.ts`, the race case — and the double-exchange window it exposed, fixed in `940d629a` |
| AU06 | A callback delivered into another session or user attaches no grant | **PASS.** Both provider callbacks compare the flow's stored user with `req.session.userId`, and on a mismatch mark the flow `failed` with `SESSION_MISMATCH` **and** answer `403` — so no grant is attached and the flow cannot be replayed through the same URL. |
| AU04 | Bad or replayed state, nonce, issuer, audience and PKCE are rejected without changing the account | **PASS.** The halves I had left unread are there: the authorization-flow row stores a **hashed** `state`, an **encrypted** PKCE `code_verifier` and a `nonce` per flow, and `takeAuthorizationFlow` consumes the row, so a replay finds nothing. On the OIDC side `jwtVerify` is called with `issuer` and `audience`, and `payload.nonce` is compared with the pending one before anything is accepted. Every refusal closes the flow (as `failed`, with a code) before an account or grant is touched, which is the row's second half. |
The remaining AU rows (AU01–AU03 partial consent, AU05 parallel flows by one user, AU08 no-rotation, AU09 revoked access, AU10 no false mail readiness, AU12 forged tokens in `POST /accounts`) split between **P09's per-collection switches** — AU01–AU03, AU10 — and the **P12 migration**, AU05/AU12 being the provider-flow halves; they are audited with those packages rather than here.

| AU11 | The same identity with a changed address or alias does not duplicate the account | `upsertProviderConnection` keys on user + provider + issuer + subject; the reconnect case in `providerConnectionService.integration.test.ts` asserts one row survives a disconnect and re-authorization |
| KC03 | Series with exceptions, a cancelled instance and a moved exception stay consistent | The Google calendar merge (`71558193`) with `c8ea8383`; the merge case "a moved instance and a cancelled event" passes in the provider suites |

More rows this work can evidence, all from tests observed passing in this session:

| Row | Scenario | Evidence in this repository |
| --- | --- | --- |
| DV03 | The intersection of DAV off / credential read-only / collection read-write, on every endpoint | `davCredentials.test.ts` for the per-password ceiling and `davVisibility.test.ts` for the per-collection mode; the write refusals are asserted per protocol |
| DV08 | Bad or weak `If-Match`, `If-None-Match: *`, two parallel `PUT` | **PASS.** `davPreconditions.test.ts` covers weak and tagged-list conditions (failing closed), and `davPg.integration.test.ts` runs two parallel `PUT`s with the same `If-Match` against a real database and asserts the statuses are exactly `[204, 412]` — one wins, one is refused, no lost update |
| DV16 | Importing an ICS file versus an invitation arriving by mail: separate processes, correct UID collision | `calendarIcsImport.test.ts`, which asserts that a file does **not** overwrite an event Inboxora owns through a sent invitation and reports it instead |
| DV19 | WebDAV `If` with a token and a collection Resource-Tag: compliant evaluation, no ignoring, no cross-user bypass | `davIfHeader.test.ts` with the `evaluateDavIf` decision table, tagged lists failing closed |
| GE06 | The gesture switch turned off, then a reload and a new sign-in: it stays off and the zone returns to the row | `f76e1a40` with the preference allow-list; the switch, its default and its persistence are pinned by a contract test |
| MG01 | A Google app password stays active without OAuth; Microsoft legacy needs Graph consent; a password is never converted into a token | The authorization requests read-only People/Calendar scopes, no mail transport changes, and no code path turns a password into a grant |
| MG04 | Standalone Google/Microsoft DAV, ICS and plain IMAP accounts: no migration is forced on them | Nothing in this work migrates or deletes another account's configuration; the only removal path is an explicit owner-scoped disconnect |

| DV07 | UID different from the filename: read, PUT, DELETE and sync use a stable href | **PASS.** `davPg.integration.test.ts` stores an event whose `UID` is `embedded-event` under the file `client-generated.ics`, and a contact whose `UID` is `embedded-contact` under `client-generated.vcf`, then asserts the stored `dav_filename` and the sync-change row — so the href, not the UID, is the identity |
| DV06 | DTD/XXE, large body, deep XML, traversal and cross-origin hrefs are safely rejected | **XXE: not applicable, verified by reading. Rest: NOT RUN.** The CalDAV and CardDAV routes never build a document from a request body — they use `String.includes` and regexes for the elements they need (`sync-token`, `href`, `time-range`), so no parser expands an entity and a DTD is inert text. There is **no test** for it, and the large-body, deep-XML and traversal parts remain unverified; the body-size limit the DAV routes run under was not checked |
| DV05 | Different XML prefixes and requested properties, entities and CRLF behave correctly | **PARTIAL, by construction.** The element regexes accept an optional namespace prefix — `(?:[A-Za-z][\w.-]*:)?` on `sync-token`, `href` and `time-range` — which is what the row asks for, and `decodeDavCharRefs` handles numeric character references on the response side. Verified by reading, **not** by test, and CRLF handling was not checked |

**One correction worth stating:** DV08 was recorded as NOT RUN for its parallel-`PUT` half in the
previous revision. That was wrong — I read the unit-level precondition file and did not open the
integration suite, which has covered it on a real database all along. It is the third time in this
work that I described coverage from the wrong source rather than reading the one that holds it.

**And a fourth, caught before it could stand:** the previous revision of this table recorded DV06 as
PARTIAL, "the XXE/DOCTYPE theme is exercised in three suites". That was false. Those three files
matched the *`dav_mode = 'off'`* pattern in a shell call that ran several greps, and I attributed the
output to the wrong one; the XML hardening of DV06 has no test at all and is NOT RUN. The row is
corrected, and the mechanism is worth naming because it is a new layer of the same habit — this time
the misreading was of my own tool output, not of the code.

**The remaining KC rows need reading, not guessing.** I searched for their themes and am recording
where to look, deliberately **without** a verdict — the DV06 entry above is the cautionary tale, where a
filename match was written up as coverage and had to be taken back:

| Row | Where to look | State |
| --- | --- | --- |
| KC04 (DST, differing TZIDs, date-only, exclusive end, midnight) | `googleCalendar.test.ts` asserts a DST zone is emitted from the platform tz database (`TZID:Europe/Warsaw`), **a decade of transitions** so a later DST boundary is defined, a date-only event as `VALUE=DATE` with its **exclusive end**, and `TZID` conversion on `DTSTART`/`RECURRENCE-ID` | **PASS**, including the midnight case that no assertion had covered: a case projects local midnight (`20260901T000000` in `Europe/Warsaw`) to `2026-08-31T22:00:00Z` — the previous day in UTC — and another writes a midnight instant back as `20260901T000000`, asserting that no `20260831T` appears. That is the day-shift hazard the row exists for, now pinned in both directions |
| KC13 (vCard 3/4, many fields, a date without a year, a photo, Polish characters) | `utils/vcard.test.ts` round-trips `ANNIVERSARY`, rejects and labels an impossible date (`2021-02-29`), and preserves unknown properties (`X-CUSTOM`). The three gaps found by reading it are now closed by cases of their own: a **`VERSION:4.0` card** parses like 3.0 with non-ASCII text intact, a 4.0 birthday without a year (`--1210`) yields `null` rather than an invented date, and `PHOTO` is carried as a **data URI** for inline images while a `VALUE=URI` reference is not stored as if it were the image | **PASS** for the asserted parts. The suite's fixtures were ASCII before these cases; a format the parser ignored would have gone unnoticed behind a green suite, which is why they were worth adding |
| KC15 (one Google contact in several groups: no duplicate canonical contact) | nothing matched | **no duplication, verified by reading; memberships are dropped.** The sync upserts one row per `resourceName`, so a contact in several groups cannot duplicate — but `memberships` appears nowhere in the Google provider code, so the groups are discarded rather than stored. That is now stated in the wiki as a limitation. Carrying them would mean resolving `contactGroups.list` to names and writing them as `categories`, which the contacts table already holds. Reading the mapper for the same question found more: it used names, emails, phones, organisation, title, addresses, nicknames, notes, URLs and birthdays, and dropped photos, anniversaries and instant-message handles. **Anniversaries and handles are now carried** (the mask asks for `events` and `imClients`, both mapped and tested); **photos and memberships still are not** — a photo needs an authenticated request per contact, and group names would need a `contactGroups.list` call |

**The admin series (AD01–AD09) was read too**, and one row is a real gap:

| Row | Requirement | State |
| --- | --- | --- |
| AD03 | Google with no Client ID/Secret/callback: the API is unavailable **with an explanation**, and the traditional account path stays available | **PASS.** The card renders `admin.integrations.google.connectUnavailable` — "An administrator must configure the Google API before an account can be connected." — beside the disabled button, and the account screen is untouched. |
| AD07 | Saving a new Client ID does not pair it with an old secret; the effects are confirmed and a matching credential is required | **Open, and it trades against AD05.** `mergeConfig` carries a stored secret across a save that omits a new one, so changing the Client ID keeps the previous secret and readiness still reports the method ready. Attempting the obvious fix — drop the secret when the client id changes — **broke AD05's own requirement and its test**, which pin the opposite: an omitted or empty secret on an edit must be **preserved**. The two rows are therefore not independent, and AD07's answer is not to drop the secret but to require **confirmation of the effects**, as its wording says. The confirmation belongs in the **card**, not the API: an attempt to enforce it server-side with a `409` until the client confirms broke AD05's test — which saves a changed client id with an omitted secret and expects `200` with the secret preserved — and that contract is the one that keeps an edit from wiping a working secret. **That prompt now exists** on both cards: it fires when the entered Client ID differs from the stored one and the secret field is untouched, and stays out of the way when a new secret is supplied, which resolves the pairing by itself. |

The fix is **not** the obvious one, and finding that out is the value of the attempt. Dropping the stored
secret when the client id changes satisfies AD07 and **violates AD05**, whose test asserts that an omitted
secret on an edit is preserved — it failed, which is how the conflict surfaced. AD05 protects an administrator
who edits a redirect URI without retyping the secret; AD07 protects one who changes the client id. The row's
own wording resolves them: require **confirmation of the effects**. That is a save-path flag plus a prompt in
the card, and it is recorded rather than half-shipped, as with the other withheld changes.

**The device-code series (DC01–DC04) has three findings**, recorded here rather than left in the plan:

| Row | Requirement | State |
| --- | --- | --- |
| DC01 | The device flow requests **Graph** scopes, not Outlook IMAP scopes, and works without a redirect URI or client secret | **FAIL**, and for the reason P07b is open: the device flow that exists is the **mailbox** one and asks for `IMAP.AccessAsUser.All`/`SMTP.Send`, which is correct for what it does but is not the Graph flow the row describes. It will be satisfiable when the Graph mail adapter (P07b) exists. |
| DC02 | Two parallel flows for one user have distinct flow ids and do not overwrite each other | **PASS.** `deviceFlows` is keyed by a flow id now, the entry records its owner, the start response returns the id, and the client polls with it — so two flows coexist and each poll reaches its own. A case asserts two distinct ids, that each polls successfully, and that an unknown id is refused. |
| DC04 | Device-flow polling is limited: a client cannot poll faster than the interval Microsoft asks for | **PASS.** The flow records the interval and the last poll, and a poll arriving too early is answered from the flow's own state with `pending` — without calling Microsoft. The interface already respected the interval; the server now does too, which is what makes the endpoint unusable as a way to make the server hammer the provider. A case asserts the second poll reaches no provider. |
| DC03 | The flow is bound to user/session/account/purpose/configRevision; another user's flow id and another mailbox are not accepted | **PASS for three of the four bindings, and the fourth does not apply as written.** *User*: the poll checks the entry's owner against the session, so a flow cannot be reached or continued by another user. *Configuration revision*: the provider flows check it **explicitly** — a callback whose configuration changed since the flow started is refused with `CONFIG_CHANGED` — and in the device flow the client id and tenant are captured at start and used for every poll, so a configuration change mid-flow cannot alter it — verified by reading the poll, which reads `flow.clientId`/`flow.tenantId`. *Purpose*: the device method has exactly one, mailbox sign-in, and the flow cannot be used for another. *Account*: the flow does not target an account — it creates or updates whichever mailbox authorizes — so "another mailbox is not accepted" has nothing to bind to; it would need the device method to start *for* a named account, which it does not do. |

Both FAILs are in the mailbox device flow, not in the provider connector, and neither is a security hole: the
map's key is what makes another user's flow unreachable. They are the plan's bar for a flow that can run
twice, which this one cannot.

**GE12 and the device halves of GE01–GE05 and GE09 are NOT RUN**: they require Android/PWA and Safari
iOS, and no device was used.

Everything else on the matrix is **NOT RUN**, and for large parts of it that is structural rather than
an oversight: **ML\*** needs the mail adapters that do not exist (P07b, P08), **AT\*** needs P06, and
**AU01–AU03, AU05, AU06, AU09, AU10** concern the migration and consent flows of P12. The **KC** and
DAV rows are covered at protocol level but share P11's open criterion: no real client was driven.

Recording this way is deliberate: the plan requires PASS, FAIL, SKIPPED and NOT RUN separated with
evidence, and a row is not PASS because a similar test exists.

## Closed: the DAV request body is bounded

The CalDAV and CardDAV routes read their own request bodies, and nothing capped them: the
application's `express.json({ limit: '1mb' })` does not apply to XML, calendar and vCard content
types, so a client with a device password could stream an arbitrary body and have the process hold it
in memory on the endpoints that serve everyone else. The body is now capped at **1 MB** inside
`rawBody`, where the request is legitimately read; excess is discarded rather than buffered, and the
rejection carries body-parser's `entity.too.large` marker so the application answers `413` with the
route-aware message it already gives for oversized JSON uploads. Both protocols are covered and the
refusal writes nothing.

**Three attempts were needed, and the reason is worth keeping.** The first added the cap as
router-level middleware that watched the stream, which broke 30 tests: attaching a `data` listener
there starts the request flowing before the handler runs, so every body arrived empty. The second and
third moved the cap into `rawBody` — correctly — and then hung in the test, which produced two wrong
conclusions in this document, including "the cap may already be correct". A probe with no cap in the
code showed a 1.1 MB `PUT` answering `400` promptly, which cleared the read path and pointed at the
rejection path; the cause was that the **test harness did not import `express-async-errors`**, so a
rejected handler produced no response at all. The application has had that import all along, so the
production behaviour was never in question — only my ability to observe it.

The lesson is narrower than "test more": when a handler rejects and the client sees nothing, the
question is whether the rejection is *forwarded*, not what the handler did.

## Other unbounded body readers, found by sweeping for the DAV defect's shape

The DAV fix closed one instance of a general shape: code that accumulates a stream into memory with no
cap. Sweeping the backend for `on('data')` found two more, and they belong to different owners:

- **`draft.ts:143` and `send.ts:712`** read an IMAP message stream into memory with no cap. A message
  with a large attachment is buffered whole. This is **P06's territory** — the package is defined as the
  durable send ledger with separated file, total, MIME and HTTP limits — so it is recorded as part of
  that package rather than as a new defect.
- **`oidc.ts:100`** accumulated a *response* from the identity provider with no cap. **Now fixed**: the
  response is capped at 1 MB and a larger one is refused rather than buffered. **Tested directly**:
  `makeInsecureFetch` is exported so a local server can answer with 2 MB, and the case asserts the
  refusal; a second case asserts a normal response is returned unchanged. The earlier version of this
  note said the branch was true only by construction — it no longer is.

What is *not* affected: the import routes (JSON, already under the 1 MB parser limit), the DAV routes
(capped), and the request-side readers in the mail ingestion path, which stream to disk.

## Contact-field additions: verified to reach the database, with one step left

The anniversaries and instant-message handles added to both providers are mapped, and **the plumbing
consumes them**: reading each adapter's upsert shows `anniversary` and `instant_messages` in the column
list and `parsed.anniversary` / `parsed.instantMessages` among the parameters, for Google and for Graph.
So neither change is inert, which was worth checking — a mapper that returns a field no statement writes
is the same silence as a switch nothing reads.

**Google now has that assertion**: the contacts integration suite syncs a person carrying a birthday, a
dated `anniversary` event preceded by an `other` event, and an IM client without a username, then reads
the stored row — `1815-12-10`, `1835-07-08` and one `jabber` handle. Writing it also confirmed the columns
are `DATE`: the first run compared against pg's `Date` objects and failed, which was the assertion being
wrong rather than the data, so the query casts to text.

**Graph now has it too**: the Graph contacts integration suite stores a contact carrying a birthday, an
anniversary and two IM addresses (one empty) and asserts the row — `1815-12-10`, `1835-07-08` and a single
`other`-typed handle. Both providers are therefore proven end to end on a real database, not only mapped.

## The normative documentation checklist (`TEKSTY-I-CHECKLISTA-AGENTA-v4.md`)

The delivery archive contains a **normative** document beside the plan — ready PL/EN copy plus a list of
documentation places that **must** be updated — and it was not read until now, because the archive listing I
first looked at was truncated by a `head -5`. Reading it changes the documentation picture materially: most of
its entries are unmet.

| Required | State |
| --- | --- |
| `docs/wiki/Upgrading.md` — account behaviour, Microsoft's requirement, Google's recommendation with *Ignore* and a checkbox, no account removal, what to do without configuration | **Exists and is tracked** (the previous revision of this row said MISSING — it was written before the command that listed the files, and I did not read that output before recording the claim, which is the error this audit keeps correcting). Whether its content covers each required item was **not** compared in this pass. |
| `docs/wiki/Microsoft-provider.md`, `docs/wiki/Google-provider.md` — the full procedures from the admin guide, as product pages | **MISSING.** The procedures live in `Provider-setup.md`, which covers both; the checklist calls these "proposed names" and requires the procedures and all links either way. |
| `README.md`, `docs/wiki/Home.md` — native integrations, Google optional with app passwords kept, Microsoft required, links to configuration and upgrade | **`README.md` done.** Its Gmail bullet named only the app-password method, so the API option this work added was invisible from the front page; it now describes both and that neither is forced, with links to the configuration page and the provider procedure. The Microsoft bullet already stated the requirement correctly and the documentation table already linked `Upgrading.md` — the previous commit message claimed it *gained* that row, which was wrong: the row was there and the commit changed only the Gmail bullet, as `git show` confirms. `Home.md` not yet compared. |
| `Configuration.md` — remove the "Google app password only" simplification, show both methods, the shared `emailProviders` and the feature switches | **Partly met**: the file documents `PROVIDER_SYNC_INTERVAL_MINUTES` and the purposes, and the switch added this session is in `.env.example`; whether the simplification is gone was not verified. |
| `Getting-started.md` | **done** for the provider policy and the app-password path; its roles text and Microsoft bullet were already correct. |
| `Troubleshooting.md`, `Calendar.md`, `External-calendars.md`, `Contacts-and-DAV.md`, `Security.md`, `_Sidebar.md`, `Mobile-navigation.md` | **Compared, and each needed at most one addition** — the details are in the rows above. `Mobile-navigation.md` needed none: it already describes the left quarter, the conflict with the message row and the switch. |
| `Email-and-threading.md` — both Google transports, label differences, safe identifier migration, attachments and drafts, no send fallback | **Correct for what exists, and the rest is contingent.** The page never claimed a Gmail API transport, and mail has one transport today: IMAP/SMTP for every provider, which it now states explicitly so a reader of the provider pages does not expect mail to move to the API. The row's remaining content — the label semantics, identifier migration and the no-fallback rule — belongs to **P07b/P08**, which are not implemented; documenting them now would describe software that does not exist. |
| A contradiction search for stale phrases (`migration_required`, "required migration", "Google only app password", "no client secret", `device`, `MS_CLIENT_ID`, `oauth_provider`) | **Run, and clean.** Across `README.md`, `docs/` and `.env.example` the only matches are this table quoting the phrases it asks about, and a changelog line saying the device flow *sends* no client secret — which is the policy, correctly stated. `migration_required` and "required migration" appear **only in code and tests**, where they are a policy value and a case name rather than documentation claims. The literal "Google only app password" phrasing does not occur: the oversimplification the row warns about, if it is there at all, is worded differently, which is why comparing `Configuration.md` with its required content is still the task that matters. |
| Help UI, card copy, tooltips and `aria-label`s matching the same policy | **Not checked.** |
| Screenshots refreshed from the real preview and anonymised | **Not done**, and the checklist forbids edited images that imitate a working interface. |

**The screenshots are verified, and the verifier's scope is narrower than the checklist's requirement.**
`scripts/verify-docs-screenshots.mjs` reports **28 images, all referenced and non-empty** — it checks that every
image a README or wiki page references exists, that no committed image is orphaned, that each is a plausible PNG
rather than a truncated capture, and that none is a placeholder. What it does **not** check is **freshness**: it
cannot tell whether an image still matches the interface it shows.

Reading the set answers the useful question: it covers mail, calendar, contacts, mobile navigation and settings
(appearance, DAV access, about, rebuild, threading) — and **not the provider card**, which is the surface this
work changed most. So nothing in the committed set is stale *because of this work*; the checklist's requirement
resolves into a bounded task rather than a blocked one:

1. append a capture of the integrations card to `frontend/e2e/docs-screenshots.spec.ts` — the spec already opens
   Settings and its tabs, so it is a matter of one test and the mocked API the others use;
2. reference the new image from `Provider-setup.md`, where the policy and the method readiness are described;
3. run the spec with the mocked preview and then `node scripts/verify-docs-screenshots.mjs`, which enforces the
   four properties above and would catch a blank or placeholder capture.

That was recorded as "blocked on environment" in earlier rounds, which was wrong: the mocked preview is exactly
how CI produces these images, so the work is available here.

**`SECURITY.md`** was the last comparison, and it needed the one thing it lacked: its "already in scope for
review" list covered authentication, the DAV servers, encrypted credentials, the connection policy, rendering
and the admin boundary — all still true — but said nothing about the **provider grant model** this work added.
It now lists provider grants (the user's authorization and its tokens) and the separation of the three
credentials, and states the rule that provider tokens are never returned to the browser, with SSO deliberately
separate from a provider connection. Those are the boundaries a security report about this feature would concern.

**Where the admin guide's sections belong**, which is worth settling before anyone writes the two "missing"
pages: the guide has eight sections and they map onto different surfaces, so the requirement is not two pages of
procedure but a set of touchpoints — and the checklist itself says the list means required touchpoints rather
than copying the whole instruction everywhere.

| Admin guide section | Belongs in | State |
| --- | --- | --- |
| §1 method choice and who configures versus who authorizes | `Getting-started.md` | not compared |
| §2 before configuring | `Installation.md`, `.env.example` | partly met: the env values are documented in both |
| §3 Microsoft registration, Graph permissions, browser variant, **device-code variant**, updating an existing installation | `Provider-setup.md` for the registration and permissions (**covered**); the **device variant is not documented** anywhere as a procedure, only as a button and its UI copy; §3.5 belongs in `Upgrading.md` |
| §4 Google API setup, consent screen, client, scopes, testing versus public, why no Google device flow | `Provider-setup.md` — the first five are covered; "why there is no Google device flow" is stated in the card and in code, not as documentation |
| §5 Google IMAP/SMTP with an app password | `Getting-started.md` | **done.** Its Gmail bullet states both methods and that neither is forced, and adds what the guide requires: **2-Step Verification** and Google offering app-password creation, the cases where it is unavailable (Advanced Protection, security keys, organisation policy) **with the rule not to disable those protections to force the method**, the placement (on the mail account, not the provider card), the preset hosts and ports, and that **changing the main Google password revokes the app passwords made with it**. The page's Microsoft bullet already stated OAuth2-only and both flows, and its opening already carried the admin-configures-once / user-authorizes split. |
| §6 what a user sees after the upgrade | `Upgrading.md` | not compared |
| §7 diagnostics and rotation | `Troubleshooting.md` | the page has a Troubleshooting section; whether it covers secret/callback/consent errors and rotation is unverified |
| §8 how the instruction is received by the agent | this document | met |

So the concrete documentation gaps are narrower than "two pages": a **device-code procedure** (Microsoft's
variant B) has no home, the **app-password** path is not compared against §5, and the diagnostics and upgrade
sections are unverified. Writing `Microsoft-provider.md`/`Google-provider.md` as new pages would **duplicate**
`Provider-setup.md`, which the checklist explicitly does not require.

The document also states two rules this work already follows and one it must not break: **do not claim that
writing to `docs/wiki` updated an external wiki without proof** (the status document describes the publish
script without claiming a publication), and **do not announce the scope complete with an undocumented account
connection** — which is why the W-list still carries its FAILs.

**What this means for the remaining work**: the two provider pages are genuinely missing, and the content of
the existing pages was not compared with the checklist's required text — so the documentation package is
**unverified against its normative list**, which is weaker than "done" and weaker than "unmet" but honest. The
two missing pages are concrete, bounded deliverables. They were not attempted here because writing
three pages of operator instruction properly is more than the remaining session can verify, and a documentation
page written without checking the code it describes would be worse than the gap.

## The DAV server chapter (§17): verdicts, one recorded deviation, two unverified rows

Read against the implementation rather than against the earlier P11 summary. Most of it holds, one thing the plan
explicitly forbids is what the code does, and two rows were not verified.

| Requirement | State |
| --- | --- |
| An invalid or expired sync token answers `403` with `DAV:valid-sync-token`, so the client resynchronises rather than receiving a generic `409` or an empty change list | **Satisfied** — the REPORT handler answers exactly that, with a comment naming the precondition. |
| `DAV: 1, 2, 3` may not be claimed beyond what is implemented; `MKCALENDAR`/`MKCOL`/`PROPPATCH`/`COPY`/`MOVE`/`LOCK` must not be advertised | **Satisfied** — both services advertise `DAV: 1` with their compliance class, `PROPPATCH` is answered with a refusal rather than a 404, and the deliberate omissions are documented in the code. |
| A device password may only narrow, never widen, a collection's `dav_mode` | **Satisfied** — and the same rule is what makes a provider-sourced collection refuse writes whatever the password allows. |
| A collection with DAV access **off** is absent from discovery **and** unreachable by a direct href | **Satisfied, and the chapter's extra channels were checked.** Both DAV queries filter `dav_mode <> 'off'`, and the remaining channels the clause names have no surface to leak through: **the DAV server serves neither photos nor feeds** — there is no such endpoint — so an old URL cannot reach one. The only photo route is a session-scoped REST channel that looks a photo up by email address for mail avatars, which is the interface's own rule rather than a DAV one: it does not check the book's DAV mode (correct, since that mode is about device access) and it does not check the book's `visible` flag either, which is defensible for an avatar and worth knowing. **Search is filtered too**, which closes the clause: the contact list adds `ab.visible = true` whenever no book is named, so a search across books returns only visible ones while an explicit book selection is the user's own act. With photos and feeds having no DAV surface and search filtered, none of the channels the clause names can reach a hidden collection. |
| The report type must not be recognised by `body.includes('calendar-query')` | **Was a deviation; now fixed and pinned.** Both routers dispatch on the report's **root element** — with the XML declaration and comments skipped — so a multiget naming a resource whose filename contains another report's name is read as what it is. A case sends exactly that request and asserts a multiget answer, and `body.includes` now appears in the two files only inside the comment explaining what the dispatch used to be. **The change is also stricter, and that is deliberate**: a REPORT whose body has no recognisable root element now answers `400` where a substring search might have dispatched it — which is what a body with a DTD, or malformed XML, now receives. The plan asks for no DTD and no uncontrolled parsing, so refusing is the intended direction rather than a regression; what a reader should know is that the entry point is less forgiving than it was. Verified against the mock suites (74 tests across the three DAV files) and the real-database round trip. |
| A time-range filter must use the real recurrence projection, with `SQL OR recurring` only selecting candidates | **Was a defect; now fixed.** The query selected candidates and the handler returned all of them, so a series whose rule never lands in the window came back anyway — the chapter's warning exactly. Candidates are now filtered by `projectCalendarResource(row, start, end)`, which is the same projection the rest of the calendar code uses, and the existing calendar-query cases pass with it. **And it now has its own case**: a query window with one series occurring inside it and one that finished years earlier asserts that only the first comes back, so the branch this changed is pinned rather than merely exercised. The first attempt at the case failed on the suite's per-query mock arrangement — it arranges one `mockResolvedValueOnce` per database call, which the attempt had not read — and was reverted until it was understood. |

Two of the rows are therefore open questions rather than answers, and they are recorded as such: the
photos/feeds/search filtering, and whether the recurrence projection is the final word on a time-range query.

## Account settings and independent integrations (§19): three findings, one conditional whole

The chapter describes a per-account model — provider and connection method shown instead of IMAP hosts, two
independent calendar/contacts switches per account with their consent and last-success state, per-account
authorization and discovery endpoints, per-account migration and notice preferences. **All of that is contingent
on P07b and P08**, which are not implemented: there are no native mail accounts, so there is no per-account panel
to carry it. Recorded once here rather than repeated in every row.

Three items land on surfaces that *do* exist:

| Item | State |
| --- | --- |
| **A "test configuration" action on each provider card** (§19.4) | **The API half exists; the interface half does not.** `POST /api/integrations/:provider/test` checks the stored credentials against the provider with a deliberately unusable grant — `invalid_client` means the credentials are wrong, anything else means the provider accepted them — and its cases assert that the stored secret is used, that a wrong credential is reported as such, and that the secret is never echoed. **And the card now carries the control**, so the finding is closed for both halves: a Test configuration button per provider reports accepted, rejected, no client id saved, or the provider unreachable, in place. The six messages exist in all nine locales with real translations — the parity suite forbids both a missing key and an unused one, so the control and its copy had to land together — and the interface half is verified by typecheck, lint, the parity suite and the build rather than by a component test, which the panel does not have. The interface half is specified: a Test control beside each card's save action, the api helper next to `disconnectProviderConnection`, a `providers.testAccepted`/`testRejected` pair of keys across the nine locales, and a case asserting that a rejected credential is shown as a failure rather than as readiness. |
| **An explicit "delete local data for this integration" option** (§19.2: retention is explicit, keeping inactive mappings by default, with the option to remove local data without touching the source) | **Missing as a control; the default is right.** Disconnecting preserves imported data deliberately, and the wiki states that an imported collection cannot be deleted while its source can still write. There is no button that removes the local copy while the connection is off, which is what the row adds on top of the default. |
| **Endpoint paths** (§19.3 proposes `/api/accounts/:id/integrations`, `/api/collections/:id`, `/api/operations/:id` and others) | **Deliberately different, and the read-first document permits it**: it says all new endpoint, table and page names must be **agreed with the final code** before release, the code being the authority. The collection settings live on the pages that own the collections — `PATCH /api/contacts/address-books/:id` and `PATCH /api/calendar/calendars/:id` — and the provider flows are provider-level rather than account-level, because there are no native accounts yet. The documentation and the code agree with each other; the plan's proposed paths are the part that differs, and a reader comparing the two should know that this was a decision rather than drift. |

§19.5's requirements hold: `allowed` covers both providers, and the payloads are validated as a closed schema
rather than arbitrary JSON — `validateProviderConfig` rejects unknown fields per provider, which is the property
that keeps a typo from becoming configuration.

## Retry and uncertain outcomes (§22.2–22.4): what holds, and the one thing that does not

Reading these three subsections against the code gives one real gap and a set of requirements that are already
met — several of them deliberately, which is worth recording because the plan names them as traps:

- **`Retry-After` is now respected in scheduling too.** The classifiers parse it and mark the error
  retryable with its delay; the schedule previously ignored it and retried a throttled collection on the same
  cadence as a healthy one. A throttled pass now backs off by doubling towards a thirty-minute ceiling with
  jitter, a healthy pass resets it, and stopping the scheduler clears that state — which the first attempt at
  this forgot, and which the suite caught as a leak between its own cases.
- **A 403 is not treated as an auth error.** The classifier checks Google's own reason against a set of
  rate/quota reasons and maps those to `RATE_LIMITED` — retryable, with the delay — keeping only genuine
  permission failures as `INSUFFICIENT_SCOPES`. The plan names this as the mistake to avoid; the code carries a
  comment saying so.
- **A partial batch is not replayed wholesale.** Syncs are page-by-page with idempotent upserts and a cursor
  advanced only after the pages are applied, so a retry re-reads (a safe read) without duplicating writes.
- **Uncertain mutations are not retried automatically.** The providers' write paths do not exist yet, and the
  one place an outcome can be uncertain — a lost lease mid-run — records `MUTATION_OUTCOME_UNKNOWN` rather than
  retrying, which is the rule the section states.
- **§22.4's mandatory protections are in place where their surfaces exist**: state/nonce/PKCE/audience/issuer and
  the redirect and callback checks on the OAuth endpoints (verified in round 182), the DAV device password's own
  scope, rate limit and revocation, HTML sanitisation for mail, SSRF controls on outbound fetches, and redaction
  in diagnostics and logs. The webhook and attachment requirements have no code path yet, for the same reason the
  mail half of §22.1 has none.

So: one bounded gap — **scheduler backoff and jitter** — and a list of traps already avoided.

## The domain-error contract (§22.1), row by row

The plan's table maps each domain code to an HTTP status and to the retry or user-facing consequence, and reading
it against the implementation gives a mixed but definite picture:

| Row | State |
| --- | --- |
| `ADMIN_CONFIGURATION_REQUIRED` | **Satisfied.** All three sync routes answer `409` with "…API is not configured by the administrator", which is the row's status and its meaning; there is no automatic OAuth loop to prevent. |
| `PROVIDER_AUTH_REQUIRED`, `INSUFFICIENT_SCOPES`, `RESOURCE_NOT_FOUND`, `INVALID_SYNC_CURSOR`, `RATE_LIMITED`, `UPSTREAM_UNAVAILABLE`, `INTERNAL_ERROR` | **Satisfied.** These are the codes the connectors record in `last_error_code` and the UI maps — auth, scopes and rate limiting to actionable sentences, the rest shown with the provider's own code, and a rate limit distinguished from an auth failure. |
| `COLLECTION_READ_ONLY` / `OPERATION_FORBIDDEN` | **Satisfied** as behaviour rather than as a code: writes to a source-owned collection are refused with `403` and a reason, and nothing is written locally, which is the row's consequence. |
| `PERMISSION`, `MUTATION_OUTCOME_UNKNOWN` | **The code exists** where a lease is lost mid-mutation, and it is recorded rather than mapped to a sentence, which is honest for a state a user cannot act on. |
| `VALIDATION_ERROR`, `SESSION_REQUIRED`, `VERSION_CONFLICT`, `IDEMPOTENCY_KEY_REUSED`, `STORAGE_*` | Route-level and narrower than the provider connectors; not audited row by row here. |
| `ATTACHMENT_*`, `MESSAGE_TOO_LARGE`, `UPLOAD_SESSION_EXPIRED`, `SEND_OUTCOME_UNKNOWN`, `MAILBOX_QUOTA_EXCEEDED`, `SEND_LIMIT_REACHED`, `PARTIAL_SYNC` | **Belong to P06, P07b and P08**, which are not implemented — attachment and send semantics have no code path to classify yet. |
| `ACCOUNT_MIGRATION_REQUIRED` | **Belongs to P12**, for the same reason; and the plan's own rule that **Google's recommendation never returns this code** is respected by having no such code path for Google at all. |

So the provider-facing half of the contract holds, and the half that does not exist is the mail half — which is the
same boundary the W-list draws, stated once here in the plan's own vocabulary.

## A coverage audit of the service layer, and the two mistakes it made first

Looking for modules with no test of any kind — the search that found `encryption.ts` last round — the whole service layer
was walked mechanically. The first pass reported **79 of 122** modules unreferenced, which was **wrong and worth
recording as wrong**: the tests inside `src/services/` import their siblings as `./name.js`, and the pattern only looked
for `services/name.js`. `conversationEngine.ts` appeared on that list and is referenced by three test files. With the
pattern corrected the figure is **16 of 122**.

The sixteen are a **candidate list, not a finding**: no direct test reference is not the same as untested, and the
conversation engine is the proof of that in the same audit. What the corrected run does establish, and it is the useful
part, is a negative about the sensitive surface: **no module matching auth, token, password, secret, session, encrypt,
permission, tenant or security is unreferenced by any test.** `encryption.ts` was the exception last round, found by a
different route — a row demanding the evidence — and it is now tested. The remaining sixteen are ordinary application
modules (`aiHttp`, `archiveInbox`, `carddavClient`, `composeFormat` and their neighbours), and each should be judged by
reading it rather than by this list.

**Read, in the end, for the one property that mattered most.** The candidates that could make an outbound request were
checked rather than inferred, because an SSRF surface behind an unreferenced module is the worst version of this finding.
`carddavClient.ts` turns out to be the best-hardened code in the set: it validates the host up front with the same policy
IMAP/SMTP hosts use, **re-validates on every request** because hrefs come back from the server (principal, home set) and
cannot be trusted, and `safeFetch` validates **every redirect hop's IP** — three layers, the second and third covering the
two second-order holes usually left open. `aiHttp.ts` has no `fetch` at all, so it is not a client, and `calendarFeed`,
`archiveInbox`, `composeFormat` and `contactRichBackfill` make no outbound requests either.

The claim is therefore closed **for the seven candidates checked and the sensitive-name filter above**, and stated that
narrowly: no unreferenced module that plausibly makes an outbound request lacks validation. A module can be
security-relevant without a security name — the filter cannot see those, and this list is where the next reader starts.

## Observability: what the plan asks for and what exists (§25.2)

A chapter-level reading rather than a table one, and it found a scope item my per-package status never mentioned.
The plan asks for shared metrics — sync lag and last success, round time, pages/records/bytes, active leases,
stale generations rejected, retries and rate limiting, expired cursors, conflicts, unknown operations, migrations
per state, queue and spool size — with the explicit constraint that **cardinality must not grow with the number
of emails or message ids**, and for logs carrying `correlationId`, `operationId`, the adapter type, a safe code
and the provider's request id.

**No metrics exist**, and the logs do not carry those structured identifiers: they are human-readable messages
with a code, which is enough to debug a run and not enough to graph one. That is now recorded rather than
implied, and it belongs to **P13**, whose scope names metrics.

What the same section asks for *is* met, and the distinction is worth keeping:

- **a rate-limit regression is distinguished from an authorization failure** — `providerFailureKey` maps
  `RATE_LIMITED`/`UPSTREAM_UNAVAILABLE` to a retry-later sentence and the auth codes to "reconnect", and the
  connectors record the provider's own code;
- **read-only sync success is distinguished from write readiness** — the connector status reports last success
  and the collection's access separately, and an imported collection is refused writes rather than reported as
  writable;
- **the diagnostic export redacts** personal data and credential-bearing URLs, as `SECURITY.md` states;
- **the account surfaces are separate** — mail in the accounts screen, and contacts, calendars and DAV/ICS
  sources on their own pages, each with its own last-sync or failure line.

Metrics are the kind of work that needs its own design (what is exported, in what format, and how cardinality is
bounded), which is why it is recorded here rather than started at the end of a session.

## Three series that were missing from the execution matrix: GN, DO and RE

The matrix holds **176 rows across twelve series** (AT 20, DV 19, GN 18, AD 18, KC 17, ML 16, MG 16, GE 12, DC 12,
AU 12, RE 8, DO 8). The execution matrix above covers nine of them; **GN, DO and RE were never reported**, and the
checklist names GN explicitly — "AD/GN/DC/DO tests are required in the full matrix" — so their absence was a gap in the
deliverable rather than in the code.

### GN — the Google notice and migration behaviour (18 rows)

| Rows | Verdict |
| --- | --- |
| GN01, GN02 | **Met.** The upgrade keeps accounts, passwords and metadata (the schema is additive and nothing rewrites a row), and a new Google account can be added and edited with an app password **without any global Google configuration** — which is the behaviour the app-password path has always had and this work verified rather than changed. |
| GN11, GN12, GN13 | **Met.** Google IMAP keeps read, actions, forwarded attachments, compose, drafts, send, CE, GTD, rules, snooze and push with no Gmail API; enabling Calendar/People requests no Gmail scope and changes no transport; and disabling or revoking a PIM grant leaves the IMAP account and its password alone. The four switch combinations are covered by the per-collection and per-method switches and their tests. |
| GN18 | **Met, in the documentation.** An account that cannot have an app password is told so — Advanced Protection, security keys, organisation policy — with the API as the alternative and no request for the main password. That is the sentence added to `Getting-started.md`, and no code path asks for a Google password. |
| GN03–GN05, GN07–GN09, GN14–GN17 | **Not implemented: this is P12.** The *Ignore* control with and without its checkbox, the stored suppression with its revision handling, the restore action, the migration intent, its cancellation, and the cutover with the no-automatic-fallback rule all belong to the migration package. GN17's requirement — no automatic SMTP after a Gmail API cutover — is vacuously true today for the reason it will stop being true: there is no cutover and no API transport. |
| GN06 | **Vacuously safe.** There is no endpoint that could write another account's preference or the Microsoft requirement, so the rejection the row asks for cannot be bypassed — because the write does not exist. |
| GN10 | **Met where errors exist.** A hidden recommendation does not hide a real failure: the app-password, scope, API and sync errors are separate states with their own messages, and the suppression machinery that could conflate them does not exist yet. |

### DO — acceptance on the final build (8 rows)

**DO01–DO04, DO06 are NOT RUN**: they are the manual procedure against a real Entra registration and a real Google
project, on accounts that permit each method, and no such application or account was available. That is the same
NOT RUN as §8, recorded rather than inferred from the tests that fake the providers.

**DO05, DO07 and DO08 are met**, and they are the rows this session's documentation work was actually about: the policy
is consistent across the README, the wiki, the inline UI copy, the upgrade page, the release notes and `.env.example`
(DO05); the local documentation links and the final field, callback and endpoint names match the implementation, and the
historical release notes were left as history rather than rewritten to look current (DO07); and the evidence is
anonymised with the missing live tests disclosed as **NOT RUN instead of passed from a mock** (DO08) — which is the rule
this document has been applying to itself throughout.

### RE — release engineering (8 rows), now read

| Rows | Verdict |
| --- | --- |
| RE01 | **Met.** The same functional schema is reached two ways and both were exercised: the state-reconstructing suite seeds a database, applies the chain and asserts the identifiers survive, and the database gate applies all 112 migrations to a fresh PostgreSQL 16 before running 188 tests. |
| RE03 | **Met at this commit**, from exit statuses: typecheck, lint, unit suites, the production build and the database integration set. |
| RE04 | **Half met.** Both images are built for `linux/amd64` and `linux/arm64` and verified in the registry, with the release SHA as their source; **neither was run**, so "images exist for both platforms" is a registry fact and not a smoke test. |
| RE02, RE06, RE07, RE08 | **Not verified, and each names a surface nobody looked at**: **RE02 is now met as the row is worded** — it asks for *documented* behaviour without destruction, and both halves are documented: `Upgrading.md` carries the rollback section it always had, and now the interrupted-migration procedure as well (the invalid-index query, dropping it, re-applying that one file, and the two things not to do). What is still unverified for RE02 is the *execution* of either: no migration was interrupted on purpose, and no rollback was performed, so the documented behaviour is a procedure rather than an observed one; **RE06 is met structurally, and not exercised.** The workflow publishes the pair from **one job** with two `Build and push` steps in sequence, no `continue-on-error` and no `always()` — so a failure in the second build fails the run — and **nothing in the repository declares a release ready automatically**: the readiness claim is in documentation, written by a person who can see both digests, which is the arrangement the row asks for. What it has not been is *tested by failing a publish on purpose*, and that is a deliberate choice rather than an omission: a failed production run leaves a misleading entry in the workflow history to prove something the structure already states. Recorded as met-structurally so the distinction is visible — the same one RE02 carries; a **backup and restore drill** in isolation, recovering tokens, mappings and operations with the right key; and the absence of secrets in **logs, build arguments, OCI labels, the frontend bundle, DTOs and test reports**. The **bundle was searched** and is clean — no secret-shaped assignment and no long high-entropy string literal in the built JavaScript assets, and no source maps are emitted to carry one — but the rest of that row is unchecked, and the absence of `import.meta.env.*` in the output is **not** evidence either way, because the bundler substitutes those at build time. **OCI labels were then fetched** from the registry — the index, the amd64 manifest and its config blob — and no secret-shaped label value is present. That negative is weaker than it looks and is recorded with its caveat: the config I read carried **no labels at all**, while the workflow does pass a label set to the build, so the labels may live in manifest annotations this check did not read. Logs, build arguments, DTOs and test reports remain unverified, and the last two are not reachable from a working checkout at all. |
| RE05 | **Met, and the risk it described does not exist.** The service worker is registered (`/sw.js?v=inboxora-3`) but it is deliberately minimal — its own first line says *no fetch interception, no caching strategy* — and its handlers are `install`, `activate`, `push`, `notificationclick` and `pushsubscriptionchange`, with **no `fetch` handler at all**. So there is no cached client to be incompatible with a changed backend; the worker exists for push notifications, and the only `/api/` call in it is the push-subscription POST. The row's compatibility question is moot rather than unanswered, which is why the risk has been removed from the list below. |

With RE read, **all twelve series are now accounted for**, and the mix is the honest one: most rows met or partially met,
several absent because their package is absent, and four surfaces that no one has looked at, listed above rather than
folded into a general assurance.

## The agent acceptance procedure (guide §8), reported as the guide requires

The admin guide's §8 asks for the procedure to be performed in an isolated installation **as a new
administrator**, once per configuration, with test accounts — and it states the reporting rule explicitly:
**lack of access to real accounts is marked NOT RUN, never PASS.** No Google or Microsoft applications were
registered and no real accounts were used, so the five configurations stand as follows. What is *not* an excuse
for the NOT RUN is recorded beside each: the code paths, switches and readiness have their own tests and are
listed so the boundary is visible rather than implied.

| Configuration | Real sign-in | What is verified without an account |
| --- | --- | --- |
| Microsoft, browser method | **NOT RUN** | The flow's authorization URL, PKCE (verifier stored encrypted), state and nonce, the `SESSION_MISMATCH`/`CONFIG_CHANGED` refusals, and the readiness that requires id, secret, callback and the method switch together (round 181, 182). |
| Microsoft, **device-only**, no secret and no callback | **NOT RUN** | The whole path around it: the switch and its separate readiness (rounds 69–70), the flow id and ownership check (rounds 176–177), the **`PUBLIC_CLIENT`/secret separation** in the refresh, and the ability to enforce the method server-side. |
| Google API | **NOT RUN** | Scope requests, the calendar and People adapters against a faked provider on a real database, the read-only enforcement, and the reference validation that refuses non-HTTPS or credential-bearing URLs. |
| Google IMAP with **no** OAuth configured | **NOT RUN** | Documented and unaffected by the provider layer: the transport is untouched, the API card reports not-ready with an explanation (AD03), and `PROVIDER_INTEGRATIONS_ENABLED=0` proves the layer is optional. |
| Google IMAP **with** only Calendar/People OAuth | **NOT RUN** | The scopes requested are People and Calendar read-only; no Gmail scope is requested anywhere, and the policy tests assert that connecting the API does not migrate mail (W18). |
| Updating an existing registration | **NOT RUN** | Documented in `Upgrading.md` with the behaviours the code enforces: the confirmation before keeping a secret across a client-id change (AD07), the tombstone that stops a restart resurrecting old configuration (AD08), and disconnect preserving data (rounds 174–176). |
| New screens match the documentation | **Verified as far as it can be here** | The new provider-card capture asserts the documented elements are on the screen — the Microsoft requirement note and the provider rows — before it will take the image, and the card spec asserts the connected-account list and the disconnect control. A human comparison against a live administrator session is **NOT RUN**. |

**None of these may be reported as PASS**, which is the guide's point: a verified code path is not a verified
connection. The distinction is the same one the W-list already carries for W06, W07 and W10.

**Two limits around the same number, measuring different things — deliberately.** Reading the forwarded-attachment
path for §12.2 found the rule already honoured: each referenced message's **own account** is loaded, so bytes come
from the source mailbox even when the sender uses a different transport, ownership-scoped in one query and fetched
with bounded concurrency. It also found that the application has a pre-existing 25 MB attachment policy enforced at
several points — the request guard, a pre-fetch guard on forwarded bytes, and `ruleForwarder` — and that these
measure the **wire** size (base64 is about a third larger, with headroom for the rest of the payload, as `index.ts`
explains) while `MAIL_MAX_MESSAGE_BYTES` measures the **composed message**. They are separate quantities and neither
replaces the other, which is worth recording because "unify the two 25s" is the obvious-looking change that would
break both.

That reading also corrected my own text: the configuration page implied the variable could raise the ceiling for a
large attachment, and it cannot, because the upload guard refuses first. Both it and `.env.example` now say so.

**A documentation claim that preceded its code.** `Email-and-threading.md` described attachments "with a combined
size limit" — and there was no limit in the composer or on the server, only whatever a reverse proxy happened to
impose. This session has spent most of its effort finding documentation that overstated **implemented** scope; this
is the same defect in the opposite direction, a page promising a guarantee the code did not provide, and it survived
because nobody sends 26 MiB by accident. The send-path work above made the promise true at last, and the wording is
now precise about *when*: the composer does not pre-check, the server counts on send, and passing that check is not
the provider's permission.

**§12's first item is now implemented for the transport that exists.** The send path composed its message on the
server and never counted it, so an oversized message travelled to the SMTP server and failed there; it is now
counted as compiled — before any idempotency claim or dispatch, so a refusal leaves no uncertain send — and refused
with `413 MESSAGE_TOO_LARGE`, the real byte count and the limit, configurable with `MAIL_MAX_MESSAGE_BYTES` and
defaulting to Gmail's 25 MiB raw-message ceiling rather than an invented budget. A case asserts the refusal and that
**`sendMail` was never called**. The three-size accounting of §12.2, the provider uploads and the state machine
remain open.

**And a process failure worth recording beside it.** That change's case reached `dev` red: I piped the test runner
to `tail`, which returns the pipe's status, so the chain continued past a failing suite and the commit message
claimed a green run. It was corrected in the next commit, and it is the **second occurrence** of the same mistake in
this session — the screenshot verifier in round 198 was the first — and the first that put a red test on the branch.
The corrective is mechanical and now stated: read the **exit status**, never the piped tail, before staging.

### The *ignore and send anyway* affordance, specified down to the lines

The last composer-side item, and it is now small enough to describe exactly rather than estimate. What already exists is
the mechanism the plan requires it to use: `idempotencyKeyRef` holds **one key per logical send**, set on the first
attempt, sent as `X-Idempotency-Key`, **cleared on success** and **deliberately kept on failure** — which is what makes
an ordinary retry land on the same intent instead of creating a second message. A deliberate re-send is therefore a
**new operation**, and the way to express that in code is to clear that ref and send again, from an explicit user
action.

Concretely, for the next session:

1. a state flag set where the composer already recognises `SEND_OUTCOME_UNKNOWN` (the branch added this session);
2. a control rendered beside the error text — the two sites are the mobile and desktop layouts at
   `ComposeModal.tsx` lines **1611** and **2296** — whose handler clears `idempotencyKeyRef.current`, resets the flag and
   calls the send handler again. **The send handler's name is the one thing not yet read**, which is why this is written
   down instead of started: three edits, three locale sets and no component test is not a change to make with the
   remaining budget, and this session has already paid twice for starting what it could not finish;
3. three keys in nine locales — the control, the duplicate-risk warning it must show, and the confirmation — with the
   warning carrying the plan's substance: sending again **may** create a duplicate, and the Sent folder is still the
   authority.

Note what must **not** happen: clearing the key without the explicit action. The ref is the only thing preventing an
ordinary retry from duplicating a message whose outcome is unknown, so an automatic clear would be worse than the missing
affordance.

### The editor's messages (§12.9): the behaviour exists, the translation does not

The last unread subsection of §12 lists five messages it calls **mandatory and translated**. Read against the
implementation, four of the five behaviours exist today — and three of the five are shown to the user as the server's
English sentence rather than as an interface message, which is the requirement the plan actually makes.

| The plan's message | State |
| --- | --- |
| "File «x» has {actual}; the limit is {limit}. The file was not attached." | **Behaviour yes, translation no.** The refusal carries `ATTACHMENT_TOO_LARGE`, the file name and its bytes, and the composer displays the server's English text. The plan wants the numbers filled into a translated sentence. |
| "The whole message encoded is {actual}, and {limit} is allowed. Remove some files or shorten the message." | **Behaviour yes, translation no** — the same shape: `MESSAGE_TOO_LARGE` now carries the composed size, the limit and the attachment subtotal, and none of it is translated. |
| "The provider rejected this attachment type. The draft was kept." | **No behaviour to translate**: there is no provider attachment path until the API transports exist. |
| "The forwarded attachment could not be fetched. The message was not sent without this file." | **Behaviour yes, translation no** — the send is refused before dispatch when a forwarded part cannot be read, which is the required consequence — and the refusal **now carries codes** — `ATTACHMENT_FETCH_FAILED` for a part that cannot be read and `RESOURCE_NOT_FOUND` for a missing message, part or account — so the missing half is the composer's branch and its translated sentence rather than the server's vocabulary. |
| "The message may have been accepted… sending again may cause a duplicate." | **Done**, in nine languages: the uncertainty message added this session says the result is unknown, that it will not be resent automatically, and where to look. The plan's wording mentions the duplicate risk explicitly, which is a wording difference rather than a gap. |

**And the translation half is now done for three of them**: the composer branches on `ATTACHMENT_TOO_LARGE`, `MESSAGE_TOO_LARGE` and `ATTACHMENT_FETCH_FAILED` and renders its own sentence with the server's figures — file name, actual size and limit, formatted in units a person reads — in all nine languages, so the rows above that said "translation no" describe the state before this change. The third row still has no behaviour to translate, which needs the API transports. What remains from §12.9's list is the wording difference in the uncertainty message, not a missing message.

So §12.9's requirement is **met for one of five and half-met for three before the change above; four of five are met now**: the behaviour is right in each case, and the
missing half is consistent — codes exist for two of the three (and the third needs one), and the composer needs a branch
and a translated sentence with the numbers interpolated. That is a bounded piece of work of exactly the shape this
session completed twice for other messages, and it is recorded rather than started because the composer's error
rendering, three locale sets and a new code is more than the remaining budget can implement **and verify**.

### The send state machine and drafts (§12.7–12.8), read against the code

| Requirement | State |
| --- | --- |
| A send state machine with `accepted` distinct from delivered, and no delivery claim without evidence | **The semantics exist under different names.** Durable send intents carry `completed`/`mismatch`/`uncertain`/`inflight`, the SMTP result carries accepted and rejected recipients separately, and the sent copy is a separate step (IMAP APPEND). Nothing in the stored state claims delivery. The plan's state names are its proposal, not a contract the code must adopt. |
| A stable idempotency key bound to the draft, recipients, alias and files; two parallel clicks start at most one operation | **Met** — the fingerprint and its compatible variants are stored with the intent, and the claim is a database row plus a Redis reservation, which is what makes a second click a no-op rather than a second message. |
| The durable claim must live in the database, with Redis only accelerating it | **Met, and deliberately commented as such** — the database intent is described in the code as "the final, cross-process gate immediately before SMTP", authoritative "if Redis is flushed while another request is still preparing". This is the rule the plan states, implemented as the reason it states it. |
| After `outcome_unknown`, automatic retry is off until reconciliation | **Met** — an uncertain intent refuses automatic re-send and says the result is still being confirmed. |
| A deliberate re-send after an unknown outcome warns about duplicate risk | **Half met, half absent.** The API half now carries a **`SEND_OUTCOME_UNKNOWN`** code alongside its sentence, pinned by the table-driven case that already exercised the path, so an interface has something to branch on. The prohibition is real and verified: an uncertain intent refuses an automatic re-send, and clicking send again does not override it. **The interface now says it in the product's own words**: the composer recognises the code and explains, in all nine languages, that the result is unknown, that it will not be sent again automatically, and that the account's Sent folder is the authority — as a notification and beside the composer, with the user's text kept. **And the warned deliberate re-send now works**: the composer releases its idempotency key when it reports the uncertainty, so the user's next Send is a **new operation** instead of a refusal, with the duplicate-risk warning already on screen. There is no separate *ignore and send anyway* button, and the reason is in the code's comment: this composer dispatches only from a click, so the key's protection is against an *automatic* duplicate and there is no automatic path left once the user has been told. Checking the Sent folder is still the first advice, because a duplicate is worse than a delay. Verified by typecheck, lint, the nine-locale parity suite, the build and the frontend suite — **not** by a component test, because the composer has none. |
| A late autosave must not resurrect a sent draft | **Met in mechanism.** Remote autosave is decided by `shouldAutosave`, which receives the **`sending` and `savingDraft`** flags as inputs rather than checking dirtiness alone, and a successful send deletes the sent draft and closes the composer. The predicate's body was not read, so this is verified from its inputs and its caller, not from its implementation. |
| A draft snapshot must carry Bcc, quote, signature, alias, reply headers and inline/reference data; revision conflicts must not overwrite a newer answer; changing the account must move the draft per an explicit policy | **Not verified** for the conflict and account-change halves. The snapshot half is exercised by the existing draft tests, and attachments are documented as deliberately not stored in drafts. |

Two rows are therefore open questions rather than answers, and both are in the interface rather than in the
durability layer: the wording of the duplicate-risk warning, and the cross-tab revision and account-change policy.

## The send and attachment specification (§12), as the task list for P06, P07b and P08

Reading this chapter turns "P06 and P07b are package-scale" into a specification, and two of its numbers are traps
worth recording so they are not rediscovered by hitting them:

- **Three different sizes, and only one of them is the one users think in.** `rawAttachmentBytes`
  (plain + forwarded + inline + generated), `mimeBytes` (the actually compiled MIME, which includes base64 growth,
  headers, separators, CRLF and signature images) and `httpBodyBytes` (the API transport's chosen encoding, which
  base64url can inflate again). The interface's estimate is preliminary; **the backend counts the real stream
  before the send step**, and neither a `size` field nor the length of undecoded base64 may be trusted. A reverse
  proxy can stop a request before the application ever sees it.
- **Microsoft: direct add under 3 MB, upload session for the range it documents as 3–150 MB** — and being able to
  upload a file does **not** make it sendable, because the message, mailbox and tenant limits and the blocked file
  types are separate. When the tenant's policy cannot be read, the interface must say the provider's limit may be
  lower and still handle a refusal.
- **Gmail's `mediaUpload.maxSize=36700160` is 35 MiB of *media upload*, not a permitted 35 MiB raw attachment** —
  and it must not be confused with the larger limit of a different endpoint such as import.

Beyond the numbers, the chapter requires: composition separated from transport, with one shared layer producing
HTML, text, quoting, signature, alias, To/Cc/Bcc, Reply-To, reply headers, priority and files, so that an adapter
using the provider's JSON instead of MIME **passes the same user-level tests**; no new provider's limits leaking
onto other accounts, and a changed account in the editor recomputing limits and alias/attachment availability
**without discarding the user's text or files**; upload without holding the whole message in memory; a send state
machine; draft autosave; and provider errors surfaced in the editor.

**What exists today:** the IMAP/SMTP composition and send path, which composes MIME and streams attachments. What
does **not** exist: any byte accounting against these three sizes, the provider upload paths, the state machine, and
the two API transports — the same boundary as the mail half of §22.1. The two named unbounded readers
(`draft.ts`, `send.ts`) are where a size limit would have to be enforced first, and the chapter's requirement that
the *backend* do the final check on the real stream is the reason a UI-only estimate would not satisfy it.

## Release 4.1.0 and the image publication

The release version was **sanctioned as 4.1.0** and applied: both package manifests and their lockfiles carry it,
the changelog's `Unreleased` section became `4.1.0 - 2026-09-19`, `docs/wiki/Release-notes-4.1.0.md` exists and is
linked from the changelog header and the wiki sidebar. **W19 is therefore met**, and the release notes state the
policy, the additions, the fixes, the migration requirement (`0101`–`0106` in order, before rollout), the two new
optional variables and the known limitations — including that no real provider application was registered, so the
live authorization is NOT RUN.

**Image publication was authorized as `dev`-tagged images**, which is what `.github/workflows/publish.yml`
already does: both images (`inboxora-backend`, `inboxora-frontend`), tagged `dev`, for `linux/amd64` and
`linux/arm64`, with an assertion that the source SHA is **reachable from `origin/dev`** — the plan's "one final
SHA" rule, enforced by the workflow rather than by convention. It is a `workflow_dispatch` workflow, so it was
**dispatched from this release's SHA** once that SHA was the head of `dev`. **The run completed successfully from SHA `035f60ab`**, and the images were then verified in the registry rather than taken on the workflow's word: `ghcr.io/dragonk/inboxora-backend:dev` and `ghcr.io/dragonk/inboxora-frontend:dev` both resolve to **OCI image indexes** carrying **`linux/amd64` and `linux/arm64`**. That is P14's **build + registry-verification** part — both images, both architectures, one dev-reachable SHA — and the registry check is what makes it evidence instead of a green checkmark. It is **not** a runtime check: no container was ever started from those digests, so P14's *runtime smoke pair* stays **NOT RUN**, and the publication corresponds to `035f60ab` rather than to the tip of `dev`. Nothing here touches `main`.

## Acceptance criteria W01–W19, as the plan requires them reported

The plan states that the scope is not complete until every W item has associated code **and real test
results**, that missing test accounts or devices are **not** proof of operation, and that the report
must separate **PASS, FAIL, SKIPPED and NOT RUN** and must not call the implementation fully accepted.
That is what this table is; "code ✓" never means PASS on its own.

| W | Requirement (abbreviated) | Verdict | Evidence and what is missing |
| --- | --- | --- | --- |
| W01 | Menu follows the finger; the gesture starts in the left quarter | **PASS with NOT RUN** | Gesture machine, arbiter and hook are implemented and unit-tested; **no real touch device was used**, so device behaviour is NOT RUN. |
| W02 | Gesture switch beside the mobile panel setting, persisted | **PASS** | Switch rendered next to the navigation-position setting, value persistent through the server allow-list; pinned by a contract test. |
| W03 | Scroll, row action, long-press, calendar and menu do not run competing operations | **PASS with NOT RUN** | The arbitration layer and its guard tests cover this; **not exercised on a device**. |
| W04 | External calendars/books work in the UI and over DAV as RO/RW per real rights; **the write reaches the source** | **FAIL** on the second half, **delivered on the first** | The row has two clauses and the verdict hides one of them. Imported collections *do* work in the interface and over DAV, and they are reported as read-only precisely because their source is the only writer — so "RO/RW per real rights" is satisfied, with the RW case reachable for local collections and refused for imported ones. What fails is the clause the row emphasises: a write does not **reach the source**, because write-back is the open P10 client. A reader taking the bare FAIL would conclude imported collections do not work at all, which is not the case. |
| W05 | DAV sharing independent of UI use; off / RO / RW limited by the source's rights | **PASS** | Per-collection `dav_mode`, per-password ceiling, provider collections refused writes; covered by `davVisibility` and the DAV database suite. |
| W06 | Microsoft: full mail over Graph plus that account's calendars and contacts | **FAIL** | Contacts are delivered; the mail **folder tree** (`705b13bc`), **message metadata with a per-folder delta** (`011b2251`), **read/star flag mutations** (`7076f4e1`), the **body with attachments** (`08f40ad1`), **delete** (`90bd9d02`), **move/archive** (`7ff67202`), **spam/ham** (`694141eb`), **snooze** (`ed3dbc18`), **bulk delete** (`30372761`), **mark all as read** (`24355f76`), **source headers** (`de85be4d`) and the **attachment ZIP** (`b9177c3f`) are delivered too. What is not: drafts, send, conversation persistence, search and the reply/forward dependencies, and the **Graph calendar adapter** (P07b continues, P07d). The row asks for full mail, so it stays FAIL rather than partial — a mailbox you can read but not file or answer from is not mail. |
| W07 | Google: Gmail/Calendar/People recommended, free choice of transport, one transport after cutover | **FAIL** | Calendar and People are delivered; **Gmail is not implemented and no cutover exists** (P08, P12). |
| W08 | Independent calendar and contact switches per Microsoft/Google account, with collection discovery | **PASS** | Per-provider connect buttons, discovery on sync, per-collection enable/disable; the switch enforcement is tested. |
| W09 | Do not remove configuration or force migration of other IMAP/SMTP, DAV or ICS accounts | **PASS** | Nothing migrates or deletes on its own; the only deletion path is an explicit, owner-scoped disconnect that keeps imported data. |
| W10 | Keep the account and its links; Microsoft migrates automatically with sufficient consent, Google only on explicit choice | **FAIL** | No migration exists at all (P12 not started). |
| W11 | Microsoft: required notice per entry, not permanently hidden. Google: voluntary recommendation until migration or "don't show again"; always an "Ignore" | **PARTIAL** | The **Microsoft half is met**: the requirement appears on the card whenever it is opened and there is deliberately no dismissal for it, which is what "per entry, without permanent hiding" asks for — a dismiss control would have been the failure mode the row names. Google's half belongs to the migration prompt: a "don't show again" and an "Ignore" presuppose a migration to offer, and P12 is blocked on P07b/P08. Earlier this row read SKIPPED, which understated the Microsoft half and implied nothing had been done. |
| W12 | Large attachments, whole-message limit, MIME errors, forbidden files and interrupted sends explicitly handled | **FAIL**, with part of it already true | P06 has not been started, and the row's whole-message limit, MIME dimension and interrupted-send handling are what it is for. Two pieces do exist and are worth naming so the package is not read as untouched: an oversized request is refused with a route-aware message (`requestTooLargeMessage`, and the DAV body cap for those routes), and the attachment size ceiling the interface enforces is the one the parser's 35 MB limit is sized around. The send/draft ledger, the separated MIME/total limits and the interrupted-send state are the missing part. |
| W13 | Keep threads, rules, plugins, notifications, search, aliases and invitations, or name the unsupported provider operation | **PASS** | Nothing is removed by this work, and the unsupported operations are now named per provider in the wiki — no write-back, no push notifications, no remote collection creation or sharing, personal Google contacts only, no Gmail or Graph mail connection, separate Microsoft authorizations. |
| W14 | Integration to `dev`, push, tests, **both `:dev` images from one SHA** | **PARTIAL** | `dev` is pushed and tested (see the counts above). Both images **have** been built for `linux/amd64` and `linux/arm64` from one SHA, `035f60ab`, and verified in the registry — that half is done. What is **NOT RUN** is running the published pair: `/api/health`, `/api/version` and a basic login/UI check on those exact digests were never performed (see P14). |
| W15 | No leakage between users, grants, accounts and DAV passwords; no silent data loss | **PASS** | Owner-scoped queries and 403 guards on every provider route; DAV credentials isolate users; refusals write nothing; integration tests assert the isolation. No independent audit was performed. |
| W16 | The "email providers" screen: instructions, configuration and per-method diagnostics | **PASS** | The integrations card states each provider's requirement and readiness, with the Graph/device/browser methods separated. |
| W17 | Microsoft web and device code have correct separate requirements and refresh; no Google device flow for mail/calendar/contacts | **PASS** | Separate readiness and switches, enforced in the flows; Google reports `deviceCode.supported: false`. |
| W18 | Google IMAP works without an OAuth project; attaching Calendar/People does not migrate mail or request Gmail scopes | **PASS** | The authorization requests read-only People/Calendar scopes only; no Gmail scope, no transport change, and IMAP is untouched. |
| W19 | Complete admin instructions, updated documentation and translations, and tests of all variants as the publication gate | **PARTIAL** | The wiki, nine locales, this document and the release notes for **4.1.0** are done, and the browser gate and the database gate were run. Outstanding: tests of **every** variant (the §8 live provider configurations are NOT RUN), the real-client DAV run (NOT RUN), and the metrics/performance work under P13. |

The three FAIL verdicts on W04, W06 and W07 are the packages that remain (P10 write-back, P07b/P07d,
P08), and W10/W11 follow from P12. No item is marked PASS on the strength of code alone, and the three
"NOT RUN" entries are exactly the places where only a real device, account or registry could decide.

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
| Real-PostgreSQL integration (provider sync, token refresh, OAuth flow table, mutation layer, Graph mail, DAV) | runs with `DB_*` | **gated** (`ci.yml` → `backend-database`: `postgres:16-alpine`, the chain applied to an empty database, then the suites) | gated |
| Browser E2E, five projects | skipped unless run explicitly | **gated** (`conversation-v2-playwright.yml`, now triggered on `push: [dev]` as well as on a pull request) | gated |

So two of the three layers were verified but never gated, and the work was integrated by pushing
directly to `dev`. That is the complete explanation for two real defects surviving many rounds of
per-round verification: the verification was real, and narrower than it looked.

**Both gaps are now closed** (the CI slice that also carried this document's update): the database job and the browser
trigger are in the workflows below. What remains unverified is the *GitHub plumbing*, not the
commands: the job has never run on a runner, so the action versions, the cache path and the service
wiring are unproven — while the commands inside it have been executed by hand against a database
created empty for the purpose, where the chain applied from zero (112 migrations) and all 179
integration tests passed. That distinction is the same one this document draws everywhere else, and
it is stated rather than glossed because "the job is in the file" is not "the job is green".

The recipes are kept below as the record of what was applied, with the job now living in `ci.yml`:

- **Database suites** — add a job to `ci.yml` with a `postgres:16-alpine` service and the `DB_*`
  variables, then run the gated files, e.g.
  `npx vitest run src/services/providerAuthService.integration.test.ts src/services/providerTokenService.integration.test.ts src/services/providerOperations.integration.test.ts src/services/providerMutationService.integration.test.ts src/services/providers/google src/services/providers/microsoft src/routes/davPg.integration.test.ts`
  with `REQUIRE_DAV_POSTGRES=1`. These pass against a fresh database with the full migration chain,
  so the job would also prove the migrations apply.
- **Browser suite** — add `push: branches: [dev]` to `conversation-v2-playwright.yml`, or integrate
  through a pull request so its existing trigger applies.

The database recipe as a job, ready to paste into `ci.yml` beside the existing `backend` job (the
suite creates and drops its own rows, so it needs nothing but an empty migrated database):

```yaml
  backend-database:
    name: Backend (PostgreSQL integration)
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: mailflow_test
          POSTGRES_PASSWORD: mailflow_test
          POSTGRES_DB: mailflow_test
        ports: ['5432:5432']
        options: >-
          --health-cmd "pg_isready -U mailflow_test -d mailflow_test"
          --health-interval 5s --health-timeout 5s --health-retries 20
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm, cache-dependency-path: backend/package-lock.json }
      - run: npm ci
        working-directory: backend
      - name: Apply migrations (transactional, then the ones marked -- no-transaction)
        working-directory: backend
        env:
          PGPASSWORD: mailflow_test
        run: |
          set -euo pipefail
          for f in $(ls migrations/*.sql | sort); do
            if grep -qE '^--\s*no-transaction' "$f"; then
              psql -h 127.0.0.1 -U mailflow_test -d mailflow_test -v ON_ERROR_STOP=1 -q < "$f"
            else
              psql -h 127.0.0.1 -U mailflow_test -d mailflow_test -1 -v ON_ERROR_STOP=1 -q < "$f"
            fi
          done
      - name: Integration suites
        working-directory: backend
        env:
          DB_HOST: 127.0.0.1
          DB_PORT: '5432'
          DB_NAME: mailflow_test
          DB_USER: mailflow_test
          DB_PASSWORD: mailflow_test
          REQUIRE_DAV_POSTGRES: '1'
        run: |
          npx vitest run \
            src/services/providerAuthService.integration.test.ts \
            src/services/providerTokenService.integration.test.ts \
            src/services/providerOperations.integration.test.ts \
            src/services/providerMutationService.integration.test.ts \
            src/services/providerConnectionService.integration.test.ts \
            src/services/providerSchemaUpgrade.integration.test.ts \
            src/services/providers/google src/services/providers/microsoft \
            src/routes/davPg.integration.test.ts
```

One requirement of the suite list: `providerSchemaUpgrade.integration.test.ts` creates and drops a database of its own, so the role it connects as needs `CREATEDB` — the `postgres` service user below has it — and it removes that database in `afterAll` even when its assertions fail.

**This job is in `ci.yml` now** (`backend-database`), on every push to `dev` and every pull request,
and it applies the chain with the application's own runner rather than a `psql` loop — the path
production startup takes, and the one `schema_migrations` and the upgrade suite's checksums belong to.
The by-file path is still exercised, by `providerSchemaUpgrade.integration.test.ts`, so both are
covered rather than only the one the job picks. One caveat, so nobody mistakes it for something it is
not: the **commands have been run by hand** against a database created empty for the purpose (112
migrations applied from zero, 179 tests green), but the **job itself has never run on a GitHub
runner** — action versions, cache paths and the service wiring are unverified — and the suite creates
and drops its own database, so it must not share one with another job.

What it buys beyond the tests: it proves the **migration chain applies to an empty database**, which
no other job in this repository currently does for a fresh install.

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

> **Partly superseded.** This section was written when nothing imported the capability table or the
> journal. Both were wired in `b0381b77` (the capability model decides collection access) and
> `d89c42a3` (the mutation layer, on the mail flag path), so the paragraphs below are history for
> P01/P03 — kept because the distinction they draw is the one that matters. What is still dormant is
> named at the end of this section.

Reading the import graph rather than trusting the package list corrects two rows above: some of
this work is delivered and tested but not yet *called*. `syncCoordinator`'s leases run on every
connector sync, and the provider registry is consulted by the mail paths — but
`providerOperations.ts` (the journal and outbox) and `providers/capabilities.ts` have no production
importer.

That is not a defect: they were built as the vehicle for P10 write-back and the P12 cutover, and
those packages have not started. It does mean "delivered" in the table above should be read as
"the code exists and its tests pass", not "the application exercises it" — which is what the
per-package column now says for P01 and P03.

**Still dormant after the P01/P03/P07b slices**, verified by reading the import graph again: the
**domain outbox** (`domainOutbox.ts`) has no production enqueuer, so `domain_outbox` is still empty
in a running installation. One item on this list has since been closed: the `pending` pool **is**
read — the Microsoft Graph message sync drains scheduled flag mutations through it (`7076f4e1`). The
IMAP flag path still uses its own in-memory reconciler rather than the journal, which is recorded
under P03 as the remaining half.

## Closed: PROPPATCH is answered

Clients such as Thunderbird and DAVx5 set a display name or colour on a collection with `PROPPATCH`.
Neither router handled it, so the request reached the framework default — which a client receiving it
on a collection that exists has every reason to read as "the collection is gone".

Both routers now refuse it with a `DAV:error` body saying that properties are managed by Inboxora,
and the tests assert the refusal writes nothing. Two mistakes made on the way, both worth keeping:
the response I first described was produced by the handler I had just added rather than by the
server, and my CardDAV handler compared against the calendar router's request attribute — this router
has always called it `cardavUserId` — so its guard refused before the reason could be written.

`PROPPATCH` is deliberately **not** listed in either router's `Allow` header, and that is the right
state rather than an oversight: the server refuses the operation, so advertising it would invite
clients to attempt something they cannot accomplish. The refusal follows RFC 4918 — `403` with a
`DAV:error` body — and both routers advertise `OPTIONS, GET, PUT, DELETE, PROPFIND, REPORT` with
compliance `1, addressbook` / `1, calendar-access`, which matches what they implement.

`MKCALENDAR` remains deliberately unimplemented and documented as such in `caldav.ts`, with the
compliance classes that would imply unadvertised, which is correct.

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

## Unsupported operations on a native Microsoft account, named per route

P07b has wired eleven actions through the transport dispatch. This is the audit of what is **left**, done
by listing every `imapManager.*` call site in the mail routes and reading which of them a Microsoft Graph
account can reach — the same check snooze should have had before it was assumed to be local, and the
thing W13/W19 require to be *named* rather than discovered by a user whose action fails.

`bulk-delete`, `mark-all-read`, `headers` and the attachment ZIP were rows of this table and are now
wired (`30372761`, `24355f76`, `de85be4d`, `b9177c3f`); what remains reachable and **not** wired to the
provider is the folder management below — and that is the whole list:

| Route | IMAP call it makes | What a Graph account gets |
| --- | --- | --- |
| `POST /folders`, `/folders/delete`, `/folders/rename`, `/folders/empty` | `createFolder`, `deleteFolder`, `renameFolder`, `emptyFolder` | Folder management is IMAP-only. Graph *can* create a folder — the snooze slice added that primitive — so these are implementable, but each also needs a discovery pass so the local model follows. `emptyFolder` has no direct Graph equivalent and needs pagination over the folder's messages. |

**Not reachable**, verified rather than assumed: every other `imapManager.*` call site in the mail routes
sits inside an `else` branch that a native account does not enter — the flag push, the single-message
move-to-Trash and permanent delete, snooze, spam/ham, and the IMAP arms of bulk-move and bulk-archive.
`imapManager.broadcast`, `_guardMoveUid`/`_unguardMoveUid` and `syncFolderOnDemand` are not provider
calls: the first two are no-ops for an account that is never IMAP-synced, and the third is only ever
reached for IMAP accounts.

**The order they should be done in**: `bulk-delete` first (core action, helper already exists), then the
folder routes (they make a native account self-managing, and the create primitive is already there),
then `mark-all-read`, `headers` and the attachment zip, which are smaller and have local fallbacks.

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
- A Microsoft account's **folder tree, message list, body and attachments** are imported;
  **read/unread, star, move, archive, single and bulk delete, spam/ham and snooze** work over Graph, where delete
  follows the IMAP path's rule (a draft and an already-trashed message are removed for good, anything
  else goes to Trash) and snooze creates and discovers the `Snoozed` folder it needs. What is *not*
  there: drafts, send, search over the provider, reply/forward dependencies, and conversation
  persistence beyond the `thread_id` the sync stores. Graph is not yet a mail transport, so the account
  still reads mail over IMAP/SMTP and nothing migrates on its own.
- Mail folder discovery is a **full snapshot** per run rather than a Graph folder delta. A folder tree
  is small enough that a snapshot is the simpler correct answer; message sync is where the delta
  cursor belongs.
- The provider refresh runs in-process on a timer (default 15 minutes, one pass 30 seconds after
  start). There is no external scheduler, so a stopped server does not refresh — by design for now.
- Provider error codes surfaced in the UI are the recorded domain codes, not the providers' raw
  messages.

## How to continue the remaining packages

Entry points and constraints discovered while building what exists. They are recorded so the next
session does not have to rediscover them, not as a design that has been agreed.

### Small specified items, as opposed to packages

These are not packages like P07b; each is measured in a few files, and each has its location recorded above.
They are collected here because a reader planning work looks at this section, not at the acceptance tables.

| Item | What it needs | Where it is described |
| --- | --- | --- |
| **AD07** — a new Client ID silently keeps the old secret | A confirmation flag on the save path (keep the secret when confirmed, refuse with a clear answer otherwise) plus a prompt in the card. The naive fix of dropping the secret **breaks AD05** and its test, so the two rows must be satisfied together. | the AD table, above |
| **DC02** — one device flow per user | `deviceFlows` is keyed by `req.session.userId`, so a second start replaces the first. Keying by a flow id and returning it to the client is the shape; the map's key is also what stops another user reaching a flow, so that property must survive. | the DC table, above |
| **DC03** — flow binding | Bind the flow to the account, purpose and configuration revision it was started with, not only to the session's user. | the DC table, above |
| **Contact photos** | Neither provider carries them: a photo needs an authenticated request per contact, which is a deliberate omission rather than an oversight, and the wiki says so. | the provider wiki, "What Inboxora does not do" |
| **The real DAV client run** | P11's acceptance criterion is a full loop with DAVx⁵; the protocol is verified and no real client has talked to the server. | the matrix section, DV rows |
| **The DAV upgrade case's diagnosis** | `runMigrations()` takes no argument and the case applies files itself; if that changes, the case is where to start. | the P02 row |

### Conventions this work settled on, worth reusing

Each of these cost a defect or a round to learn, and each applies to whatever comes next:

- **Gate a provider feature where the readiness report already looks.** `services/providerSwitches.ts` is the
  one place that answers "may this run?", and both the flows and the card read it. The property to preserve
  is that **the interface must not offer what a flow would refuse**; adding a feature means adding its
  precondition there, not beside it.
- **An actionable failure needs a code the UI maps, and the mapping must survive the provider's spelling.**
  `providerFailure.ts` compares upper-cased, because `invalid_grant` arrives from a token endpoint exactly as
  the provider writes it, while `PROVIDER_AUTH_REQUIRED` arrives from our own code. A new error type or code
  has to be recognised in **seven** places, verified by counting them rather than by remembering: the four
  recording sites in the connectors (`googleContactsSync`, `googleCalendarSync` twice — once per calendar —
  and `graphContactsSync`), the two OAuth callbacks that turn a failure into the redirect's error, and the
  token service's own `invalid_grant`/`unauthorized_client` parking check. The first version of this note
  said four, which is only the recording half.
- **A test that catches a rule should assert the rule, not the shape.** The DAV refusals, the invitation
  guard and the reconnect cycle each have a case that would fail if the behaviour changed rather than if the
  SQL text changed; copies of SQL fragments are the weaker form and rot silently.
- **Integration suites that reconstruct state belong in their own database and their own command.** The
  upgrade case creates and drops one; the shared suites deliberately share one. Both are documented, and the
  gate recipe lists every suite, because coverage the command does not run is not coverage.
- **`runMigrations()` takes no argument**, so anything needing a partial chain must apply files itself and
  honour the `-- no-transaction` marker the way the runner does — `CREATE INDEX CONCURRENTLY` cannot run
  inside a transaction.
- **Records drift faster than code.** Every quantitative claim in this document is dated and re-measured
  rather than remembered; ten verdicts were corrected in one session, all in the direction of *more* work
  remaining. Assume the same of anything written here after this note.

## Final report (§30), in the shape the plan requires

> **Historical.** This report is kept because its per-section structure and its "what is missing"
> paragraph are the plan's own reporting shape. It was written at `f12727f6`, and it is **not** the
> current status: the *Status* table and the header at the top of this file are. Where the two differ,
> the table is right.

Written at `f12727f6` on `dev` — the last commit to change **code** — and current at `48b94cbf`, the tip it is
committed against. Every commit between them is documentation only, which is why both are given: §30.1 asks for
the final SHA, and the answer is a pair rather than one hash. It is **not**
a declaration of completed delivery — §30's closure condition is that every agreed feature is present with its tests
settled and a verified image pair on the same commit, and the last section below says exactly what is missing.

### 1. Code

**Final SHA: `f12727f6` on `origin/dev`**, tree clean. Every container this work started was named `inboxora-p…`
and has been removed; two containers named **`inboxora-v3-redis`** and **`inboxora-v3-postgres`** are running in
this environment and were **not** started here, so they were left alone — worth knowing before anyone reads a
clean `docker ps` from this document. The integrated work spans the packages
P00–P14 in the order the plan sets, with the largest pieces being the provider contract/registry layer and schema
(`0101`–`0106`), the OAuth and token service for both providers, the complete Google vertical (contacts, calendars,
People, discovery, scheduling, connector status, per-collection control), Microsoft Graph contacts and the device
flow, the DAV hardening and the documentation package, the 4.1.0 release, and the send-path accounting added after it.
Every commit carries the required trailer.

**Discrepancies between the base audit and the final code, and how they were handled:** the plan's own tables and
chapters were read against the implementation repeatedly, and **every** discrepancy found was disclosed rather than
smoothed — fourteen corrections to the acceptance surface in one pass, three items resolved as **stated absences**
rather than invented features (*Ignore* / "do not show again", a second mail transport, a Google device flow), each
chapter read producing either a fix (device polling limits, scheduler backoff with jitter, the CalDAV projection
filter, report dispatch by root element) or a recorded gap (metrics, scheduler diagnostics, the interface's
duplicate-risk affordance). Two claims of mine were themselves corrected the same way, including one that described a
size limit the code did not have.

### 2. Requirements

**W01–W19** are reported in the table above, each with its location and its verdict, and the **execution matrix**
(AU/ML/AT/KC/DV/GE/MG/DC/AD) alongside it. The provider operations that are **explicitly limited** rather than
implemented are: everything the provider owns is **read-only** (no write-back, no mutation journal), the mail
transports over the APIs do not exist (so mail is IMAP/SMTP, and the "no send fallback" rules have no second
transport to fall back *to*), notice preferences and the migration prompt are absent, and the device flow's
**polling limit** was added this session while its **live** authorization remains unrun.

### 3. Data and authorisation

Migrations **`0101`–`0106`**, additive, to be applied **in order before application rollout**; no existing table,
column or row is rewritten. The state-reconstructing suite that applies the chain and then asserts that seeded
identifiers survive passes, and it creates its own database, which is why it needs `CREATEDB` and its own invocation
rather than the ordinary suite. Existing accounts are **not migrated** and nothing is removed: a Google mailbox keeps
working on an app password with no OAuth project, and a Microsoft mailbox needs the connection the card states.
Read-only is enforced for provider-owned collections; disabling a provider, a method or the whole layer is enforced
and preserves data, with a tombstone so a restart cannot resurrect old configuration. **No secrets, tokens or
private data appear in this report or in the repository's documentation**, and that is a checked claim rather than an
assurance: the documentation, README and `.env.example` were searched for credential-shaped assignments
(`secret`, `password`, `token` followed by a long value) and for long hex or base64 runs. Nothing matched; the only
long strings are a commit SHA — which §30.5 requires — and image or URL paths.

### 4. Quality

Read from each command's **exit status**: backend typecheck, lint and **2279** unit tests green; frontend typecheck,
lint, **2682** tests and a production build green; **99** database integration tests across twelve suites on a fresh
PostgreSQL 16 with the full 109-migration chain; browser **205 passed, 0 failed** (desktop 125 + mobile 80).
**Skipped, separately:** 89 backend tests and 13 backend files are skipped by design. **Re-run at this tree, after
the report's first draft flagged them as stale:** the browser matrix was re-executed against a build made with the
mocked API and finished green — **232 passed, 136 skipped, 368 total, exit 0** — so it now covers the provider-card
test control and the composer's uncertain-send message, the two changes that postdated it. That count differs from the
**205 passed, 161 skipped** reported earlier in this document, and the cause is **the project flags, not the code**:
the earlier figure came from `--project=chromium-desktop --project=chromium-mobile`, while this run used
`--project=chromium-desktop --project=chromium-mobile-390` — a different phone project with a different set of
skipped tests. Both are green, and both were then re-measured at this commit so the document carries one comparable
pair rather than two half-explanations:

| Projects | Passed | Skipped | Exit |
| --- | --- | --- | --- |
| `chromium-desktop` + `chromium-mobile` | **205** | **163** | 0 |
| `chromium-desktop` + `chromium-mobile-390` | **232** | **136** | 0 |

The skipped count in the first row is **two higher** than the 161 recorded earlier, and that is this session's own
work: the provider-card capture added a test to the screenshots spec, which skips itself unless `DOCS_SCREENSHOTS=1`,
so two more tests skip in an ordinary run. A number is only comparable with the projects it was measured on **and**
with the tree it was measured at, which is why both belong beside the figure. The **database gate was re-executed too**, exactly as the recipe below prescribes, on a fresh
PostgreSQL 16 with all 109 migrations applied in order: **12 files, 99 tests, exit 0** — which also turns that recipe
from "ready to paste" into an executed one. **Not run, separately: the performance comparison §25.1 requires** — no
representative before/after measurements exist, and the plan's own rule forbids substituting an invented budget for
them. Error and conflict behaviour has dedicated tests: rate-limit
versus auth classification, expired cursors, read-only refusals, idempotency mismatch and uncertainty, and the
calendar conflict paths.

### 5. Images

Published from **one commit, `035f60ab1843a4a60c1d6379a0d5dbaec9304324`** (the 4.1.0 release), by the dispatched
workflow run **`35425837287`**, which succeeded and whose source-reachability assertion the workflow itself enforces:

| Image | Tag | Digest | Platforms |
| --- | --- | --- | --- |
| `ghcr.io/dragonk/inboxora-backend` | `dev` | `sha256:ea46f1808e4aff06fc1d624fa19afc260551955a3898f8618c84ae64eb05a7f9` | `linux/amd64`, `linux/arm64` |
| `ghcr.io/dragonk/inboxora-frontend` | `dev` | `sha256:d099fbf3bee52733440ea425b673044af3d81ca0f8c92038297e8a0ed1606723` | `linux/amd64`, `linux/arm64` |

Both were verified in the **registry** rather than taken from the workflow's conclusion: each tag resolves to an OCI
image index carrying both platforms. **No container smoke test of the published images was run** — the digests and
platforms are registry facts, and a smoke run is not among them. Note also that `f12727f6`, the commit this report
describes, is **newer** than the published SHA: the images correspond to the 4.1.0 release, not to everything
integrated since.

### 6. Operations

The final instructions are in the repository on `dev` and reachable from the sidebar: **Google** (browser OAuth for
the API, app password for mail, no device flow and why) and **Microsoft** (browser and device-code variants, the
*Allow public client flows* requirement, personal accounts and tenant blocks) in `Provider-setup.md`; the policy,
both switches and the message-size limit in `Configuration.md`; the upgrade behaviour, the migration requirement and
what is *not* included in `Upgrading.md`; the provider diagnostics, rotation and the three credential kinds in
`Troubleshooting.md` and `Security.md`. UI copy, the nine locales and the README carry the same policy, and the
provider card was captured for the documentation with `scripts/verify-docs-screenshots.mjs` passing over 30 images.
**The procedure tests of §8 are NOT RUN**: no real Google or Microsoft application was registered, so live
authorization is unverified for both. What can be confirmed separately is that **Google is never asked to migrate** —
no code path returns a migration requirement for it, and connecting the API does not touch mail — and that the
**Microsoft device-only configuration works without a secret or a callback** in the flow, its readiness and its
refresh, as its tests assert. Rollback is documented in `Upgrading.md`. **Unresolved risks:** the interface's
duplicate-risk affordance for an uncertain send; the configuration-card **test control** being newer than the published
images, so it is not in 4.1.0 and is verified by typecheck, lint, the parity suite and the build rather than by a
component test; metrics and structured log identifiers; the **image-publication failure path**; **RE07's crypto half is now tested** — the encryption primitive the row depends on was exercised only through mocks until now, and a test pins the round trip, the absence of plaintext in the ciphertext, and the refusal of a different key, plus two implicit contracts (`encrypt` throws without a valid key rather than storing plaintext, and `decrypt` throws on a non-string). What remains is the **operational drill** — dump, restore into a fresh database, and confirm the tokens, mappings and operations come back readable with the same key; secrets in logs, build arguments, labels, bundles and DTOs, of which only the documentation was searched; and the absence of any live provider run.

### What is missing, precisely

The agreed scope is **not** fully present. Missing on `dev`: the **Graph mail adapter** (P07b) and with it the
Microsoft mail transport requirement P12 depends on, the **Gmail API mail transport** (P08), the **Graph calendar
adapter**, the **send/draft ledger** (P06), the **external CalDAV/CardDAV write-back client** (P10) and therefore
P09's CRUD, the **source backfill** (P02), the **migration notices** (P12), **metrics**, and the three-size
accounting of §12.2. Tests are settled for everything that **is** present; the published image pair corresponds to
`035f60ab`, not to the tip. This paragraph is the report's answer to §30's closure condition, and it is deliberately
the last thing a reader sees.

### State when this was written (measured again at `d0b93bf4`, after the 4.1.0 release)

> **Historical figures.** The counts in this subsection belong to `d0b93bf4`. They are kept to show
> how the numbers moved and why each is dated; the current measurement is in the header at the top.

Everything below was green at that commit, read from the **exit status** of each gate rather than from piped
output: backend typecheck, lint and **2278** unit tests; frontend typecheck, lint, **2680** tests (0 failing) and a
production build; **99** database integration tests across twelve suites on a fresh PostgreSQL 16 with the full
109-migration chain; and the browser projects **205 passed, 0 failed** (desktop 125 + mobile 80, 161 skipped) from
their last full run, which predates the release. The exit-status rule is stated because this document's author
learned it the hard way one round earlier: a pipe to `tail` returns the pipe's status, and a failing suite went to
`dev` behind one.

The browser run is the point of dating this: the interface changed twice since it last ran in full, so it was
re-run rather than assumed, which is the rule this work settled on and the reason the drawer regression was
caught at all.

The counts grew while the section below was being written, which is the point of dating them: each
`docs:` commit that follows adds no tests, so a reader can trust the numbers against that commit and
should re-run the gates rather than assume a later one matches.

Two of those layers are **not** gated by CI — `ci.yml` has no database service, and the Playwright
workflow is `pull_request`-only — so run them by hand before pushing:

```
cd backend && TMPDIR=/tmp npm test
DB_HOST=127.0.0.1 DB_PORT=55432 DB_NAME=… DB_USER=… DB_PASSWORD=… REQUIRE_DAV_POSTGRES=1 \
  npx vitest run src/services/providerAuthService.integration.test.ts \
  src/services/providerTokenService.integration.test.ts \
  src/services/providerOperations.integration.test.ts \
  src/services/providerMutationService.integration.test.ts \
  src/services/providerConnectionService.integration.test.ts \
  src/services/providerSchemaUpgrade.integration.test.ts \
  src/services/providers/google src/services/providers/microsoft \
  src/routes/davPg.integration.test.ts
cd frontend && PLAYWRIGHT_BROWSERS_PATH=$PWD/../.pw-browsers npx playwright test --project=chromium-desktop
```

Open findings for the next session, each with its evidence in this document: the Microsoft
device switch and the provider/per-method switches are **closed** (enforced, tested); the disconnect
gap is **closed** (endpoint, card control, reconnection, and its consequences verified on a real
database); the integrations card now **has** browser coverage. Still open: the pre-existing Google
provider description asserts an app-password alternative unconditionally, and two readiness flags
(`traditionalImapAvailableInInboxora`, `deviceCode.supported`) are reported constants rather than
probes — if either capability becomes configurable, it must be computed before the text around it
can be trusted.

**P07b — Microsoft Graph mail adapter.** *Slices 1 (folder discovery, `705b13bc`), 2 (message
metadata with a per-folder delta, `011b2251`), 3 (flag mutations over the shared layer with a durable
drain, `7076f4e1`) and 4 (body and attachments, `08f40ad1`) are delivered; this paragraph is the plan
for what is left.* The account-model question it used to raise is
**answered**: the schema already carries `email_accounts.mail_transport`, `provider_connection_id`,
`provider_mailbox_id` and `transport_generation`, so the adapter targets an `email_accounts` row and
the local message/folder/thread model is untouched. What remains, in order:

1. **Conversation persistence.** The message sync already stores Graph's `conversationId` as
   `messages.thread_id`, so the thread *key* exists; what is missing is feeding the conversation
   engine the way the IMAP ingest does (`upsertConversationCopy` with a provider descriptor from
   `providerConversationMetadata`/`providerThreadAdapter`). Read the IMAP ingest before writing a
   second path — the provider identity rules there (`source: 'provider-thread-id'`, the namespace)
   are the part that must not be reinvented, and `gmailNativePg.integration.test.ts` is the example
   of asserting them on a real database.

3. **Rules and the GTD/plugin abstractions** — local behaviours driven by the same message rows, so
   they should need no Graph-specific code; verify that rather than assuming it, and name anything
   that does.

4. **Drafts and send** belong to P06 and the shared send layer — not a Graph-only pipeline.

Read §12 of the plan before choosing the send shape; the three-size accounting and the upload-session
rules live there.

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

**P13/P14 — both decisions below are now settled, so this paragraph is history.** The release version
was chosen and shipped as **4.1.0** (`docs/wiki/Release-notes-4.1.0.md`), and registry authorization
was granted: the `:dev` pair was published from `035f60ab` and verified in the registry. What remains
for P14 is not authorization but *execution* — the runtime smoke pair on the published digests, and a
final publication from the exact final SHA once the open packages close.

## Open questions for the maintainer

1. ~~**Release version** for `docs/wiki/Release-notes-<version>.md`.~~ **Resolved: 4.1.0.** The
   repository requires release notes for every user-visible change and does not allow inferring a
   version; the version was sanctioned as **4.1.0** and applied to both manifests, the lockfiles, the
   changelog and `docs/wiki/Release-notes-4.1.0.md`. New user-visible work starts a new `[Unreleased]`
   section in `docs/CHANGELOG.md` and needs a version decision before it can be released.
2. ~~**Registry/CI authorization** to publish `ghcr.io/dragonk/inboxora-backend:dev` and
   `...-frontend:dev` and smoke-test the pair (P14).~~ **Partly resolved.** Authorization was granted
   and the pair was published from `035f60ab` and verified in the registry. Still outstanding: running
   that published pair (P14's *runtime smoke pair*, **NOT RUN**) and the final publication from the
   exact final v4 SHA.
