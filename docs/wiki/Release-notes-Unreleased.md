# Development changes — unreleased

These changes follow [4.2.0](Release-notes-4.2.0.md) and are intended for the `dev` test images.
They do not change the released version number or the `latest` image tags.

## Attachment previews

Click an attachment to read it inside Inboxora instead of immediately downloading it. The
full-screen reader supports Escape, a close button and Android Back. Downloads remain on
an independent attachment-chip button and in the reader toolbar, with dangerous-file
confirmation preserved. Queue attachments use their exact scheduled-message revision and
previewing them does not pause, edit or send the queued message.

Image attachments have lazy 48-pixel thumbnails, zoom, rotation, fit and an image-only gallery.
Desktop previews can move into the existing floating-window layer, including minimize,
restore and independent navigation. Phones keep the touch-first preview and Back navigation
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
| ZIP | Directory listing without eagerly expanding entries; the selected entry opens in the same viewer, including nested ZIP/PDF/Office files. |
| Media | Native audio/video controls without autoplay. Unsupported codecs retain a download option. |
| HTML / EML | Sanitized, no-script, network-blocked message frame. EML exposes safe headers/body and individually downloadable inner attachments. |
| ICS / VCF | Multiple event/contact cards with explicit selection and import into an owned writable local collection. Existing UID and invitation-ownership protections remain. |

PPTX, DOC, PPT, ODT, ODP and macro-enabled Office formats remain download-only. PPTX was not
admitted because the proposed renderer's distribution metadata and author terms conflict;
no third-party presentation service or LibreOffice conversion service was introduced.
Encrypted ZIP entries and unsupported Office encryption variants are also download-only.
Formatting is a passive approximation, not an Office editing or layout-compatibility promise.

### Passwords and signatures

PDF passwords are handled by the local PDF worker and never sent to the server. Supported
Office encryption is probed and unlocked by disposable server workers, including Agile and
Standard OOXML and supported legacy XLS variants. Bad passwords, unsupported encryption,
corrupt input and resource limits have distinct responses. Agile integrity is checked before
returning decrypted bytes; a correct password does not make a corrupted document acceptable.

PDF signature fields and available signer/date/reason metadata are informational. Empty
signature fields are not proof of a signature, and Inboxora does **not** cryptographically
verify signatures, certificate trust, timestamps or document modifications.

### Safety and resource limits

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
15-second worker deadline. Workers have bounded JavaScript heap/stack settings; these are not
an operating-system-wide memory quota. Redis limits processing to 30 requests/user/minute,
60/IP/minute and 10 unlock attempts/user/minute. Admission fails closed when Redis is unavailable.

DOCX conversion uses a detached document with no browsing context, removes external
relationships before conversion, and sanitizes the final output in the existing frame pipeline.
HTML/EML cannot automatically load even same-origin resources. SVG and Mermaid reject active
content, remote image references and configuration overrides. PDF and parsing workers, fonts
and CMaps are bundled locally; there are no runtime CDN or document-service requests.

## Operator notes

Deploy matching frontend and backend development images together. No schema migration, new
service, credential or administrator setting is required. The existing Redis is used for rate
limits, and the existing Node 22 backend requirement remains.

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
A separate real-backend browser gate uses authenticated multipart processing and Redis,
not mocked decryption. Browser-emulated Android Back is not a physical-device certification.

[Implementation plan and review](../design/attachment-preview.md) records the design decisions.
Older release notes are collected in [Archive](Archive.md).
