# Conversation Engine v2 — r3 review stack

Base integration HEAD: `efef882b5ca8775f005cdc0fff613b3c0abf377d`
Final exact-SHA gate: run `32038151126` (success for exact HEAD)
PL beta integration: `integration/threading-v2-r3-pl-beta`

All r3 branches are intentionally created as a linear review stack from the same verified integration snapshot. The feature commits are already present in the integration history; these refs preserve review ordering without cherry-picking or duplicate patch IDs.

1. `feat/threading-v2-r3-01-correctness` — correctness, migration invariants, legacy repair.
2. `feat/threading-v2-r3-02-conversation-model` — conversation schema, logical messages, evidence and tenant integrity.
3. `feat/threading-v2-r3-03-ingest-rebuild` — production persistence, resumable rebuild, idempotency, background jobs and audit.
4. `feat/threading-v2-r3-04-provider-automated-series` — provider metadata and automated-series safeguards.
5. `feat/threading-v2-r3-05-api-settings` — APIs, preferences, overrides and rebuild controls.
6. `feat/threading-v2-r3-06-outlook-list` — conversation list and provider-aware list behavior.
7. `feat/threading-v2-r3-07-gmail-reader` — reader, copy context, lazy loading and replies.
8. `feat/threading-v2-r3-08-hardening` — security, race/performance gates, CI and i18n.
9. `integration/threading-v2-r3-pl-beta` — integration beta branch including Polish locale.

## Verification commands
```sh
git merge-base --is-ancestor feat/threading-v2-r3-01-correctness feat/threading-v2-r3-02-conversation-model
git merge-base --is-ancestor feat/threading-v2-r3-02-conversation-model feat/threading-v2-r3-03-ingest-rebuild
git merge-base --is-ancestor feat/threading-v2-r3-03-ingest-rebuild feat/threading-v2-r3-04-provider-automated-series
git merge-base --is-ancestor feat/threading-v2-r3-04-provider-automated-series feat/threading-v2-r3-05-api-settings
git merge-base --is-ancestor feat/threading-v2-r3-05-api-settings feat/threading-v2-r3-06-outlook-list
git merge-base --is-ancestor feat/threading-v2-r3-06-outlook-list feat/threading-v2-r3-07-gmail-reader
git merge-base --is-ancestor feat/threading-v2-r3-07-gmail-reader feat/threading-v2-r3-08-hardening
git merge-base --is-ancestor feat/threading-v2-r3-08-hardening integration/threading-v2-r3-pl-beta
git diff --check upstream/main...integration/threading-v2-r3-pl-beta
```

No merge to `main`/`upstream` and no upstream PRs were created.
