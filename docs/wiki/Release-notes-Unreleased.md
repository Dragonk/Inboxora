# Development changes — unreleased

These changes follow [4.2.0](Release-notes-4.2.0.md) and are intended for the `dev` test images.
They do not change the released version number or the `latest` image tags.

## Attachment previews

Click an attachment to read it inside Inboxora instead of immediately downloading it. The
full-screen reader supports Escape, a close button and Android Back. Downloads remain on
an independent attachment-chip button and in the reader toolbar, with dangerous-file
confirmation preserved. Queue attachments use their exact scheduled-message revision and
previewing them does not pause, edit or send the queued message.

The reader uses one filename/action header and accessible icon buttons with tooltips. PDF
opens at 100%. Search stays right-aligned with document actions on wide screens and opens
from an icon on phones. Mobile previews cover the viewport without the former side gap.

Image attachments have lazy 48-pixel thumbnails, zoom, left/right rotation, fit and an image-only gallery.
Desktop previews can move into the existing floating-window layer, including minimize,
restore and independent navigation, plus an explicit return to the full-screen reader.
PDF and supported images can also open in the browser’s native viewer. That action uses a
short-lived local blob, not a public attachment URL; HTML and Office files do not receive it. Phones keep the touch-first preview and Back navigation
after rotation; desktop-only window actions are not shown in landscape phone layouts. Text previews have literal search, highlighted matches,
source copying and a selectable decoding. UTF-8, BOM/declared charsets and Windows-1250
legacy text are supported; ambiguous encodings can be changed explicitly.

### Formats

| Family | Preview behavior |
| --- | --- |
| Images | PNG, JPEG, GIF, WebP, AVIF, BMP, sanitized SVG and the first TIFF page. Browser codec support still applies. |
| PDF | Continuous lazy pages, selectable text, page entry and arrows, outline, thumbnails, search, 50–400% manual zoom, fit modes, rotation and complete-document printing. |
| Office | DOCX formatting and a sanitized fallback; XLSX/XLS/ODS tables with sheet tabs, formatted values and frozen leading row/column. Cached formula results can be displayed; formulas and macros never run. |
| Text | Markdown with Mermaid, JSON/JSONC preserving comments and large-number source, XML, CSV/TSV and common text/code formats. Failed formatting retains readable source. |
| Archives | ZIP is indexed locally without eagerly expanding entries. 7z, RAR4/RAR5, TAR, GZIP, BZIP2, XZ and Zstandard use a bounded server reader. Selected files reuse the same viewers. Native solid/compressed archives may require reading preceding entries; no extracted filesystem tree is created. |
| Media | Native audio/video controls without autoplay. Unsupported codecs retain a download option. |
| HTML / EML | Sanitized, no-script, network-blocked message frame. EML exposes safe headers/body and individually downloadable inner attachments. |
| ICS / VCF | Multiple event/contact cards with explicit selection and import into an owned writable local collection. Existing UID and invitation-ownership protections remain. |

PPTX, DOC, PPT, ODT, ODP and macro-enabled Office formats remain download-only. PPTX was not
admitted because the proposed renderer's distribution metadata and author terms conflict;
no third-party presentation service or LibreOffice conversion service was introduced.
Encrypted ZIP entries and unsupported Office encryption variants are also download-only.
DOCX now preserves page sections, explicit page breaks and document backgrounds inside the
passive frame. Automatic pagination, unavailable fonts and the Mammoth fallback can still
differ from Word; this is not an editing or exact layout-compatibility promise. Mermaid uses
SVG text labels and theme-aware rendering, so sanitization no longer removes block labels.

### Passwords and signatures

PDF passwords are handled by the local PDF worker and never sent to the server. Supported
Office encryption is probed and unlocked by disposable server workers, including Agile and
Standard OOXML and supported legacy XLS variants. Bad passwords, unsupported encryption,
corrupt input and resource limits have distinct responses. Agile integrity is checked before
returning decrypted bytes; a correct password does not make a corrupted document acceptable.

The Signatures button opens a responsive list and certificate-detail dialog. Green requires
intact signed bytes, a permitted document-signing certificate, a trusted chain and sufficient
revocation evidence. Red indicates a failed check under the current-time policy; yellow means
verification is incomplete or unavailable. Empty fields never become valid signatures.
Integrity, issuer/subject, validity dates, serial, fingerprint, algorithms, document changes,
revocation and timestamp results are shown separately. Signer-declared time is not a trusted timestamp.

