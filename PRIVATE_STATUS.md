# MailFlow Conversation Engine v2 — continuation

Branch: `feat/threading-v2-integration-live`
Current HEAD: `80102c953df80cd82cd8d84c970d53997984b9f8`
Backup tag: `threading-v2-integration-live-634889d`

Completed since prior exact-SHA run:
- tenant composite constraints and migration checksum integrity tests;
- null-safe rebuild resume predicate;
- Polish locale beta (`frontend/src/locales/pl.json`) and locale registration;
- synthetic legacy fixture with 12 subject-only Test messages across two accounts and years;
- provider fixtures for Gmail BigInt, Outlook and generic/Fastmail;
- explicit security, race and performance gate tests;
- E2E 2x2 feature-preference contract test;
- upgrade script now inserts deterministic synthetic legacy data after applying migrations 0001–0046.

Important: every change after run `32029016100` invalidated that run. A new exact-SHA workflow must run after the final integration commit.

Still required before r3:
- convert the legacy fixture into a real upgrade assertion after applying 0047–0051;
- verify tenant constraints against real PostgreSQL with negative cross-user writes;
- test manual merge/split/force override behavior end-to-end and alias read resolution;
- run actual security/race/E2E/performance jobs, not only unit/contract checks;
- run complete frontend EN/FR/PL locale tests and capture screenshots if browser tooling is available;
- independent adversarial review after all final changes;
- final exact-SHA workflow;
- then create direct-descendant r3 stack and `integration/threading-v2-r3-pl-beta`.

No merge to main/upstream and no upstream PR.
