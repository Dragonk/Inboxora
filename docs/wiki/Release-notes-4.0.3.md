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

- The old Message-ID relocation is gone, but rows it already collapsed across folders stay missing. The first successful sync tick now runs a one-time forced metadata pass over every selectable folder (ignoring `uid_next`), restoring those copies from IMAP without wiping the local database. Idempotent, bounded, non-fatal.

## Antispam v0.2 (hybrid rules + per-user Naive Bayes)

- Deterministic 14-rule engine always on (pharma/money keywords, CTA phrases, URL shorteners, reply-to mismatch, executable/double-extension attachments, DKIM/SPF/DMARC fail only from a trusted authserv-id, mailing-list and known-contact ham signals). Multinomial Naive Bayes joins at >= 50 training records with Laplace smoothing; blending is rules-only below 50, 60/40 up to 500, 20/80 above.
- Training is DB-only: `/spam` and `/ham` persist token counts, flag features, sender domain and attachment types at mark time (retrain never JOINs back to messages); feedback updates the model incrementally in <1s. A staggered hourly single-flight scheduler rebuilds models with exponential time decay; overlapping runs are refused, each user is time-boxed.
- Live ingest tagging is fire-and-forget with `deferAutoMove` on the backfill path (no per-message IMAP storm); auto-move requires verdict spam, score >= 0.95, ML backing and a configured spam folder. User override always wins; auto-verdicts never train the model. `GET /api/spam/explain` powers the "Why?" dialog; thresholds live in `users.preferences.spam_thresholds`.
- Defaults are safe: master switch on, per-account `antispam_enabled` off (opt-in). Migration `0095_spam_classifier_v2.sql` must be applied before rollout.
- Frontend: `SpamBadge` verdict chip + explain dialog, `SpamSettings` status/master-switch/retrain panel, locale keys in all 9 locales.

## Folder freshness and STATUS

- After each LIST, cached non-INBOX folders are revalidated with a lightweight STATUS check. A folder whose server UIDNEXT, message count, and unseen count all match the cache is skipped on reopen; folders with an advanced UIDNEXT are queued for a metadata sync. New `folders.uid_next` column; migration `0094_folder_uidnext_status.sql` must be applied before rollout.
- Fix STATUS gate self-cancellation: `uid_next` now represents the watermark of the last completed sync, not the last observed STATUS. Detecting a change no longer writes the new value to the DB before the fetch runs (which previously caused `_folderNeedsSync` to see matching values and skip the sync).

## Frontend hardening

- A React Error Boundary wraps the router at the entrypoint; a render-time exception now shows a translated recovery screen with a reload action instead of a blank page.
- The WebSocket wake effect handles `pageshow` for BFCache (`event.persisted`) by reusing the existing refresh-and-reconnect path.
- Attachments classified as potentially dangerous (common executable, script and shortcut extensions and matching media types) trigger a confirmation dialog before download; the Download-all ZIP path cannot bypass the prompt. Downloads are never blocked outright.

## Verification

- Backend: 1911 tests passing, `tsc --noEmit` clean, `eslint src --max-warnings 0` clean, migration integrity suite clean. Focused regression suites cover physical-copy identity, explicit IDLE (attempted vs entered + single-flight), STATUS no-self-cancel, one-time post-relocate repair, and the full spam stack (tokenizer/rules/Bayes/store/pipeline/scheduler).
- Frontend: production build passes, spam contract + i18n parity green, plus Error Boundary contract, BFCache wake contract, and dangerous-attachment classifier.

See [`docs/CHANGELOG.md`](../CHANGELOG.md) for the concise release record.
