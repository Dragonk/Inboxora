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

## Post-upstream review round 2 — reader reconciliation

Review target before this round: `1bb6c797e96b0c652839867ba8029e6ebcdb2319`.
The branch had since advanced; the reader findings were reproduced against the current code.

### Fixed

- **P1 remote-image opt-in**: MessagePane now derives one effective policy,
  `!blockRemoteImages || imagesRequestedRef.current.has(selectedMessageId)`, and uses it
  consistently for div sanitization, iframe rendering, print rendering, and per-message
  Load images / Allow sender / Allow domain actions. A successful unblocked API refetch is
  no longer sanitized back to blocked HTML by the div renderer.
- **P2 nested scroll containers**: shared `MessageBodyRenderer` now expands nested
  `overflow:auto/scroll` email containers, tracks image/resize changes, and restores
  original inline styles on cleanup.
- **P2 text-only quote folding**: quote detection/folding is now handled in the shared
  sandboxed renderer and includes text-only markers (`On ... wrote:`, `Dnia ... napisał`,
  `-----Original Message-----`, `-----Wiadomość oryginalna-----`). ConversationPane uses
  the same renderer policy rather than a separate DOM-folding implementation.

### Round-2 verification

- Backend: **92 files, 1249 tests, 0 fail**
- Frontend: **1777 tests, 0 fail**
- i18n: **1390 tests, 0 fail**
- Backend lint: clean
- Frontend lint: clean
- Plugin boundary lint: clean
- Frontend build: successful (2.83s)
- Conversation E2E desktop: **6/6 passed**
- Conversation E2E mobile: **6/6 passed**
- Browser security E2E desktop + mobile: **4/4 passed**
- `git diff --check`: clean

The two previously observed preference/navigation matrix failures did not reproduce:
all four matrix tuples passed on both desktop and mobile in this round.

### Remaining reader findings

- No demonstrated P0 remains.
- No reproduced P1 remains from this review round.
- PostgreSQL integration, real-app Playwright, migration upgrade/fresh-schema, rebuild
  idempotency, race, security, and performance gates still require the corresponding
  external services/CI environment.
- Non-PL CE translations remain EN placeholders and are explicitly tracked by the i18n
  parity allow-list; PL coverage is complete for the current CE key set.

**Round-2 implementation commit**: `4080fff23a99c9f0812abc0df690ea925d0bd20e`


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

None demonstrated in this round.

## Known P1

1. **Real PostgreSQL/CI gates remain pending**: fresh and populated-schema migrations, CE PostgreSQL integration, rebuild idempotency x2, real security/race/performance tests require the external PostgreSQL/CI environment.
2. **Real-app Playwright remains pending**: mocked Conversation E2E is green on desktop/mobile, but real-app E2E still requires the deployed test backend.
3. **Active CE subject-only proof remains pending**: upstream `computeThreadId` retains the legacy normalized-subject fallback. The CE-active path must be proven with the 100-message adversarial corpus.
4. **Non-PL CE translations**: current CE keys in de/es/fr/it/ru/zhCN are EN placeholders allowed explicitly by the parity gate; PL coverage is complete.

## Known P2

1. Worktree cleanup remains pending.
2. The 100-message cross-year/account/folder/sender `Subject: Test` adversarial corpus remains to be run against real PostgreSQL.
3. Copy-aware destructive scopes and manual operation behavior need real PostgreSQL/E2E verification.
4. Automated series modes (off/strict/smart) need real ingest/rebuild verification.

## Next steps (not started — awaiting review)

- r3-01 through r3-08 (section 21: do NOT start until 0 P0, 0 P1, full exact-SHA green CI)
- No upstream PR opened
- No merge to upstream/main
- No production deploy
