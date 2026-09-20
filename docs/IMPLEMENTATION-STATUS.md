# v4 delivery status (P00–P14)

**Status: prepared on `dev`, not released.** `main` has not been touched: 4.1.0 reaches it only through a
pull request from `dev`, and until that happens this document describes code that is integrated and
tested on `dev` and published as `:dev` container images.

The v4 work is the provider layer: native Microsoft Graph mail, calendars and contacts; the Gmail API as
an optional transport for Google mail; Google Calendar/People; external CalDAV/CardDAV write-back; an
in-place transport cutover and a migration recommendation; and a transport-aware send-limit model. The
plan itself (`Inboxora-plan-wdrozenia-v4.md`) was never committed to this repository, so this status is
written against the **code and its tests** plus the requirements as they are recorded in the wiki,
changelog and release notes — not against any earlier handoff note. Where a row needed a source outside
the repository, it says so.

Each package has exactly one current state:

- **delivered** — implemented, tested and merged to `dev`;
- **delivered — live acceptance NOT RUN** — the same, with the one part that needs a real provider,
  device or client explicitly not executed;
- **partial — real implementation gap** — a described, user-visible piece is missing;
- **out of v4 scope by explicit design** — deliberately not part of 4.1.0.

## Status

| Package | State | Evidence (commit / path) | Notes and the one thing not run |
| --- | --- | --- | --- |
| **P00** — preparation, CI repair | **delivered — CI jobs NOT RUN on a runner** | `.github/workflows/ci.yml` (`backend`, `backend-database`, frontend jobs), `conversation-v2-playwright.yml` (`push: [dev]`), `-euo pipefail` on every piping workflow | The `dev` gate runs typecheck, lint, unit tests, a database job (migrations from empty + the provider/DAV/send integration suites) and the browser matrix. Every command was run by hand against a real PostgreSQL; the GitHub runner execution itself is **NOT RUN**. |
| **P01** — shared provider contracts, registry, capability model | **delivered** | `services/providerAccess.ts`, `services/providers/registry.ts`, `services/providers/contracts.ts`, the four frontend contract tests | One decision point for every collection operation: origin adapter + `source_access` + `user_access` + DAV credential ceiling. `writeThrough` is declared only by adapters that forward writes (`microsoft_graph`, `google_api`, `caldav`, `carddav`). The interface reads the server's `read_only`; `source === 'local'` editability is gone. |
| **P02** — additive schema: connections, grants, remote links, journal, outbox, notice preferences, **backfill/link of existing sources** | **delivered** | `0101`–`0112`; `services/providers/externalCollectionLinks.ts`; `providers/externalCollectionLinks.integration.test.ts`; `providerSchemaUpgrade.integration.test.ts` | The chain is additive and preserves existing ids (proved by the upgrade suite on a database it creates itself). The **external-source link was the real gap** the final audit found: nothing created the `source_connections` + `integration_collections` rows an external CalDAV/CardDAV collection needs, so its write-back switch was unreachable. The external syncs now create that link for every collection they import — new or pre-existing, so the next sync pass backfills — and a real-PostgreSQL suite proves the link, its idempotency and the writable/read-only decision per source kind. Legacy IMAP/ICS sources keep working from their existing tables; they are not migrated into the provider layer, because nothing in v4 requires it. |
| **P03** — operation journal, sync leases, common ingest and mutation services | **delivered** | `services/providerMutationService.ts`, `services/syncCoordinator.ts`, `0102`, `0109` | The journal is on every provider write path: claim committed before the call, ambiguous outcomes parked and never auto-retried, recovered non-idempotent operations reported as `outcome_unknown`, per-collection sync leases. Two components are present but unconsumed and are listed as post-4.1 work rather than release criteria: `services/domainOutbox.ts` has **no producer** (the effects it was designed to carry run on their existing paths today), and the IMAP path still hands unconfirmed flag changes to the in-memory reconciler instead of the journal pool. |
| **P04** — OAuth flows and token service | **delivered — live authorization NOT RUN** | `routes/oauthMicrosoft.ts`, `routes/oauth.ts`, `services/providerAuthService.ts`, `services/providerTokenService.ts`, `0110` | Browser flow and **device-code** flow (public client, device code held encrypted on the flow row with the provider's interval and last poll), PKCE/state/nonce, per-method readiness and switches, refresh lease. No real application is registered, so live authorization is **NOT RUN**. |
| **P05** — mobile drawer gesture | **delivered — real-device acceptance NOT RUN** | `143eca15`, `f76e1a40`, the gesture/arbiter/hook suites and the contract tests | Gesture, arbitration against menu/long-press/scroll, a switch beside the navigation-position setting, persisted through the server allow-list. No touch device was used, so device behaviour is **NOT RUN**. |
| **P06** — send/draft ledger, attachment and MIME limits | **delivered** | `services/sendLimits.ts`, `services/providers/mailCapabilities.ts`, `routes/send.ts`, `services/sendTransport.ts`, `send.limits.integration.test.ts` | The limit is the **transport's**, resolved as `min(installation, provider, operation)` with named dimensions (one attachment, their total, inline images, composed RFC-822 message, provider raw message, provider upload file, HTTP body). Graph carries one file up to 150 MB through its upload session, Gmail is bounded by its raw message, SMTP by the fallback ceiling, and no transport is bounded by another's number. Provider-measured refusals are decided before the durable intent is claimed, so they leave no uncertain intent and no provider operation. |
| **P07** — native Microsoft Graph adapters | **delivered — live mailbox NOT RUN** | `services/providers/microsoft/*`, `0107`–`0110`, the Graph mail/calendar/contacts suites | Complete mail path — folder discovery, message delta sync with a reconciling `410` rebuild, flags, body/attachments, delete, move/archive, spam/ham, snooze, bulk delete, mark-all-read, source headers, attachment ZIP, drafts, send, provider-side search, and the conversation engine fed from Graph — plus calendar read and calendar-event/contact writes behind the per-collection switch. `ruleForwarder.ts` reads and sends over the account's own transport. No live Outlook mailbox was used: **NOT RUN**. |
| **P08** — Gmail API mail adapter | **delivered — live mailbox NOT RUN** | `services/providers/google/gmail*.ts`, `0111`, the Gmail suites | Labels and collections, history-cursor ingest with a resumable baseline, body/attachments on demand, mutations through the journal, drafts and send over the seam. `Bcc:` is kept in the raw message because the API has no envelope field and documents delivery from the headers — the provider keeps it off delivered copies. Reachable only after an explicit cutover. **NOT RUN** live. |
| **P09** — Google Calendar/People and Microsoft calendar/contacts | **delivered — live provider NOT RUN** | `services/providers/google/googleCalendar*.ts`, `googlePeople*.ts`, `providerGoogleWrites.ts`, `providerCalendarWrites.ts`, `providerContactWrites.ts`, `routes/calendar.ts`, `routes/contacts.ts` | Discovery, per-collection switches, delta sync with rebuild-and-reconcile, recurrence and generated `VTIMEZONE`, and create/update/delete for both providers through the journal with the local resource id journalled and the provider's identity linked. Attendee notifications are the provider's own. A recurring series can be changed or cancelled for **one occurrence, this-and-following, or the whole series**, resolved against the provider's own instance listing. Write-back is enabled per collection from the **calendar sidebar or the address-book menu** — both surfaces are addressed by the collection id and labelled from the server's verdict. **NOT RUN** live. |
| **P10** — external CalDAV/CardDAV read-write, ICS/VCF/CSV import | **delivered — real-client acceptance NOT RUN** | `services/providers/davWriteBack.ts`, `caldavWriteBack.ts`, `carddavWriteBack.ts`, `externalCollectionLinks.ts`, the DAV write-back suites | A `PUT`/`DELETE` on an imported collection — from a DAV client **or from Inboxora's own calendar and contacts pages** — is forwarded to its source through the journal with the client's `If-Match`/`If-None-Match`, conflict protection, honest outcome classification, and a local projection only after the source confirms; create, update, delete, series and all three occurrence scopes are covered on both entry points, which now answer the same capability question. The link/backfill that makes the switch reachable for real collections is P02's evidence above. DAVx⁵/Thunderbird/macOS have not been used: **NOT RUN**. |
| **P11** — DAV server hardening | **delivered — real-client acceptance NOT RUN** | `routes/caldav.ts`, `routes/carddav.ts`, the DAV suites and the real-database round trip | Discovery, strong `If-Match`, per-collection visibility and mode, per-password ceiling, WebDAV `If`, `403 DAV:valid-sync-token` on an expired sync token, report dispatch on the XML root element (not a substring), time-range filtering through the real recurrence projection, and `DAV:error` bodies on refusals. One historical deviation (substring report dispatch) was found and **fixed with a case**; a REPORT with no recognisable root element now answers `400` where a substring search might have dispatched it, which is the stricter, intended direction. No real client has talked to the server: **NOT RUN**. |
| **P12** — account migration/cutover, required and recommended notices | **delivered — real mailbox cutover NOT RUN** | `services/providerMailCutover.ts`, `services/providerGoogleMailCutover.ts`, `routes/accounts.ts`, `services/accountNotices.ts`, `routes/integrations.ts`, `0110`/`0112` | Microsoft: `POST /api/accounts/:id/migrate` switches an existing account **in place** — same `email_accounts.id`, no second account, every local message/folder/draft/alias/conversation preserved, one atomic update, idempotent, no IMAP/SMTP fallback afterwards, `authorization_required`/`admin_configuration_required` recorded without changing the transport, a mismatch between the account and the connection refused by name, and the IMAP loops/health checks filtering on `mail_transport` so a native account cannot be reopened over IMAP. Google: `POST /api/accounts/:id/migrate` performs the **same in-place cutover** to `gmail_api` (`services/providerGoogleMailCutover.ts`) — same id, no second account, one atomic update, idempotent retry, `gmail.modify` required (a Calendar/People grant is refused with `authorization_required` and the account stays on IMAP/SMTP), identity mismatch refused by name, label discovery after the switch, and no IMAP/SMTP fallback afterwards; the API is a **recommendation**, IMAP/SMTP with an app password keeps working, the recommendation card's "Migrate to the Google API" action authorizes Gmail when needed and then migrates, *Ignore* is a session dismissal, "do not show again" is a durable per-user-per-account suppression in `account_notice_preferences`, the Microsoft requirement cannot be suppressed, and Calendar/People work independently of the mail transport. **A data-moving inventory/backfill/reconcile state machine is out of v4 scope by explicit design**: the cutover moves the transport, the data never moves (the state names exist in the type for forward compatibility, and no code path enters them). A real mailbox cutover is **NOT RUN**. |
| **P13** — hardening, E2E, release documentation | **delivered** | `docs/wiki/Release-notes-4.1.0.md`, `docs/CHANGELOG.md`, the wiki pages, nine locales, the browser gate, the DAV work under P11 | The release documentation, the wiki, the interface copy and the unsupported-operation notes are written, and the browser and database gates exist on `dev`. The two items that are **not** release criteria are moved to *Deferred post-4.1 improvements*: per-request metrics/correlation ids (§25.2) and the §25.1 performance comparison. |
| **P14** — final integration, CI, image publication | **delivered** | workflow run [`35471043131`](https://github.com/Dragonk/Inboxora/actions/runs/35471043131); the P14 evidence below | All three parts are done: the images were built from the frozen SHA and verified in the registry with both architectures, and the published pair was started from a fresh volume and smoked. **Stable release to `main` is NOT YET PERFORMED** — that is a release decision, not a P14 implementation step. |
| **P15** — push-assisted synchronisation | **delivered — live provider NOT RUN** | `services/providerPushSubscriptions.ts`, `services/providerSyncHints.ts`, `services/providerSyncHintWorker.ts`, `services/providerPushMicrosoft.ts`, `services/providerPushGoogle.ts`, `services/providerPushScheduler.ts`, `routes/providerWebhooks.ts`, `0113` | One subscription model for Graph change notifications (messages, events, personal contacts), the Gmail `watch` over Cloud Pub/Sub and Google Calendar channels, with the validation secret stored only as a hash and one live row per scope. A notification never carries state: it records a coalescing **sync hint** (one row per connection/resource/collection, a burst collapses, a notification arriving during a sync is queued) that runs the **existing** delta/history/sync-token sync, so cursors, conversations, rules and notifications are untouched. Lifecycle events are handled as what they are (`missed` → a normal delta sync, `subscriptionRemoved` → recreate, `reauthorizationRequired` → renew or leave the account actionable), renewals run ahead of expiry with jitter and backoff and never for a switched-off provider, and disconnect/delete/calendar-removal stop the provider subscription and always tombstone it locally. Polling is unchanged and remains the safety net; **Google Contacts stays polling-only** because the People API has no push for the synced resources. Live provider push is **NOT RUN**. |

### P14 evidence

**Frozen code SHA: `af97ee5a1ddb6bd1ff0470ee6c8eebb1d577e334`** — the revision that fixes the 4.0.4 → 4.1.0 upgrade path (0108/0114) and
separates provider configuration (Integrations) from mailbox connection (Accounts). Commits after it are
documentation only.
ids on databases from an earlier `:dev` where the first 0108 revision had already created the index. Commits
after it are documentation only.
documentation only.
after it are documentation only.
documentation only.
it are documentation only.

| Part | State | Evidence |
| --- | --- | --- |
| image build + registry verification | **done** | Workflow run [`35515549348`](https://github.com/Dragonk/Inboxora/actions/runs/35515549348) built from `source_sha=af97ee5a1ddb6bd1ff0470ee6c8eebb1d577e334` and pushed `:dev`. Both resolve to OCI image indexes carrying `linux/amd64` **and** `linux/arm64`: backend `sha256:415c0c7e10778c574f91c21a4b43711795faf883bfd904086948d6c5d777a6ff`, frontend `sha256:eb9668376c5557fe724aab6ba917c5cc969f8a017b1f5a1ac8f339f8ee1f5cdf`. |
| runtime smoke | **RUN — passed** | The published pair was pulled and started from a fresh volume: `/api/health` → `{"status":"ok"}`, `/api/version` → `{"version":"dev","sha":"af97ee5a1ddb6bd1ff0470ee6c8eebb1d577e334"}`, **117** migrations, first-user registration, a fresh login, `/api/auth/me`, the account list, the UI root and **0 restarts**. Earlier revisions of this document record the upgrade smokes from a 4.0.4-shaped database and from an earlier-`:dev` database. |
| `:dev` publication | **done** | The published images are the current `dev` code, including the audit's two fixes; `main` is untouched and 4.1.0 is not released. |

## Acceptance criteria W01–W19

The plan required its acceptance items to be reported one by one, with code **and** real test results, and
explicitly forbade calling the implementation accepted on code alone. The verdicts below are derived from the
package rows above; the evidence for each is the package it names, and anything that needs a real provider,
device or client is **NOT RUN** rather than PASS.

| W | Requirement (abbreviated) | Verdict |
| --- | --- | --- |
| W01 | Menu follows the finger; the gesture starts in the left quarter | **PASS in code — real device NOT RUN** (P05) |
| W02 | Gesture switch beside the mobile panel setting, persisted | **PASS** (P05) |
| W03 | Scroll, row action, long-press, calendar and menu do not run competing operations | **PASS in code — real device NOT RUN** (P05) |
| W04 | External calendars/books work in the UI and over DAV as RO/RW per real rights, and **the write reaches the source** | **PASS**: imported collections work in the interface and over DAV; a write reaches the source once write-back is enabled per collection, including from a DAV client; ICS stays read-only by nature (P10, P02) |
| W05 | DAV sharing independent of UI use; off / RO / RW limited by the source's rights | **PASS** (P11) |
| W06 | Microsoft: full mail over Graph plus that account's calendars and contacts | **PASS** (P07; search and the reply/forward trace included, rule forwarder included) |
| W07 | Google: Gmail/Calendar/People recommended, free choice of transport, one transport after cutover | **PASS**: the Gmail API, Calendar and People are delivered, the API is a recommendation rather than a requirement, an app password keeps working, an existing account can be migrated **in place** from the recommendation card, and after that cutover one transport is authoritative (P08, P09, P12) |
| W08 | Independent calendar and contact switches per account, with collection discovery | **PASS** (P09, P12) |
| W09 | Do not remove configuration or force migration of other IMAP/SMTP, DAV or ICS accounts | **PASS** (P09, P12) |
| W10 | Keep the account and its links; Microsoft migrates with sufficient consent, Google only on explicit choice | **PASS**: both cutovers keep the same account row and all local data, with no automatic migration and no fallback; the Google one runs only when the user asks for it from the recommendation card or the API (P12) |
| W11 | Microsoft: required notice per entry, never permanently hidden. Google: recommendation until migration or "do not show again", with *Ignore* | **PASS**: the Microsoft requirement has no dismissal by design; the Google recommendation has *Ignore* (session) and a durable per-user-per-mailbox suppression, shown in the accounts settings (P12) |
| W12 | Large attachments, whole-message limit, MIME errors, forbidden files and interrupted sends handled explicitly | **PASS**: transport-aware dimensions with coded refusals decided before the intent is claimed, and a durable intent whose uncertain outcome is parked rather than retried (P06) |
| W13 | Keep threads, rules, plugins, notifications, search, aliases and invitations, or name the unsupported provider operation | **PASS**: nothing is removed, and the unsupported operations are named per provider in the wiki (P07–P13) |
| W14 | Integration to `dev`, push, tests, **both `:dev` images from one SHA** | **PASS**: both images were built from the frozen SHA and verified with both architectures, and the published pair passed the runtime smoke (P14) |
| W15 | No leakage between users, grants, accounts and DAV passwords; no silent data loss | **PASS in code and integration tests** — no independent audit was performed (P01, P11, P12) |
| W16 | The "email providers" screen: instructions, configuration and per-method diagnostics | **PASS** (P04, P12) |
| W17 | Microsoft web and device code have separate requirements and refresh; no Google device flow for these scopes | **PASS** (P04) |
| W18 | Google IMAP works without an OAuth project; attaching Calendar/People does not migrate mail or request Gmail scopes | **PASS** (P09, P12) |
| W19 | Complete admin instructions, updated documentation and translations, and tests of all variants as the publication gate | **PASS for the documentation, nine locales and the suites; the live provider configurations and the real-client runs are NOT RUN** (P13, and the manual-acceptance list below) |

## Manual acceptance not run

These need a real provider, device or client. They are **NOT RUN**, not failures, and nothing here claims
otherwise:

- **live Microsoft** — authorization (browser and device code), Graph mail, calendars, contacts, send and
  provider-side search against a real mailbox;
- **live Google** — OAuth, the Gmail API, Calendar and People;
- **a real mailbox cutover** from IMAP/SMTP to Graph or the Gmail API;
- **DAV clients** — DAVx⁵, Thunderbird and macOS Contacts/Calendar, including write-back;
- **the browser/screenshot revision** on a runner, and the **CI jobs on a GitHub runner** (the commands
  were run by hand against a real PostgreSQL);
- **a real touch device** for the drawer gesture.

## Settings separation

Integrations configure provider applications; Accounts connect individual mailboxes. Settings → Accounts →
**Add account** offers Microsoft, Google or IMAP/SMTP, creates a Microsoft or Google mailbox **natively** from
the provider authorization (identity from the provider, no IMAP credentials, discovery started), and answers an
already-added mailbox with the existing migration rather than a duplicate account. No account-adding action
remains in Integrations.

## Known limitations

Deliberate product limitations, not missing work:

- a provider collection is written **over the web interface** only; over DAV it stays read-only, because
  the DAV server forwards a write only to an external CalDAV/CardDAV source;
- an external **ICS subscription** is read-only at the source and can never be written back;
- **push requires a reachable public HTTPS endpoint** (`APP_URL`/`PROVIDER_PUSH_ENABLED`, and a Pub/Sub
  topic for Gmail); without it synchronisation is polling-only, which is the default and a supported state;
- **Google Contacts is polling-only** — the People API has no push channel for the synced resources, so its
  sync token and the schedule remain the mechanism (documented, not faked);
- **Google personal contacts only**, no shared directory, and no remote creation/sharing of collections;
- a **legacy external CalDAV/CardDAV collection** gains its write-back link on the next sync pass of its
  source, not by a one-shot migration;
- **invitations on a CalDAV collection are Inboxora's**: a plain CalDAV server is not a scheduling service, so
  an event with attendees created there is mailed by Inboxora rather than by the source.

## Deferred post-4.1 improvements

Not release criteria; recorded so they are not lost:

- per-request **metrics and correlation ids** (§25.2) — the provider journal has an opaque operation id,
  but the logs carry no correlation id, operation id or provider request id;
- the **§25.1 performance comparison**;
- a **producer for the domain outbox** (`services/domainOutbox.ts`), which is implemented but unconsumed;
- moving the remaining IMAP flag path onto the journal's pool instead of the in-memory reconciler;

## Verification performed

Measured on the frozen code SHA with each gate's own exit status read directly:

- **Backend** — typecheck clean, lint clean, **2959 unit tests passed** (209 skipped; 245 files).
- **Frontend** — typecheck clean, lint clean, **2782 tests passed** (0 failed), production build clean.
- **Database** — a database created empty for the purpose, the **whole 115-migration chain applied from
  zero** by the application's own runner, then **409 integration tests across 45 suites** on PostgreSQL 16
  (exit 0), including the send-ledger and external-collection-link suites. The unit and integration
  figures are separate invocations on purpose: one process running both against one database lets
  independent integration files contend on the same conversation tables, where a `SERIALIZABLE` rebuild can
  fail — a harness property, and why CI has two jobs.
- **Upgrade from 4.0.4** — a dedicated database built to the historical state with the production migration
  runner (`runMigrations({ upTo: '0107' })`), seeded with the real shape of a legacy Gmail IMAP mailbox (one
  X-GM-MSGID in four label folders, a second duplicated twice, a third once, a non-Gmail account with no
  provider id, plus a rule, a snooze, a folder and Conversation Engine identity), then upgraded by running
  the production runner again with no limit. **9 assertions passed**: the reproduction is real (7 rows, 3
  distinct provider ids), 0108 and everything after it are recorded, every `messages.id`, `uid`, `folder`,
  `thread_key`, `provider_thread_id` and Conversation Engine row is unchanged, the legacy provider ids are
  cleared, a duplicate native identity is still refused with `23505`, a database whose first 0108 attempt
  stopped after adding the column recovers, a database that recorded the earlier 0108 checksum still boots,
  and a second run changes nothing. It also covers the earlier-`:dev` state — the old `0108` checksum
  recorded, the index present, no `0114` record and a legacy X-GM-MSGID on an IMAP account — where it first
  **demonstrates** that an IMAP copy fails with `23505` on `messages_provider_identity_key`, then runs the
  migrations, asserts every legacy id is cleared, and performs the same copy successfully while the message
  keeps its `provider_thread_id` and the index still enforces native uniqueness. CI runs the gate as its own
  step against its own database.
  **Upgrade from 4.0.4 databases containing legacy Gmail IMAP folder copies is covered by an integration
  test.**

## Historical / superseded implementation notes

This document used to carry ~1900 lines of round-by-round audit trail: failed approaches, superseded
verdicts, four-attempt sagas and long diagnostics. It was **removed from the working tree** in the final
audit because it had begun to contradict the table above (rows still read `FAIL` or "remaining" for work
that had shipped, and test counts from earlier revisions were presented as current), and because the
release documentation — `docs/CHANGELOG.md` and `docs/wiki/Release-notes-4.1.0.md` — is the only release
documentation this project keeps. The trail remains in the git history of this file
(`git log -p -- docs/IMPLEMENTATION-STATUS.md`) for anyone who wants the reasoning; nothing in it is a
statement about the current code.

Three decisions from it are worth keeping because they are not obvious from the code alone:

1. **One composition, one artefact.** The send path composes the message once, measures that artefact, and
   strips the `Bcc:` header where it is composed — the accounting counts what would actually be sent.
2. **A refusal must not look like a lost response.** Every provider-measured refusal is decided before the
   durable intent is claimed; only an answer that could have happened after the request left is parked.
3. **The DAV report dispatcher reads the XML root element**, not a substring of the body. It is stricter
   than the code it replaced: a REPORT with no recognisable root element answers `400`.