Validation uses pyHanko 0.37.0 with required revocation checking and incremental-change analysis.
It is **current-time validation**, not qualified-signature/eIDAS certification or historical
PAdES-LTV validation. Without configured anchors, the bundled public TLS roots are used and
the dialog discloses that limitation. Embedded certificates never become trust anchors merely
because they arrived in the PDF. Encrypted PDFs can be read with a local password, but server
signature verification remains unavailable when it cannot inspect the original encrypted file.

## Composer attachments

Dropping files on the message body adds attachments rather than inserting images into the editor.
The picker and drop target share whole-batch, in-flight-read and sender-limit checks. Sending is
blocked while files are being read and is checked again after an account change. Existing draft
attachments are preserved when another batch is rejected.

SMTP accounts can discover the advertised EHLO SIZE limit without sending a message or credentials.
Connection policy, DNS pinning, TLS checks and short timeouts still apply. The actual rendered MIME
size is passed to SMTP and checked before dispatch. Gmail’s 35-MiB raw-message ceiling is distinct
from its 25-MiB decoded attachment budget. Graph upload ceilings are not a promise about a tenant’s
mailbox policy. Missing SMTP SIZE uses the installation fallback. Per-user or recipient limits
that a provider does not expose cannot be inferred reliably, and may still be refused by the provider.

Appearance → Attachment warnings has a server-saved attachment warning threshold (default 20 MiB, 0 disables
only the warning). It warns about the combined attachment size without changing provider or
installation safety limits. All new controls and messages are translated in the nine catalogues.

## Safety and resource limits

Dependency refreshes include DOMPurify 3.4.16, sanitize-html 2.18.0, IP classification/request-parser fixes and React Router 7.18.4. The router security update is covered by the full application browser suite, not only attachment cases.

The attachment cache is session- and complete-source-path-scoped, with reference-counted
reads, a five-entry/100-MiB budget and cancellation on logout. A queue revision is part of the
key. Every active reader receives shared download progress, including readers opened mid-transfer.
Released readers stop receiving progress immediately. Blob URLs belong to individual surfaces and are revoked when no longer needed.
Passwords and decrypted documents are not stored in preferences, browser storage, databases
or application temporary files. Operating-system swap and upstream proxy policies are separate.

EML parts are streamed with a 100-attachment count limit and a 50-MiB cumulative decoded-byte
limit. Only an explicitly requested inner attachment is retained in memory; the overview keeps
metadata instead of all attachment bodies. Invalid part indexes are rejected before processing,
and worker heap exhaustion is reported as a resource limit rather than corrupt input.

Input and each ZIP entry are capped at 50 MiB. Expanded archive work has a shared 150-MiB
budget, at most 500 directory entries and three nested archive levels. Office packages have
separate entry/XML limits and at most 50 MiB expanded content. Decoded images are capped at
24 megapixels; TIFF shows its first page. Text parsing is limited to 2 MiB. Workbook parsing
has a 500,000-cell ceiling, up to 100 sheets, 256 displayed columns and 10,000 displayed rows;
legacy XLS is capped at 1,953 rows before parsing. Formatted workbook output is bounded too.
Limits leave an explicit download path rather than an empty or frozen reader.

PDFs have a 2,000-page admission ceiling. Printing prepares every page, not just visible
canvases, and has separate limits of 200 pages and 100 MiB of rendered images. Large prints
can be cancelled or downloaded for a native viewer. Loading the reader immediately and
lazily rendering pages does not eliminate the time needed to transfer attachment bytes.

Client parsing workers are terminated after 15 seconds. Server processing admits at most two
concurrent requests per process and one per user, with a 30-second request deadline and
15-second JavaScript-worker deadline. Native subprocesses have a 28-second deadline,
20 CPU seconds, a 512-MiB address-space limit, disabled core/file output and a restricted environment.
The native archive reader installs a fail-closed syscall allow-list: after initialization it cannot
open filesystem paths, create network sockets or launch another process. Workers have bounded JavaScript heap/stack settings; these are not
an operating-system-wide memory quota. Redis limits processing to 30 requests/user/minute,
60/IP/minute and 10 unlock attempts/user/minute. Admission fails closed when Redis is unavailable.

DOCX conversion uses a detached document with no browsing context, removes external
relationships before conversion, and sanitizes the final output in the existing frame pipeline.
HTML/EML cannot automatically load even same-origin resources. SVG and Mermaid reject active
content, remote image references and configuration overrides. PDF and parsing workers, fonts
and CMaps are bundled locally; documents are never sent to a public preview/conversion service.
Signature validation can contact public issuer certificate/OCSP/CRL endpoints when enabled;
only verification metadata, not the document, is sent in those requests.

