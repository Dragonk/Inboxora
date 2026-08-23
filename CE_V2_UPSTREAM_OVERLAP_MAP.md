# CE v2 — Upstream 3.2.4 Overlap Map

**Date**: 2026-08-23
**UPSTREAM_HEAD**: c1e53df6667bbff8f273186d462a8281c759594c (MailFlow 3.2.4)
**FORK_HEAD**: f4dd4d7b285a37e38d0bcb7cd84c514627252d14
**MERGE-BASE**: 293439969c076a36636144896d1c037f524e9994
**ahead/behind**: 124 ahead / 43 behind

## Summary

- 113 files changed (5654 insertions, 273 deletions)
- 0 deleted files
- 29 modified files, 84+ new files
- Upstream highest migration: 0050_message_sender.sql
- Our CE v2 migrations: 0047-0053 (CONFLICT — need renumber to 0051-0057)
- 0002_subject_threading.sql: byte-identical (SHA 973d8533345fc8214d41e49ab1b4d6dd5f7fa8af) ✅

## UPSTREAM FEATURE → CE v2 overlap map

Legend: USE = use upstream as-is | ADAPT = merge both | SUPERSEDED = CE v2 replaces | CONFLICT = semantic resolution needed

### Threading / Conversations

| Upstream feature | Commit | Overlap | Decision |
|---|---|---|---|
| `computeThreadId()` (imapManager:967) — RFC 5322 References + subject fallback (90d window) | pre-merge-base | CE v2 has conversationEngine with logical_message_id | **ADAPT** — keep upstream computeThreadId for legacy CE-disabled mode; CE v2 uses its own decision engine and MUST NOT use subject-only fallback in active CE path |
| Subject-only fallback in computeThreadId (normalized_subject, 90 days) | 0002 migration | CE v2 forbids subject-only grouping (rule 3) | **SUPERSEDED** in CE-active path; keep ONLY in legacy CE-disabled compatibility path |
| `thread_key` / `thread_id` columns + GTD plugin integration | 0002, 0006, 0007, 0009 | CE v2 has conversation_id, logical_message_id | **ADAPT** — legacy thread_id remains for CE-disabled mode + GTD plugin compat; CE v2 is source of truth when active |
| Thread Sent copies into conversation (0272604) | 0272604 | CE v2 logicalMessageIdentity handles Sent/Inbox copies | **USE** upstream + **ADAPT** — CE v2 must wire Sent copy to same LogicalMessage via canonical Message-ID |
| `threadedArchive.js` (findVisibleArchiveMessage, archiveViewKey) | pre-merge-base | CE v2 has copy-aware scopes (selected-copy / all-copies / whole-conversation) | **ADAPT** — upstream whole-thread archive stays for legacy mode; CE mode needs explicit scope API |
| Stabilize threaded inbox triage (8698a7f, bd57b3a, 92b0417) | 3.1.x | CE v2 ConversationList has different UX model | **ADAPT** — preserve upstream UX for CE-disabled; CE list is separate component |
| Polish thread count pill + mobile thread-row highlight (92b0417) | 3.1.x | CE v2 ConversationList rows | **ADAPT** — upstream improvements to ThreadRow stay for legacy; CE ConversationList has own styling |

### IMAP / Ingest

