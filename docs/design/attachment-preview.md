# Attachment preview: reviewed implementation plan

Issue: #29. Review date: 2026-09-30. Plan revision: 1.3.
Source examined: dev at 57dd169e75f1361a7c2eadd968e0d9423a43ec49.

## Delivery contract

Implement the complete agreed format matrix and extras in one isolated feature branch. Prepare all production paths and fixtures before running the integrated test phase. Do not publish separately usable phases or advertise an image as ready after only the image/text foundation. Target the integration branch dev, not main. Do not use coding agents on the server. Do not create additional issues.

Completion requires the complete implementation, passing relevant local gates, a PR with passing GitHub checks, resolved actionable review findings, and matching frontend/backend dev image manifests for the exact tested commit. Never move latest or create a numbered release for this task. The current 4.2.0 release is already dated 2026-09-30; this feature belongs under Unreleased until its release version is assigned.

## Feasibility and necessary corrections

The requested feature is feasible as a coordinated frontend/backend change, but the original plan is not a complete acceptance or security specification.

1. Encrypted OOXML is normally an OLE/CFB container with EncryptionInfo and EncryptedPackage streams, not a ZIP with encryption.xml. A CFB header alone does not establish encryption: ordinary XLS/DOC/PPT files also use CFB. Use the parser's encryption status, including an explicit unsupported/unknown result.
2. Signature fields do not prove that a PDF is signed. Use PDF.js 6.3.289 getSignatures() for actual signature metadata and getFieldObjects() only for separate field/placeholder awareness. Report unavailable cryptographic verification, not a positive statement of validity. Empty placeholders must not be labelled as valid signatures. @signpdf/signpdf is a signing library, not a ready-made PKCS#7/PAdES verification service; do not add it for this scope.
3. Lazy page rendering does not eliminate attachment transfer. The existing endpoint buffers provider attachment bytes. Opening the overlay immediately and rendering visible pages first is achievable; opening any 50 MB document instantly is not a valid acceptance promise. Range/progressive transport requires a separate explicit provider-aware design, not an untrue performance claim.
4. The installed PDF.js 6.3.289 API differs from old examples: getFieldObjects returns a Map, getPermissions returns a Set, getSignatures exposes signer/reason/time metadata, and isEvalSupported is not in DocumentInitParameters. Use the installed public types, no scripting manager, no automatic linking, disabled XFA, local worker/assets, and the current safe rendering path rather than suppressing type errors.
5. The current Markdown sanitizer permits no class attribute while AiMarkdown looks for code.language-mermaid. Static inspection therefore identifies a missing prerequisite: preserve only validated language markers on code elements, and prove that fenced Mermaid survives sanitization. Reusing the existing hook unchanged is insufficient.
6. The checkout has nine locale JSON files: cs, de, en, es, fr, it, pl, ru and zhCN, not ten. Update every actual catalogue and the source-text/placeholder gates.
7. Dialog registers Back at priority 4500. A root preview at 5000 with a password Dialog at 4500 would close the wrong surface on Android. Define modal ordering explicitly and keep focus restoration, Escape and system Back consistent for nested dialogs and archive navigation.
8. The production CSP does not explicitly permit blob media. Update every HTTP/HTTPS CSP declaration consistently for media-src and same-origin workers. Do not add unsafe-eval, arbitrary frame origins, or script permission to attachment frames.
9. A cache key needs authEpoch and the complete immutable source path, including queue revision, not just messageId:part. Cached URLs require ownership/ref-counting; closing one surface must not revoke another window's URL. Enforce a byte budget even when multiple entries are pinned.
10. Limits must apply to actual streamed/decompressed bytes, not only metadata. Add cumulative nested-archive, entry-count, recursion, image-pixel, spreadsheet-cell and processing-time limits. Apply ZIP safety checks to OOXML/ODS as well as visible ZIP attachments.

## Library decisions

Versions below were checked against the package registry on 2026-09-30; SheetJS was checked against its authoritative distribution documentation. Pin direct additions and commit lockfile integrity. An up-to-date version is not itself proof of security, licensing compatibility, or correct integration.

