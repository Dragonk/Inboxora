# Inboxora technical identifier audit

Audited for v3.4.0. Public names, app metadata, package IDs, UI titles, notifications,
user-agent strings, generated certificate subject, and translated product references use
**Inboxora**. The legacy identifiers below are intentional compatibility boundaries, not
user-facing branding.

| Legacy identifier family | Why it remains | Migration policy |
| --- | --- | --- |
| `mailflow_` localStorage keys and `mailflow-nav` IndexedDB | Preserves existing browser settings, locks, layout and notification deep links. | Keep reading and writing the established schema; a rename requires an explicit, tested data migration. |
| `data-mailflow-` attributes, `mailflow-` CSS classes and `application/x-mailflow-` drag types | Serialized email rendering and in-page drag/drop contracts used by existing clients and fixtures. | Stable until a versioned dual-read/dual-write migration is introduced. |
| `X-MailFlow-Image-Opt-In` | Browser-to-server remote-image consent header. | Keep as a stable HTTP compatibility contract; do not rename without accepting both names server-side first. |
| `MAILFLOW_` Android/signing secret names and `mailflow-signing` runner directory | Existing GitHub Actions secret names cannot be renamed without provisioning replacement secrets. | Retain as CI-only compatibility aliases; emitted applications remain Inboxora. |
| `mailflow` Docker network, container names, and default database/user names | Renaming them would orphan volumes or make upgrades create an empty database. | Preserve for in-place upgrades; fresh installations may override database values through documented environment variables. |
| `mailflow_test` CI databases and `mailflow-ce-perf.mjs` | Non-production fixture/performance identifiers. | Keep isolated from public release artifacts; rename only with CI fixture updates. |
| `mailflow.local`, timing hashes, message CID suffixes, OpenAI `originator`, notification tags/events, legacy desktop package detection, Android bridge class, and SVG/CSS identifiers | Safe fallback/internal values or existing client protocol fingerprints. | Not displayed as product branding; change only with contract and deliverability review. |

The frontend `brandAudit.test.js` guards the visible surface and requires this compatibility
record to name the retained identifier families.