| Upstream feature | Commit | Overlap | Decision |
|---|---|---|---|
| `imapManager.js` 5393 lines (connection gate, IPv4 fallback, IDLE, pool) | 3.1.x | Our branch modifies imapManager (CE ingest hooks) | **CONFLICT** — semantic merge: keep ALL upstream IMAP reliability fixes, add CE ingest hooks |
| Per-host connection-admission gate (54abff2, #384) | 3.1.1 | None — additive | **USE** upstream |
| IPv4 fallback for IPv6 TLS (8effb9f, #382) | 3.1.0 | None — additive | **USE** upstream |
| Snippet indexer loop fix (8ead2f8, #379) + snippet_attempted_at (0048) | 3.1.4 | CE v2 uses snippet model for ConversationList | **USE** upstream + **ADAPT** — CE v2 respects snippet_attempted_at (no body fetch on expand) |
| Dedupe message list by Message-ID on raw loads (a5d239c, #378) | 3.1.3 | CE v2 has identity priority (logical_message_id > provider ID > canonical Message-ID > physical DB id) | **ADAPT** — upstream render-time dedupe stays as fallback; CE v2 identity resolution is primary |
| Folder non-selectable (\Noselect, 0047, ef5c7ff) | 3.1.2 | Our AdminPanel.jsx REMOVED the no_select filter — REGRESSION | **CONFLICT** — MUST restore upstream `!f.no_select` filter |
| Async folder empty (1568d53) | 3.2.4 | None — additive | **USE** upstream |

### Relocate / Move / Archive

| Upstream feature | Commit | Overlap | Decision |
|---|---|---|---|
| RELOCATE_COPY_COLS (38 cols) in mail.js | pre-merge-base | CE v2 needs new columns preserved on relocate | **CONFLICT** — MUST extend RELOCATE_COPY_COLS with CE columns: logical_message_id, conversation_id, conversation_user_id, canonical_message_id, provider_message_id, provider_thread_id, threading_reason, threading_confidence, raw threading metadata |
| Preserve delivery/sender/plugin metadata on relocate (01c7ea5) | 3.2.4 | CE v2 regression coverage requirement (rule 5) | **USE** upstream + **EXTEND** — add CE v2 metadata to the preservation list + test |
| Whole-thread archive/move/delete behavior | 3.1.x | CE v2 needs explicit scopes (rule 18) | **ADAPT** — legacy mode keeps upstream behavior; CE mode requires explicit scope API + UI confirmation |
| Cascade folder renames + prune ghost folders (1645912, #303) | 3.2.x | None — additive | **USE** upstream |
| Batch whole-folder deletes + mark-all-read (75f0fe2) | 3.2.3 | CE v2 copy-aware | **ADAPT** — upstream batching stays; CE mode scopes to logical copies |
| Trash exactly bulk messages counted (ed58a39) | 3.2.3 | None — additive | **USE** upstream |

### Send / Reply

| Upstream feature | Commit | Overlap | Decision |
|---|---|---|---|
| `send.js` Sent copy with References chain (461: "threads into its conversation") | pre-merge-base | CE v2 must wire Sent copy to same LogicalMessage | **ADAPT** — upstream Sent propagation stays; CE v2 adds logical_message_id assignment on upsertSentMessageRecord |
| `scheduleSentMetadataUpsert` + `upsertSentMessageRecord` + `appendToSent` | pre-merge-base | None — our branch does NOT modify send.js | **USE** upstream + **ADAPT** — CE ingest hook on upsert |
| Bound forwarded-attachment fan-out (e391970) | 3.2.4 | None — additive | **USE** upstream |
| `composeFromMessage.js` — references chain (our branch improved it) | our branch | CE v2 rule 11 (ordered + deduped References) | **USE ours** — our improvement is better (deduped, ordered, handles thread_references) |

### Sender / via metadata

| Upstream feature | Commit | Overlap | Decision |
|---|---|---|---|
| Sender "via" line for on-behalf-of (b0485cf, #366) | 3.2.0 | CE v2 must respect provider-specific metadata | **USE** upstream + **ADAPT** — CE v2 includes sender_email/sender_name in identity |
| 0050_message_sender.sql (sender_email, sender_name columns) | 3.2.4 | CE v2 metadata set | **USE** upstream — CE v2 references these columns |
| `message.via` i18n key | 3.2.0 | CE v2 PL must include it | **USE** upstream |

### MessagePane / MessageList

| Upstream feature | Commit | Overlap | Decision |
|---|---|---|---|
| MessagePane.jsx (3321 lines, sender card, remote images, sandbox) | 3.2.x | Our branch modified (3310 lines) | **CONFLICT** — semantic merge: keep ALL upstream MessagePane improvements, add CE reader hooks |
| MessageList.jsx (4661 lines, dedupe, thread rows) | 3.2.x | Our branch modified (4419 lines) | **CONFLICT** — semantic merge: keep upstream, add ConversationList integration |
| `ConversationList.jsx` + `ConversationPane.jsx` (our new components) | our branch | No upstream equivalent | **USE ours** — CE v2 components |

### i18n / Polish

| Upstream feature | Commit | Overlap | Decision |
|---|---|---|---|
| Official `pl.json` (1345 flatten keys, 1573 lines) | b92da95 (#380) | Our pl.json has 1343 keys (16 conversation.* + 1 todoist.betaLabel) | **CONFLICT** — upstream pl.json = baseline; add our CE keys; REMOVE our keys that duplicate upstream |
| Polish plural rules in i18n.js | b92da95 | Our branch modified i18n.js (no diff shown — possibly already compatible) | **USE** upstream + verify |
| Language selector + AI language mapping | 3.2.x | None — additive | **USE** upstream |
| `admin.cleanup.*` (12 keys) | f885188 | Our branch LACKS these | **USE** upstream — add to our pl.json |
| `admin.sso.loginMatchClaim*` (2 keys) | 4a7f16c | Our branch LACKS these | **USE** upstream |
| `contextMenu.copyLink` | 9c6dd76 | Our branch LACKS this | **USE** upstream |
| `message.via` | b0485cf | Our branch LACKS this | **USE** upstream |
| `sidebar.emptied`, `sidebar.emptying` | 1568d53 | Our branch LACKS these | **USE** upstream |
| Our `conversation.*` (17 keys) | our branch | No upstream equivalent | **USE ours** — extend to full CE v2 list (rule 7) |
| Our `messageList.bulk*_few/many` plurals | our branch | Upstream has `_one/_other` only? | **VERIFY** — may need reconcile |
| Our `admin.messageList.markReadDelaySeconds_*` | our branch | Upstream may have these now | **VERIFY** |

### Migrations

| Upstream feature | Commit | Overlap | Decision |
|---|---|---|---|
| 0047_folder_no_select.sql | 3.1.2 | Our 0047_conversation_engine_v2.sql | **CONFLICT** — renumber ours to 0051 |
| 0048_snippet_attempted_at.sql | 3.1.4 | Our 0048_conversation_engine_v2_operations.sql | **CONFLICT** — renumber ours to 0052 |
| 0049_oidc_login_match_claim.sql | 3.2.0 | Our 0049_conversation_engine_v2_evidence.sql | **CONFLICT** — renumber ours to 0053 |
| 0050_message_sender.sql | 3.2.4 | Our 0050_repair_legacy_subject_only_threading.sql | **CONFLICT** — renumber ours to 0054 |
| Our 0051-0053 | our branch | No upstream conflict after renumber | **RENUMBER** to 0055-0057 |
| 0002_subject_threading.sql | pre-merge-base | Same file | **VERIFIED** byte-identical ✅ |
| `migrations.js` — our rewrite adds SHA-256 hashes + integrity | our branch | Upstream has simpler version | **CONFLICT** — semantic merge: keep our integrity tracking, ensure upstream migration runner logic preserved |

### Preferences / Settings

| Upstream feature | Commit | Overlap | Decision |
|---|---|---|---|
| Cancel pending preference save on logout (bc0b5a1) | 3.2.4 | Our store/index.js REMOVED cancelPendingPrefSave — REGRESSION | **CONFLICT** — MUST restore upstream cancelPendingPrefSave |
| Resizable admin window (df060fb, #389) | 3.2.0 | None — additive | **USE** upstream |
| Settings nav overflow fix (1d8ac2a, #389) | 3.2.3 | None — additive | **USE** upstream |
| Graduate features from BETA (c63b3bf) | 3.2.0 | Our AdminPanel adds betaLabel to CardDAV — WRONG | **CONFLICT** — remove our erroneous todoist.betaLabel on CardDAV |
| Our `conversation_list_view_enabled` + `conversation_reader_view_enabled` (auth.js, store) | our branch | No upstream equivalent | **USE ours** — 2×2 preference matrix (rule 8) |

### Security

| Upstream feature | Commit | Overlap | Decision |
|---|---|---|---|
| UUID path param validation (1d2b0fc) | 3.2.4 | CE v2 security tests | **USE** upstream — reuse upstream uuidParam validation (rule 17) |
| Our `withTransaction` serializable + retries (db.js) | our branch | Upstream has simple withTransaction | **ADAPT** — keep our serializable+retries; ensure upstream db.js changes preserved |

### Cleanup / Other

| Upstream feature | Commit | Overlap | Decision |
|---|---|---|---|
| Mailbox Cleanup (f885188) | 3.2.0 | None — additive | **USE** upstream |
| OIDC configurable claim (4a7f16c, 0049) | 3.2.0 | None — additive | **USE** upstream |
| Copy link action (9c6dd76, #375) | 3.1.4 | None — additive | **USE** upstream |
| Spam folder periodic poll (a0dd6e0) | 3.2.0 | None — additive | **USE** upstream |
| Folder unread badge recompute (721064a) | 3.2.0 | None — additive | **USE** upstream |
| Decrement sidebar badge on read-on-open (1a0ee63) | 3.2.0 | None — additive | **USE** upstream |
| Cleanup refresh counts after run (631d534) | 3.2.3 | None — additive | **USE** upstream |

## Regression risks identified

1. **AdminPanel.jsx**: removed `!f.no_select` filter, removed MS OAuth status fetch, wrong todoist.betaLabel on CardDAV
2. **store/index.js**: removed `cancelPendingPrefSave`, `dedupeByIdentity`, `removeThreadCacheEntry`
3. **migrations.js**: complete rewrite — need to ensure upstream migration runner semantics preserved
4. **Migrations 0047-0053**: number collision with upstream 0047-0050

## Strategy

1. **Merge upstream/main into feat/threading-v2-final-completion** (not rebase — preserves our 124 commits)
2. Resolve conflicts semantically per the map above
3. Restore all upstream features our branch regressed
4. Renumber CE v2 migrations to 0051-0057
5. Extend RELOCATE_COPY_COLS with CE columns
6. Wire CE ingest hooks into upstream imapManager without losing reliability fixes
7. Use upstream pl.json as baseline, add CE keys
8. Keep upstream computeThreadId for legacy mode, CE v2 decision engine for active mode