| Library | Version | Decision |
| --- | --- | --- |
| pdfjs-dist | 6.3.289 | PDF engine and maintained viewer components; bundle worker, fonts/CMaps and required assets locally. |
| utif | 3.1.0 | TIFF in an interruptible worker with dimension limits before raster allocation. |
| docx-preview | 0.4.1 | Primary DOCX renderer, subject to isolated rendering and external-resource checks. |
| mammoth | 1.13.0 | Sanitized DOCX fallback; never insert unsanitized output into the application document. |
| xlsx / SheetJS CE | 0.20.3 | Official CDN tarball at build time, bundled locally at runtime. npm's xlsx 0.18.5 is stale. |
| papaparse | 5.7.0 | CSV/TSV parsing in a worker with row/column limits. |
| xml-formatter | 3.7.0 | Bounded pretty printing; reject unsupported declarations and retain raw fallback. |
| jsonc-parser | 3.3.1 | Validate and format source without losing comments, number precision or key order. |
| highlight.js | 11.12.0 | Selective language imports; bounded highlighting, escaped raw fallback. |
| office-crypto | 0.1.0 | MIT; isolated backend worker only. Verify actual supported encryption fixtures and integrity failures. |
| mailparser | 3.9.32 | Updated from 3.9.31 in the submitted plan; isolated EML parsing with output limits. |
| @zip.js/zip.js | 2.19.0 | Candidate replacing a handwritten central-directory parser: explicit encrypted-entry metadata, strict header checks and streaming extraction. Use local/native worker integration, no generated blob workers or remote code. |
| busboy | 1.6.0 | Only for the proposed bounded multipart path for nested/queued binary processing. |
| pptx-preview | 1.0.7 | Not installed. npm metadata says ISC but the author README restricts source redistribution and modification. Resolve terms and sandbox fidelity before inclusion; otherwise use the explicitly agreed PPTX download-only outcome. |
| marked, mermaid, ical.js, rate-limiter-flexible | Existing | Reuse current dependencies and current parser/security boundaries. |

Primary references: https://docs.sheetjs.com/docs/getting-started/installation/nodejs/ ; https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html ; https://github.com/vbuch/node-signpdf ; https://github.com/501351981/pptx-preview ; https://gildas-lormeau.github.io/zip.js/api/classes/ZipReader.html . Package contracts were also read from the installed package declarations and registry READMEs.

## One source model for every surface

A preview source carries the complete authenticated attachment path, filename, declared MIME, known size, authEpoch and its parent message's attachment list. Queue sources must use queuedAttachmentPath and retain the exact revision. Nested ZIP/EML files carry a transient Blob and share their parent's resource budget. They must use the same renderer and download-warning policy as top-level files.

Keep blobs, pending fetches, decoder resources and passwords out of persisted state. Store only the open surface/window descriptors. A source change, logout or authEpoch change must abort the originating work. Late results must not mutate another message, a different queue revision, or a later login by the same user. A detached window retains its own source and does not follow the main message selection.

All visible object URLs are owned by the rendering surface, revoked on replacement/unmount, and never revoked while another surface still owns them. The blob cache has a small LRU and a hard byte budget; opening more windows may require refusing a preview rather than allowing unlimited pinned memory.

## Functional contract

| Area | Required behavior |
| --- | --- |
| Shared entry point | Chips open the full-screen preview; a separate accessible button still downloads. Preserve dangerous-file confirmation and physical-copy ownership. Wire MessagePane, ConversationMessage/Reader and queued/source previews. |
| Images | PNG/JPEG/GIF/WebP/AVIF/BMP, sanitized SVG and bounded TIFF; zoom, rotation, fit, image-only gallery, lazy 48 px thumbnails, PNG clipboard conversion and animation/first-frame notice. |
| PDF | Continuous scrolling with lazy/cancelable rendering, active page input, page count, width/page fit, 50-400% zoom, rotation, nested outline, page thumbnails, search and selection, password callback, unverified signature-field information, complete-document print and download. |
| Office | DOCX primary and sanitized fallback; XLSX/XLS/ODS sheet tabs, formatted values, frozen leading row/column and bounded visible rows. No macros, formulas, embedded actions or external relationships are executed. |
| PPTX / legacy | PPTX remains a qualified renderer decision, not an untested promise. DOC/PPT/ODT/ODP have the already-approved explicit download-only screen. Unsupported encryption must remain distinguishable from a bad password and corrupt input. |
| Text | Markdown with actual Mermaid diagrams; JSON/JSONC preserving comments and numeric source; XML and CSV/TSV; raw text and selected code formats. Pretty-print failure preserves escaped readable source, never an empty view. |
| Archives | List central directory without unpacking. Extract only the selected entry in a worker. Support the same preview matrix inside an archive, an explicit nested Back/breadcrumb path and safe download of a selected entry. Encrypted ZIP entries remain download-only with a clear explanation. |
| Media | Native controls, no autoplay, capability/error fallback and blob-compatible CSP. Do not assume every browser/WebView is Chromium or supports every container/codec pair. |
| HTML / EML | No-script, network-blocked sanitized document frame. EML exposes safe headers/body and separately downloadable inner attachments; do not treat an inner attachment as a URL. |
| ICS / VCF | Reuse calendarResources/parseCalendarEvent and splitVCards/parseVCard. Show multiple selectable cards. Import only on an explicit action into a currently owned writable local collection through the existing import endpoint. |
| Windows / shortcuts | Shared surface in overlay and FloatingWindow; minimize/restore/dock, bounded stacking, separate source state. Preview shortcuts must not trigger mail delete/archive/compose shortcuts underneath. |

