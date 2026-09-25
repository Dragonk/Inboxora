# Release notes 4.1.1

**Status:** Hotfix  ·  **Release date:** 2026-09-25  ·  **Previous version:** 4.1.0

## Fixed
- **Microsoft Graph rebuilt baselines no longer delete mail by omission.** Inboxora now removes a provider-backed message only when Graph delta explicitly reports an `@removed` event. Rebuilding an expired or reset delta cursor can no longer make a newly delivered or otherwise valid message disappear from the local mailbox.

- **Microsoft Graph push starts for existing mailboxes.** When provider push is enabled after an account was already connected, Inboxora now bootstraps the missing mail subscription automatically; the two-minute polling path remains the reliability fallback.
- **Microsoft Graph attachments load correctly.** Inboxora no longer requests `contentId` through an invalid base-attachment `$select`, so attachment metadata and inline CID images can be read without the Graph OData error.
- **Threaded mail list visibility.** Messages with empty `thread_key` now use `thread_id`, then a unique physical-message identity. Independent messages are no longer grouped into one nullable bucket or omitted. Pagination, totals, deduplication and thread expansion share the same identity rules.
- **Microsoft Graph immutable message IDs.** Body, headers, attachment metadata, inline images, single downloads, ZIP downloads and mail mutations consistently use `Prefer: IdType="ImmutableId"` whenever the connection has immutable IDs enabled.
- **Microsoft Graph historical mail delta sync after reconnect.** Delta sync requests now specify page sizes via `Prefer: odata.maxpagesize=200` rather than `$top` on `/messages/delta`, keeping opaque continuation links intact across full traversals. Reconnecting a previously revoked or inactive Microsoft connection clears mail delta cursors and checkpoints to guarantee a clean baseline import, while preserving state during routine token/consent refreshes on active connections.

## User and operator impact

- **New users and initial mailbox sync:** New Microsoft integrations traverse historical folder items completely using `Prefer: odata.maxpagesize=200` without hitting the premature delta round termination previously caused by `$top`.
- **Upgrading from 4.1.0:** Active connections continue synchronizing incrementally without losing state. If an existing Microsoft mailbox missed historical items during an earlier import, disconnecting and reconnecting the account now resets the mail delta state and triggers a full baseline import. Unthreaded messages without `thread_key` are immediately visible in threaded folder views.

## Validation and upgrade

The upgrade includes `0141_message_list_hot_path_indexes.sql` for the message-list hot path, `0142_graph_pending_message_removals.sql` for durable Microsoft Graph tombstone reconciliation, and `0143_repair_message_list_hot_path_index.sql` as the forward repair for installations that already recorded the first 0141 revision, and `0144_normalize_message_ids.sql` to normalize historical RFC Message-ID values.


Apply the complete migration chain through `0144_normalize_message_ids.sql` before rolling out 4.1.1. The normal backend startup migration runner applies pending migrations automatically. The release includes a real PostgreSQL regression for three independent messages with null thread identifiers, reconnect cursor reset, and Graph regression coverage for immutable-ID reads, mutations, and delta pagination.

Before publishing, validate on the `dev` deployment that threaded and flat views, refreshes and folder changes retain messages, and that old and new Microsoft messages open their bodies and support regular, inline-CID, single and ZIP attachment downloads. Do not publish if any of these live checks fail.
