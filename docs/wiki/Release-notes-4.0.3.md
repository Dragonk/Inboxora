# Release notes 4.0.3

**Status:** in development on `dev` — not released · **Previous version:** 4.0.2 · **Type:** patch

> **Release status:** These notes describe the planned 4.0.3 release. Do not treat `dev` images as a production release or pin `4.0.3` until the release tag and published images are announced.

## What this release fixes

4.0.3 adapts the upstream MailFlow 3.4-3.5 reliability fixes that still applied to Inboxora's `dev`: physical-copy identity, explicit IMAP IDLE, STATUS-gated folder refresh, plus frontend hardening (Error Boundary, BFCache wake reuse, dangerous-attachment download warning). It also ships the missing antispam v0.2 layer (hybrid rules + per-user Naive Bayes, hardened against connection storms) and a one-time repair pass for databases that ran the old Message-ID relocation. Apply the included migrations before deploying; antispam auto-move is opt-in per account.

## Physical-copy identity

- Physical messages are now identified by `(account, uid, folder)`; an RFC Message-ID match no longer relocates one physical copy onto another. Self-sent Gmail and mailing-list copies that share a Message-ID persist as separate rows and are grouped only at the Conversation Engine layer.

## IMAP IDLE

- Persistent sync connections enter IDLE explicitly after each sync tick instead of relying on ImapFlow's delayed auto-IDLE, which never started at the supported 15-second interval. Health now distinguishes `idleAttemptedAt` (we called `idle()`) from `idleEnteredAt` (the server acknowledged IDLE), and concurrent `_enterExplicitIdle` calls share one in-flight promise per account instead of issuing duplicate IDLE commands.

## Post-relocate repair

- The old Message-ID relocation is gone, but rows it already collapsed across folders stay missing — including old UIDs far below the recent sync window. Repair is now a backfill-style SEARCH ALL → UID diff → fetch-only-missing pass per selectable folder (metadata-only), per account, with a durable per-account marker written only after all folders succeed so failed runs retry. The first successful sync tick per account triggers it once, fire-and-forget.

## Antispam v0.2 (hybrid rules + per-user Naive Bayes)

- Deterministic 14-rule engine always on (pharma/money keywords, CTA phrases, URL shorteners, reply-to mismatch, executable/double-extension attachments, DKIM/SPF/DMARC fail only from a trusted authserv-id, mailing-list and known-contact ham signals — contacts limited to `is_auto = false` plus own addresses so inbound spam cannot whitelist itself). Multinomial Naive Bayes joins at the configured `minRecords`, blending 60/40 to `softRecords` then 20/80; verdict/auto-move use the configured `spamThreshold`/`autoMoveThreshold`.
- Training is DB-only and atomic: `/spam` and `/ham` compute features from the already-loaded row and INSERT one complete training row (no `UPDATE...ORDER BY...LIMIT`, which PostgreSQL rejects); the already-in-folder path trains too. Incremental updates and full retrains serialize per user; the hourly scheduler staggers by `hash(user_id) % 24`, refuses overlap (409), and awaits slow users instead of interleaving.
- Live ingest tagging is fire-and-forget with `deferAutoMove` on the backfill path (no per-message IMAP storm); auto-move resolves the full account row, shares one in-flight MOVE per physical copy, keeps folder badges in step, and broadcasts `folder_updated`. User override always wins; auto-verdicts never train the model.
- `GET /api/spam/explain` answers from stored `spam_details` (recompute only for legacy rows); thresholds live in `users.preferences.spam_thresholds` and actually drive the pipeline.
- Defaults are safe: master switch on, per-account `antispam_enabled` off (opt-in via `PUT /api/accounts/:id` and the account form, alongside `trusted_authserv_id`). Migration `0095_spam_classifier_v2.sql` must be applied before rollout.
- Frontend: `SpamBadge` verdict chip + explain dialog (mounted in `MessageDetailContent`), `SpamSettings` status/master-switch/retrain panel, per-account antispam toggle in the account form, locale keys in all 9 locales.

## Folder freshness and STATUS

- After each LIST, cached non-INBOX folders are revalidated with a lightweight STATUS check. A folder whose server UIDNEXT, message count, and unseen count all match the cache is skipped on reopen; folders with an advanced UIDNEXT are queued for a metadata sync. New `folders.uid_next` column; migration `0094_folder_uidnext_status.sql` must be applied before rollout.
- Fix STATUS gate self-cancellation: `uid_next` now represents the watermark of the last completed sync, not the last observed STATUS. Detecting a change no longer writes the new value to the DB before the fetch runs (which previously caused `_folderNeedsSync` to see matching values and skip the sync).

## Frontend hardening

- A React Error Boundary wraps the router at the entrypoint; a render-time exception now shows a translated recovery screen with a reload action instead of a blank page.
- The WebSocket wake effect handles `pageshow` for BFCache (`event.persisted`) by reusing the existing refresh-and-reconnect path.
- Attachments classified as potentially dangerous (common executable, script and shortcut extensions and matching media types) trigger a confirmation dialog before download; the Download-all ZIP path cannot bypass the prompt. Downloads are never blocked outright.

## Verification

- Backend: 1925 tests passing, `tsc --noEmit` clean, `eslint src --max-warnings 0` clean, migration integrity suite clean (0094 + 0095). Focused regression suites cover physical-copy identity, explicit IDLE (attempted vs entered + single-flight + reject path), STATUS no-self-cancel, SEARCH-ALL-diff repair with durable marker, and the full spam stack (tokenizer/rules/Bayes/store/pipeline/scheduler plus HTTP route tests for atomic training, per-account enable and explain-from-stored).
- Frontend: production build passes, spam contract + i18n parity green (1717), plus Error Boundary contract, BFCache wake contract, and dangerous-attachment classifier.

See [`docs/CHANGELOG.md`](../CHANGELOG.md) for the concise release record.
