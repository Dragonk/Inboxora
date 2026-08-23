# CE v2 — Integration Report (pre-review)

**Date**: 2026-08-23
**Branch**: `feat/threading-v2-final-completion`
**Repository**: Dragonk/mailflow (fork of maathimself/mailflow)

---

## SHAs

| | SHA |
|---|---|
| **UPSTREAM_HEAD** | `c1e53df6667bbff8f273186d462a8281c759594c` |
| **FINAL_HEAD** | `12002f48d4ba9efbcb339fda126ed132ffaa44cd` |
| **OLD merge-base** | `293439969c076a36636144896d1c037f524e9994` |
| **NEW merge-base** | `c1e53df6667bbff8f273186d462a8281c759594c` (= upstream HEAD) |
| **ahead/behind** | 128 ahead / **0 behind** |

## MailFlow version

**3.2.4** (both `backend/package.json` and `frontend/package.json`)

## Upstream commits/features absorbed from old base

43 commits absorbed (3.1.0 → 3.2.4). Key features:

| Feature | Commit | Status |
|---|---|---|
| Mailbox Cleanup | f885188 | ✅ absorbed |
| Sender "via" metadata + 0050_message_sender.sql | b0485cf | ✅ absorbed |
| Preserve delivery/sender/plugin metadata on relocate | 01c7ea5 | ✅ absorbed + **extended with CE columns** |
| UUID path param validation | 1d2b0fc | ✅ absorbed |
| Cancel pending preference save on logout | bc0b5a1 | ✅ absorbed (regression restored) |
| Async folder empty | 1568d53 | ✅ absorbed |
| Snippet indexer loop fix + snippet_attempted_at | 8ead2f8, 0048 | ✅ absorbed |
| Folder non-selectable (\Noselect) | ef5c7ff, 0047 | ✅ absorbed (regression restored) |
| Per-host connection-admission gate | 54abff2 | ✅ absorbed |
| IPv4 fallback for IPv6 TLS | 8effb9f | ✅ absorbed |
| Thread Sent copies into conversation | 0272604 | ✅ absorbed |
| Dedupe message list by Message-ID | a5d239c | ✅ absorbed |
| Copy link action | 9c6dd76 | ✅ absorbed |
| Official Polish localization | b92da95 | ✅ absorbed (as baseline) |
| Resizable admin window + nav fixes | df060fb, 1d8ac2a | ✅ absorbed |
| Spam folder periodic poll | a0dd6e0 | ✅ absorbed |
| Bounded forwarded-attachment fan-out | e391970 | ✅ absorbed |

## Map: old CE implementation → upstream overlap → final implementation

| CE v2 area | Upstream overlap | Final decision |
|---|---|---|
| `conversationEngine.js` (logical_message_id, conversation_id) | No upstream equivalent | **CE v2 is source of truth** |
| `computeThreadId` subject fallback (0002) | Upstream has subject fallback in computeThreadId (90d window) | **SUPERSEDED in CE-active path**; kept for legacy CE-disabled mode |
| `thread_key` / `thread_id` (GTD plugin) | Upstream uses thread_key in GTD | **ADAPT** — legacy thread_id stays for CE-disabled + GTD compat; CE v2 conversation_id is primary when active |
| `composeFromMessage.js` references chain | Upstream has simpler version | **USE ours** (deduped, ordered, handles thread_references) |
| `RELOCATE_COPY_COLS` | Upstream has 38 cols | **EXTENDED** with 12 CE columns |
| `db.js` withTransaction serializable+retries | Upstream has simple version | **USE ours** (serializable + retries for race safety) |
| `migrations.js` SHA-256 integrity | Upstream has simpler version | **USE ours** (integrity tracking preserved) |
| `store/index.js` cancelPendingPrefSave | Upstream added it (bc0b5a1), our branch had removed it | **USE upstream** (regression restored) |
| `AdminPanel.jsx` no_select filter | Upstream added it (ef5c7ff), our branch had removed it | **USE upstream** (regression restored) |
| `ConversationList.jsx` / `ConversationPane.jsx` | No upstream equivalent | **USE ours** (CE v2 components) |
| `pl.json` | Upstream has official pl.json (1345 keys) | **USE upstream as baseline** + 17 CE conversation.* keys |

## Migration map (new)

| Number | Name | Origin |
|---|---|---|
| 0001-0050 | (upstream unchanged) | upstream |
| **0051** | conversation_engine_v2 | CE v2 (was 0047) |
| **0052** | conversation_engine_v2_operations | CE v2 (was 0048) |
| **0053** | conversation_engine_v2_evidence | CE v2 (was 0049) |
| **0054** | repair_legacy_subject_only_threading | CE v2 (was 0050) |
| **0055** | conversation_tenant_constraints | CE v2 (was 0051) |
| **0056** | conversation_rebuild_audit | CE v2 (was 0052) |
| **0057** | conversation_automated_series | CE v2 (was 0053) |

### 0002 unchanged

**Confirmed**: `0002_subject_threading.sql` SHA = `973d8533345fc8214d41e49ab1b4d6dd5f7fa8af` — byte-identical with upstream ✅

## i18n

- **Official upstream PL baseline**: 1345 flatten keys
- **CE PL additions**: 17 `conversation.*` keys (bodyLabel, collapse, expand, forward, label, latestOwnReply, listLabel, loadFailed, loadMore, loading, lock, messageCount, messagesLabel, noSubject, reply, replyAll, split)
- **Final PL**: 1362 keys
- **EN parity**: 17 `conversation.*` keys in EN too
- **Removed**: `todoist.betaLabel` (dead key — not used in any component, not in upstream, broke parity)
- **i18n parity test**: 1356 tests, 0 fail ✅

