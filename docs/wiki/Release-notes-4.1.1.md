# Release notes 4.1.1

**Status:** Hotfix  ·  **Release date:** 2026-09-25  ·  **Previous version:** 4.1.0

## Fixed

- **Threaded mail list visibility.** Messages with empty `thread_key` now use `thread_id`, then a unique physical-message identity. Independent messages are no longer grouped into one nullable bucket or omitted. Pagination, totals, deduplication and thread expansion share the same identity rules.
- **Microsoft Graph immutable message IDs.** Body, headers, attachment metadata, inline images, single downloads, ZIP downloads and mail mutations consistently use `Prefer: IdType="ImmutableId"` whenever the connection has immutable IDs enabled.

## Validation and upgrade

No new database migration is required. Apply the existing migration chain normally. The release includes a real PostgreSQL regression for three independent messages with null thread identifiers and Graph regression coverage for immutable-ID reads and mutations.

Before publishing, validate on the `dev` deployment that threaded and flat views, refreshes and folder changes retain messages, and that old and new Microsoft messages open their bodies and support regular, inline-CID, single and ZIP attachment downloads. Do not publish if any of these live checks fail.
