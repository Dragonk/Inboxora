# MailFlow Conversation Engine v2 — continuation status

Current branch: `feat/threading-v2-integration-live`
Current HEAD: `5e596a07098e50647280b13fbaf5a46ad4ca1302`
Last green exact-SHA workflow before latest commits: run `32028525163`, tested `6a8ab62935fddb4a033286f3eab3f51a69e716d1`.

Latest commits after that run:
- `084a831` enforce overrides and real rebuild mutation counts
- `6a8ab62` real rebuild artifacts and verified persistence ownership
- `5e596a0` override aggregate reconciliation and CI metadata

Required before final report:
1. Run hosted workflow for exact `5e596a0`.
2. Fix and test remaining P1 review findings: tenant-scoped DB constraints, effective override behavior for rebuild/ingest, complete merge/split reconciliation, null-date cursor safety, real legacy data fixture, migration checksums, actual race/security/E2E/performance gates.
3. Add EN/FR/PL verification and screenshots.
4. Independent review after all changes.
5. Only then create linear `-r3` stack with PR descriptions and verify ancestry/patch IDs.

Do not claim final readiness, do not merge main/upstream, and do not open upstream PRs until all P0/P1 are empty.