## Operator notes

Deploy matching frontend and backend development images together. No schema migration is required.
Docker images include the pinned Python validator, native archive libraries, syscall-filter support
and time-zone data. Non-Docker Linux installations must install `backend/preview/requirements.txt`
with its hashes plus libarchive/libseccomp and set `ATTACHMENT_PREVIEW_PYTHON` to that interpreter.
Node 22 and the existing Redis remain required.

### Optional ClamAV

The default installation does not need ClamAV. To enable the supplied overlay on a development
installation, keep the normal `.env` and run:

```sh
INBOXORA_VERSION=dev docker compose -f docker-compose.ghcr.yml -f docker-compose.clamav.yml up -d
```

The overlay uses the maintained ClamAV 1.5 image series, a persistent definition database, a
private scanning network and a 4-GiB container memory limit. No clamd port is published.
Wait for initial definitions and health before testing. The official image currently targets
amd64; ARM64 operators need a suitable `CLAMAV_IMAGE` or a separately managed private daemon.
An existing daemon can instead be selected with `ATTACHMENT_CLAMAV_HOST` and
`ATTACHMENT_CLAMAV_PORT`. Never expose clamd's unauthenticated protocol to the Internet.

Configured scanning happens before preview/rendering, including nested and decrypted files.
Known malware, incomplete scanning, an unavailable daemon or an exhausted scanner budget blocks
the preview and native-browser action. Download remains possible only through the explicit
warning flow in the UI. Known scan warnings are shared with attachment-chip and Download all
actions. Raw authenticated downloads do not mark a file as safe for preview. Originals are not
rewritten or quarantined. Only successful digests are briefly reused (30 seconds); passwords
and document bodies are not cached by the scanner client. Scanner temporary extraction uses
an in-memory filesystem, not the database volume.

Encrypted content that ClamAV cannot inspect remains blocked, even when Inboxora could otherwise
ask for its password. The user can download it with the warning; turning on scanning is not a
silent exception for encrypted files. Antivirus is an extra layer, not a guarantee that every
malicious or damaged file can be detected. The renderer sandbox and resource bounds remain active.

### Signature trust policy

`PDF_SIGNATURE_ONLINE=true` allows bounded public issuer/OCSP/CRL lookups. `false` uses only
available embedded/local evidence. Requests do not inherit proxy credentials or cookies, do not
follow redirects and cannot target private, loopback, link-local or transition addresses. DNS
answers are checked and pinned; ports are limited to 80/443, with per-request and aggregate limits.

`PDF_SIGNATURE_TRUST_ROOTS` can name a read-only PEM certificate bundle inside the backend container.
Mount the operator's approved CA bundle and set that path; do not trust roots merely supplied by
a document. `PDF_SIGNATURE_REVOCATION_DIR` can name a read-only directory of current `.crl` files
for offline/private-PKI use. Neither setting imports an EU Trusted List automatically. Lack of
appropriate trust or revocation evidence produces yellow, not a guessed green result.

The bundled nginx configuration allows local workers and blob media, serves the PDF worker
as JavaScript, and gives the attachment-processing path a 51-MiB HTTP body window. Request
and response buffering are disabled there so multipart passwords and decrypted bytes are not
spooled by nginx. Custom upstream proxies should retain equivalent size, timeout, TLS and
non-buffering rules. Do not log multipart request bodies or relax script/frame CSP permissions.

## Verification

The regression suite covers all format families, a 100-page PDF and page 87, password
correction and corrupted encrypted input, empty signature fields, formatting fallback,
archive expansion limits, shared cache/session races, scheduled revisions, nested navigation,
clipboard/print preparation, passive document rendering and floating-window state.
Browser cases exercise desktop and mobile layouts, both themes and the production CSP.
Queue previews assert the scan decision and unchanged revision/state, including blocked-file
download warnings. The warning-threshold setting is tested across saving, cancellation and reload.
A separate real-backend browser gate uses authenticated multipart processing and Redis,
not mocked decryption. Native-image smoke checks run on both publication architectures.
Synthetic PKI fixtures cover valid, revoked, expired, untrusted, wrong-purpose and tampered
signatures; key material is generated in test memory. ClamAV integration also exercises clean
content, the standard harmless EICAR test file and blocked encrypted content. Browser-emulated Android Back is not a physical-device certification.

[Implementation plan and review](../design/attachment-preview.md) records the design decisions.
Older release notes are collected in [Archive](Archive.md).