Text fallback must disclose its chosen encoding. BOM and a supported declared charset take precedence; Windows-1250 is an explicit legacy fallback, not a detector that can reliably distinguish it from Windows-1252. Offer a controlled encoding selector for ambiguous files.

Markdown and image clipboard operations need a visible error when unavailable or denied. Downloads continue to work independently. Never silently download a dangerous nested file in response to a preview error.

## Server-assisted processing contract

Keep the existing authenticated GET paths and download dispositions unchanged. Reuse existing provider ownership checks; do not accept an arbitrary remote URL for backend preview processing.

For original messages, either extract an owned-attachment read service from the existing route or reuse bytes already fetched by the client. A bounded multipart processing endpoint is the proposed common path for queue files and nested archive files, which have no standalone physical-message part ID. It must not create a persistent upload API or a new storage table.

Proposed internal actions: probe, unlock, eml-parse, eml-part, and cards. The exact route layout is an implementation contract, not a reason to duplicate Graph/Gmail/IMAP retrieval. Request bodies carry bounded file bytes and, only when required, a password or an inner-part index. Passwords never appear in URLs. PDF passwords stay entirely client-side.

Authentication, CSRF, rate limiting and concurrency admission run before buffering expensive requests. Use shared user and IP limits, fail closed when their store is unavailable, cap concurrent workers, and cancel on client disconnect. Workers enforce execution time and memory limits and return fixed error codes, not exception strings containing document data. Test bad password, unsupported algorithm, corrupted file, resource limit, rate limit and cancellation as distinct cases.

Office decryption runs in a disposable Node worker with password verification and available integrity verification. Return only transient bytes and no-store/nosniff response headers. Never persist decrypted documents, passwords or parsed mail to the database or a temp file. This is an application-level promise: operating-system swap/core-dump policy is separate, and JavaScript strings cannot promise cryptographic zeroization.

EML output is bounded separately from input. Large inner attachments must not be embedded as unbounded base64 in a JSON response. A stateless eml-part request can return one attachment from the same original bytes, subject to the same limits. Card import continues to use the existing local-collection authorization, UID deduplication, transaction and invitation-ownership protections.

## Resource and isolation budget

Proposed hard limits: 50 MiB input/entry, 150 MiB aggregate expanded archive bytes, 500 visible ZIP entries, three nesting levels, a separately bounded Office package entry count, 2 MiB pretty-print/highlight text, 10,000 spreadsheet rows, 256 columns and 500,000 total decoded cells, 100 sheets, 24 megapixels per decoded image, and a 15-second cancelable client parsing operation. Backend worker limits must be chosen and recorded before integration, not inherited accidentally from V8 defaults.

Those are explicit safe fallbacks, not permission to allocate first and check afterwards. Inspect dimensions and archive metadata before allocation, check actual streamed output too, and reject duplicate/ambiguous paths, traversal, symlinks, corrupt CRC/header data and unsupported encryption. A nested archive consumes the same parent expansion allowance rather than resetting it. Verify each limit with an adversarial fixture after all format paths are prepared.

DOCX conversion must be safe before rendering, not merely sanitized afterwards. Audit the renderer's document ownership and element creation, disable altChunks/external relationships/fonts as needed, and establish the sandbox CSP before insertion. Test that remote images/CSS/fonts cannot be requested from the outer application while a converter creates detached nodes. SVG filtering must remove active elements and external references, not just scripts and event attributes. Mermaid must reject init/config overrides and sanitize final SVG.

PDF worker, viewer CSS and required assets must be served by Inboxora. Scripting/XFA and automatic external actions are not enabled. Inspect the exact v6 API and cancel/destroy resources using its actual contracts. Printing must prepare the complete requested document rather than only currently visible canvases, with its own progress/cancellation and memory budget.

## Integrated verification and publication

Prepare all production format paths, safe fallbacks, locale entries and fixtures first. Then execute the complete verification phase; do not ship the earlier numbered PR slices from plan 1.2.