**⚠️ Known gap**: CE v2 i18n keys do not yet cover the full list from section 7 (merge, split message, diagnostics, why is this grouped, force include/exclude, rebuild, automated series modes, etc.). These will be added as the corresponding UI features are implemented/completed.

## Test results

| Gate | Result |
|---|---|
| **Backend full suite** | ✅ 90 files, 1229 tests, 0 fail |
| **Frontend full suite** | ✅ 1656 tests, 0 fail |
| **Backend lint** | ✅ clean (0 errors, 0 warnings) |
| **Frontend lint** | ✅ clean (0 errors, 0 warnings) |
| **Frontend build** | ✅ built in 2.46s |
| **i18n parity** | ✅ 1356 tests, 0 fail |
| **Migration integrity** | ✅ 3 tests, 0 fail |
| **Relocate regression** | ✅ 5 tests, 0 fail (includes 12 CE columns) |

### Not yet run (require real PostgreSQL / Playwright / CI)

| Gate | Status |
|---|---|
| Fresh migrations (latest-upstream → CE) | ⏳ pending (needs PostgreSQL) |
| Latest-upstream upgrade migrations | ⏳ pending (needs PostgreSQL) |
| Conversation Engine Postgres integration | ⏳ pending (needs PostgreSQL) |
| Rebuild idempotency x2 | ⏳ pending (needs PostgreSQL) |
| Security (cross-user, forged IDs, XSS) | ⏳ pending (needs PostgreSQL) |
| Race tests (concurrent merge A→B/B→A) | ⏳ pending (needs PostgreSQL) |
| Performance (10k/50k/100k) | ⏳ pending (needs PostgreSQL) |
| Playwright mocked | ⏳ pending (needs browser) |
| Playwright real app | ⏳ pending (needs browser + backend) |
| 2×2 preference matrix | ⏳ pending (needs browser) |
| Mobile | ⏳ pending (needs browser) |
| Plugin boundary lint | ⏳ pending |

## Commits on branch (post-merge)

```
12002f4 fix(i18n): remove duplicate keys from merged i18n.test.js
7fd3573 fix(i18n): remove dead todoist.betaLabel key breaking parity
dc0c795 fix(relocate): preserve CE v2 identity and threading metadata on move/archive/trash
cbaa12c merge: integrate upstream MailFlow 3.2.4 (c1e53df) into CE v2
c1e53df (upstream/main) chore: bump version to 3.2.4
```

## Backup

- Tag: `backup/pre-upstream-324-merge-20260823-224043`
- Branch: `backup/final-completion-pre-324-merge` (HEAD: f4dd4d7)

## Known P0

None at this stage. The integrated candidate is stable:
- All unit tests pass (backend 1229 + frontend 1656 + i18n 1356 = 4241 tests, 0 fail)
- Lint clean (both backend and frontend)
- Build succeeds
- 0002 byte-identical with upstream
- Upstream fully absorbed (0 behind)
- Migrations renumbered correctly (0051-0057)
- RELOCATE_COPY_COLS extended with CE columns

## Known P1

1. **CE v2 i18n keys incomplete**: Only 17 `conversation.*` keys exist. Section 7 requires ~40+ keys (merge, split, diagnostics, why is this grouped, force include/exclude, rebuild, automated series modes, etc.). These will be added as UI features are completed.
2. **PostgreSQL integration tests not yet run**: Fresh migrations, upgrade migrations, rebuild idempotency x2, security, race, performance — all require real PostgreSQL. These are the next critical gates.
3. **Playwright E2E not yet run**: Mocked + real app E2E, 2×2 preference matrix, mobile — all require browser environment.
4. **CE v2 features not yet re-verified against upstream changes**: The merge absorbed 43 upstream commits that touched imapManager.js, messageParser.js, MessagePane.jsx, MessageList.jsx, store/index.js — CE v2 hooks in these files need verification that they still work correctly with the new upstream code.
5. **Subject-only fallback in computeThreadId**: Upstream's computeThreadId still has the subject fallback (90d window). CE v2 must ensure this is NOT used in the active CE path. This requires verification that CE v2's decision engine is wired as the primary path and computeThreadId is only the legacy fallback.

## Known P2

1. **Worktree cleanup**: Multiple old worktrees and branches exist from previous work (PR1-PR8, r3-01 through r3-08, integration branches). These should be cleaned up before final PR.
2. **Old CE migration references**: `migrationIntegrity.test.js` was updated to reference 0055 (was 0051). Need to verify no other tests/scripts reference old migration numbers.
3. **ConversationPane.jsx / ConversationList.jsx**: These CE v2 components need verification that they work with the merged MessagePane.jsx / MessageList.jsx changes.
4. **Adversarial corpus for "Test" subject**: Section 3 requires a large adversarial corpus of messages with subject "Test" to verify no subject-only grouping. This test fixture needs to be created/verified.
5. **Copy-aware action scopes**: Section 18 requires explicit scopes (selected-copy, all-copies-of-logical-message, all-copies-in-account, whole-conversation). CE API needs these scopes implemented and tested.
6. **Automated series modes**: off/strict/smart — need verification that these are correctly implemented and default is "off".

## Next steps (not started — awaiting review)

- r3-01 through r3-08 (section 21: do NOT start until 0 P0, 0 P1, full exact-SHA green CI)
- No upstream PR opened
- No merge to upstream/main
- No production deploy
