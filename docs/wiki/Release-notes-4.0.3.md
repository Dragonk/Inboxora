# Release notes 4.0.3

**Status:** in development on `dev` — not released · **Previous version:** 4.0.2 · **Type:** patch

> **Release status:** These notes describe the planned 4.0.3 release. Do not treat `dev` images as a production release or pin `4.0.3` until the release tag and published images are announced.

## What this release fixes

4.0.3 adapts the upstream MailFlow 3.4-3.5 reliability fixes that still applied to Inboxora's `dev`: physical-copy identity, explicit IMAP IDLE, STATUS-gated folder refresh, plus frontend hardening (Error Boundary, BFCache wake reuse, dangerous-attachment download warning). Apply the included migration before deploying; no configuration change is required.

## Physical-copy identity

- Physical messages are now identified by `(account, uid, folder)`; an RFC Message-ID match no longer relocates one physical copy onto another. Self-sent Gmail and mailing-list copies that share a Message-ID persist as separate rows and are grouped only at the Conversation Engine layer.

## IMAP IDLE

- Persistent sync connections enter IDLE explicitly after each sync tick instead of relying on ImapFlow's delayed auto-IDLE, which never started at the supported 15-second interval. A connected account that supports IDLE but never started it is now logged as a health signal.

## Folder freshness and STATUS

- After each LIST, cached non-INBOX folders are revalidated with a lightweight STATUS check. A folder whose server UIDNEXT, message count, and unseen count all match the cache is skipped on reopen; folders with an advanced UIDNEXT are queued for a metadata sync. New `folders.uid_next` column; migration `0094_folder_uidnext_status.sql` must be applied before rollout.

## Frontend hardening

- A React Error Boundary wraps the router at the entrypoint; a render-time exception now shows a translated recovery screen with a reload action instead of a blank page.
- The WebSocket wake effect handles `pageshow` for BFCache (`event.persisted`) by reusing the existing refresh-and-reconnect path.
- Attachments classified as potentially dangerous (common executable, script and shortcut extensions and matching media types) trigger a confirmation dialog before download; the Download-all ZIP path cannot bypass the prompt. Downloads are never blocked outright.

## Verification

- Backend: 1862 tests passing, `tsc --noEmit` clean, `eslint src --max-warnings 0` clean, migration integrity suite clean. Focused regression suites cover physical-copy identity, explicit IDLE, STATUS-gated folder refresh, and coalesced on-demand sync.
- Frontend: production build passes, 1712 tests passing including i18n parity, Error Boundary contract, BFCache wake contract, and dangerous-attachment classifier.

See [`docs/CHANGELOG.md`](../CHANGELOG.md) for the concise release record.