| Gate | Evidence required |
| --- | --- |
| Detection / text | Extension-MIME-signature conflicts, compound but unencrypted XLS, BOM/charset and Polish legacy text, malformed JSON/JSONC/XML/CSV, preserved JSONC comments and large integer source, readable raw fallback. |
| Client lifecycle | Open/close/Escape/Android Back, nested password Back, archive Back, keyboard isolation, focus restoration, two physical copies with identical part IDs, source change, queue revision change, concurrent floating windows and logout/login races. |
| Security | Dangerous-file confirmation on chips, toolbar and nested downloads; no network requests or active content from SVG/DOCX/HTML/EML/Mermaid; archive limits and integrity, malformed Office packages, image-pixel limits, CPU cancellation, no leaked object URLs. |
| Office / server | Real fixtures covering Agile AES/SHA-512, Standard and supported legacy XLS; correct/wrong password, unencrypted CFB, unsupported algorithm, corrupt encrypted payload and HMAC/integrity failure; unauthenticated/cross-user/CSRF attempts, shared rate limits, concurrency admission, disconnect cancellation and absence of passwords/content from logs. |
| Format coverage | Every required extension, nested PDF/text/image/Office samples in ZIP, native media success and unsupported codec, EML inner-part download, multiple ICS/VCF cards, explicit imports into allowed and denied collections. |
| PDF acceptance | 100-page document, jump to page 87, scroll/zoom/rotate without whole-document eager rasterization, outline and thumbnails, search/selection, password correction, empty and populated signature fields, full-document print, immediate return to the message. |
| Presentation | Both themes, desktop and narrow mobile, long translated names, keyboard/screen-reader labels, unavailable clipboard/print behavior, no horizontal toolbar overflow. |
| Runtime | Node 22 as required by .nvmrc/backend engines; browser, Electron and Capacitor worker/CSP and Back paths. Native bridge emulation must not be reported as a physical-device test. |
| Quality | Frontend/backend typecheck and strict typecheck, lint with zero warnings, all applicable tests/integrations, i18n, production builds, dependency audits and git diff --check. Do not weaken assertions or suppress types to make a gate green. |
| GitHub | Fetch current dev before integration/commit, review only this task's diff, concise English PR to dev, check current review findings and the latest CI attempts. Identify whether a check tested a PR merge SHA or the head SHA. |
| Docker | Build from an immutable tested source using Publish to GHCR with source_sha. Verify frontend and backend dev tags, source labels and both linux/amd64 and linux/arm64 manifests. A queued run or an older successful build does not meet the condition. |

A PR check may test GitHub's synthetic merge commit rather than the branch head. Before publication, ensure the exact image source is covered by a successful workflow run, or integrate through the appropriate approved dev PR and validate that resulting source. The existing publisher can validate ancestry against the selected branch; no direct main push or main merge is needed for a development test image.

Update README, docs/CHANGELOG.md under Unreleased, and the appropriate unreleased wiki narrative without claiming this feature shipped in the already-released 4.2.0. Once a release version is assigned, move the narrative into its matching release notes. Keep all GitHub copy concise and factual. Record the PR, tested SHA, workflow conclusions and image digests in the completion report.

## Implementation record

The complete format matrix and safe download-only outcomes are implemented in the isolated
`feat/attachment-preview-29` branch. Sources live in `frontend/src/components/attachments`,
`frontend/src/utils/attachments`, `frontend/src/store/attachmentSlice.ts` and
`backend/src/routes/attachments.ts` / `backend/src/services/attachments`.

Implementation refinements: ZIP uses zip.js 2.19.0 native streams inside a same-origin worker;
XML and spreadsheet expansion are preflighted with saxes 6.0.0; DOCX conversion uses an inert
document factory before the existing sanitizer/frame; HTML/EML additionally forbid all automatic
network resources. The processing location disables nginx request/response buffering. Node 22
is used for validation. The PDF viewer uses the current public engine/TextLayer/signature APIs
rather than copying an older viewer API contract.

Regression fixtures and tests are committed with the feature. Generated document fixtures are excluded only from the AI review file count; their generators, test assertions and provenance remain reviewable, and every fixture remains in CI. The browser matrix uses the
production CSP and also runs against the authenticated real backend processor in the existing
real-app workflow. It includes complete-document print preparation and clipboard operations;
the print-dialog trigger is instrumented in headless tests rather than sent to an actual printer.
The submitted implementation record is not a claim that a GitHub run or registry publication has
succeeded: the completion report must name their exact SHA and results after verification.

No coding agents, release version bump, direct main push or changes to another workspace were
used. User-facing limitations, exact implemented budgets and deployment requirements are in
[the development release notes](../wiki/Release-notes-Unreleased.md).


## 2026-10-01 refinement of the delivery contract

The user's follow-up supersedes the metadata-only signature scope above. The same PR now
includes current-time PDF/CMS validation (pyHanko 0.37.0), certificate/revocation details,
optional ClamAV, native libarchive formats, compact controls, 100% initial PDF zoom,
fullscreen restoration/native browser actions, DOCX page/background fidelity, Mermaid labels,
and composer drop/size warnings. Original files remain unchanged. This is not historical
PAdES-LTV or automatic EU qualified-signature validation. Runtime configuration, resource
boundaries and limitations are recorded in the unreleased release notes.
