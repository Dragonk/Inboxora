# Inboxora 4.3.2

Released **2026-10-08**.

[Downloads](https://github.com/Dragonk/Inboxora/releases/tag/v4.3.2) ·
[Changelog](https://github.com/Dragonk/Inboxora/blob/v4.3.2/docs/CHANGELOG.md) ·
[Upgrading](Upgrading.md#upgrading-to-432)

Inboxora 4.3.2 is a maintenance release addressing conversation ingest retry queue bloat and
clarifying storage maintenance reporting metrics (#16).

## Fixed

- **Conversation ingest failure deduplication and retry backoff (#16).** Active ingest failure
  records are now deduplicated per user, message row and operation rather than inserting duplicate
  unresolved records on every repeated failure. Unresolved retries now apply exponential backoff
  (capping at 24 hours), avoiding rapid spin cycles on persistent errors.
- **Automatic failure resolution upon success (#16).** Successful ingest and retry operations now
  automatically resolve all historical active failure records for the affected message.
- **Dead retry pruning (#16).** The operational maintenance cleaner now prunes exhausted ingest
  failures with 50 or more attempts that exceed the operational history retention window.

## Changed

- **Storage maintenance metrics reporting (#16).** Clarified database size change metrics in
  `storageMaintenanceStatus.ts` and maintenance status reporting:
  - `database_delta_bytes` explicitly reports database size change from baseline (`current - before`,
    positive indicates growth).
  - `database_delta_since_sweep_bytes` reports change since the initial header repair sweep completion.
  - The legacy `database_change_bytes` field is retained for backward compatibility.
  - Added relation size breakdown in `--summary` mode: `messages_heap_bytes`, `messages_index_bytes`,
    `messages_toast_bytes`, `ingest_failures_bytes`, and unresolved ingest failure count.

## Database migration

- `0169_deduplicate_conversation_ingest_failures.sql`
  - Required order: runs immediately after `0168_alias_default_recipients.sql`.
  - Applied automatically on backend application startup.
  - Resolves historical active failures for messages that are already successfully present in
    `conversations`.
  - Resolves duplicate open failure entries for the same message and operation, keeping the latest
    attempt.
  - Adds a partial index `idx_conversation_ingest_failures_unresolved_lookup` on `(user_id, message_row_id, operation)`
    where `resolved_at IS NULL` for fast deduplication lookups.

## Upgrade requirements

Back up PostgreSQL and `.env` as usual, then deploy matching **4.3.2** backend and frontend images.
Migration 0169 runs automatically on startup. No provider re-consent is needed and there are no new
required configuration keys.

Use one of the immutable stable image tags:

- `ghcr.io/dragonk/inboxora-backend:4.3.2`
- `ghcr.io/dragonk/inboxora-frontend:4.3.2`

`v4.3.2` and `latest` point to the same multi-architecture AMD64/ARM64 manifests after release
publication. Android 4.3.2 uses `versionCode 4030200`. Windows, Linux and Android artifacts are
attached to the GitHub release after the signed native build completes.
