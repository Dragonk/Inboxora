# Inboxora 4.3.0

Released **2026-10-03**.

[Downloads](https://github.com/Dragonk/Inboxora/releases/tag/v4.3.0) ·
[Changelog](https://github.com/Dragonk/Inboxora/blob/v4.3.0/docs/CHANGELOG.md) ·
[Upgrading](Upgrading.md#upgrading-to-430)

Inboxora 4.3.0 is a feature release centered on two large additions: a native **Model Context
Protocol (MCP)** integration for external AI applications and a secure **attachment preview
system**. It also adds per-alias default CC/BCC recipients and a set of search,
provider-compatibility and database-query improvements.

## Highlights

- **Native MCP server for external AI clients.** Inboxora can expose scoped mail, calendar and
  contact tools over Streamable HTTP, with OAuth/PKCE or revocable personal tokens, per-client
  resource grants and browser approval for writes.
- **Attachment previews inside Inboxora.** PDF, images, documents, spreadsheets, text, archives,
  media, HTML/EML, ICS and VCF can be opened without first downloading them. The same preview
  surface is available from messages, scheduled mail and the composer.
- **Safer document handling.** Preview work is bounded, isolated and session-scoped. PDF signature
  inspection uses authenticated EU Trusted Lists by default, and an optional private ClamAV
  service can block unsafe or unscannable previews.
- **Per-alias default CC/BCC.** Each sender alias can inherit account defaults or override them
  independently, including explicitly empty lists.
- **Faster large-mailbox operations.** Several N+1 query paths were replaced with bulk operations,
  including scheduled-message recipients, physical message moves, conversation evidence,
  archive work, contact backfill and unresolved message references.

## External AI applications (MCP)

Inboxora now includes a native **Streamable HTTP MCP endpoint at `/mcp`**. It is independent of
the built-in AI provider configuration and does not expose generic SQL or arbitrary HTTP tools.

MCP is **disabled by default**. Enable it on the backend with `MCP_ENABLED=true`, keep `APP_URL`
set to the public HTTPS origin and use the normal persistent `ENCRYPTION_KEY`. The supplied
reverse-proxy configuration routes `/mcp`, OAuth metadata and authorization endpoints, and rejects
MCP credentials on a cleartext internal hop unless the trusted TLS proxy forwards
`X-Forwarded-Proto: https`.

Users configure connections under **Settings → AI Features → External AI integrations (MCP)**.
Each connection has its own expiration, scopes and allowed resources. Mail accounts/folders,
calendars and address books can be limited independently. A connection can be edited or revoked
without changing provider credentials.

Supported authorization modes include:

- OAuth authorization code with S256 PKCE;
- dynamic client registration for compatible clients;
- rotating refresh tokens and revocation;
- revocable personal access tokens for clients that do not support OAuth.

The server includes domain-specific tools for mail and folder discovery, search, bounded attachment
reads, drafts and composition, message organization, calendars and availability, invitations,
contacts, capabilities and durable operation receipts.

Read and write permissions are separate. Resource restrictions are checked again at execution
time, so a token cannot keep using a resource that was removed from its grant.

### Human approval for writes

MCP mutations use stable request IDs and durable receipts. With approval enabled, Inboxora creates
a pending operation and returns a browser URL. The user signs in and reviews the exact resolved
operation before approving or denying it.

Outgoing mail uses the normal Inboxora message/composer surface: sender, To/CC/BCC, subject, rich
body, signature and attachments are visible. The user can edit recipients, subject, body,
signature and attachments before approval. Every edit is revalidated and re-prepared on the
server. Clicking **Approve** executes that frozen version immediately; clicking **Deny** sends
nothing. The AI client can only read the resulting receipt and cannot approve the operation itself.

This design prevents a retry with the same request ID from becoming a second send. Unknown provider
outcomes stay uncertain rather than being retried automatically.

### Search behavior

UI and MCP now share the same query parser and provider-backed search path. Gmail, Microsoft Graph
and IMAP can supplement the local cache for older or not-yet-downloaded messages. Provider hits are
rechecked against current ownership, folder membership and filters before pagination.

Slow providers no longer make an ordinary next page look like a failed search. The result separates
normal pagination from incomplete coverage and reports partial/provider-error state explicitly.
The UI retries bounded provider work instead of immediately showing a false empty result.

See **[External AI applications (MCP)](MCP.md)** for setup, proxy requirements, scopes, client
examples, approval semantics, search limits and troubleshooting.

## Attachment previews

Clicking an attachment now opens an Inboxora reader instead of forcing an immediate download.
Downloads remain a separate action. The reader is used from normal messages, scheduled messages and
composer attachments; scheduled-message previewing never pauses or changes delivery.

| Family | Preview behavior |
| --- | --- |
| Images | PNG, JPEG, GIF, WebP, AVIF, BMP, sanitized SVG and first-page TIFF, with lazy thumbnails, zoom, rotation and gallery navigation. |
| PDF | Lazy continuous pages, selectable text, outline/thumbnails, literal search, page navigation, 50–400% zoom, fit modes, rotation, printing, password prompts and signature details. |
| Office | DOCX plus XLSX/XLS/ODS. Formatting is sanitized; spreadsheet formulas/macros never execute. |
| Text | Markdown/Mermaid, JSON/JSONC, XML, CSV/TSV and common text/code formats with decoding selection and search. |
| Archives | ZIP plus bounded 7z, RAR4/RAR5, TAR, GZIP, BZIP2, XZ and Zstandard browsing. Selected entries reuse the normal viewers. |
| Media | Native audio/video controls without autoplay. |
| HTML / EML | Sanitized, script-free, network-blocked rendering; EML exposes safe headers/body and inner attachments. |
| ICS / VCF | Selectable event/contact cards with import into writable local collections. |

PPTX, DOC, PPT, ODT, ODP, macro-enabled Office files, encrypted ZIP entries and unsupported Office
encryption variants remain download-only. Preview support is intentionally not an editing or exact
layout-compatibility promise.

### PDF signatures and trust

The PDF signature dialog separates byte integrity, certificate path, validity, revocation evidence
and timestamp information. A visible signature field is not automatically treated as valid.

Current-time validation uses pyHanko and authenticated **EU Trusted Lists** as the default document
trust source rather than the browser/TLS root store. Additional non-EU or private signing roots can
be supplied by the administrator. Missing trust or revocation evidence is reported as unavailable
rather than silently promoted to valid.

This is not a legal eIDAS qualification decision and not historical PAdES-LTV validation.

### Composer and attachment limits

Files can be dropped onto the message body. Inboxora checks whole-batch and sender/provider limits
before send. SMTP accounts can use the advertised `SIZE` limit; Gmail's raw-message and attachment
budgets are treated separately. A configurable warning threshold is available under Appearance.

Archive, document, image, workbook, EML and PDF processing has explicit entry, byte, page/cell,
time and concurrency limits. Client workers and server subprocesses are terminated when they exceed
their bounds. Unsupported or over-limit content keeps a download path instead of hanging the reader.

### Optional ClamAV

ClamAV remains optional. When configured, scanning is fail-closed for previews: known malware,
unavailable scanning, incomplete scanning or scanner-budget exhaustion blocks rendering and native
viewer actions. The original attachment is not rewritten or quarantined; a warned download remains
an explicit user choice.

Use the supplied ClamAV compose overlay or point Inboxora to a private `clamd`. Do not expose
clamd's unauthenticated port publicly.

## Per-alias default CC/BCC

Sender aliases can now override account-level default CC/BCC lists under
**General → Accounts → Aliases**.

By default an alias inherits the account values. Enabling the override gives the alias independent
lists. An explicitly empty CC or BCC override disables that automatic recipient type for the alias.

Switching identities updates only untouched automatic recipients. Manually added/removed recipients,
saved drafts and retry targets are preserved instead of being silently replaced.

## Reliability and performance fixes

4.3.0 also includes smaller fixes and database-path optimizations:

- replace N+1 inserts for scheduled-mail recipients with one bulk insert;
- batch physical message moves instead of querying each item separately;
- fetch conversation evidence in bulk with `UNNEST`;
- batch archive-row updates, rich-contact backfill and unresolved-message reference writes;
- remove an unnecessary intermediate map when matching IMAP thread IDs;
- keep provider-search coverage/error state accurate across retries and pagination;
- preserve draft attachments, priority, reply identity and sender signatures through MCP edits;
- require confirmed move/unsubscribe outcomes before reporting an MCP action as complete;
- fix Google AI-provider compatibility by removing the unsupported `think` field;
- stabilize signature editing and several preview/mobile/context-menu interactions.

## Upgrade requirements

Back up PostgreSQL and `.env`, then deploy matching 4.3.0 backend and frontend images together.

Normal startup applies two new additive migrations after the 4.2.0 chain:

- `0167_mcp_authorization.sql` — MCP clients, grants, tokens and durable approval/receipt state;
- `0168_alias_default_recipients.sql` — nullable per-alias default CC/BCC overrides.

No existing mail, calendar or contact data is reset. If MCP remains disabled, migration 0167 still
applies but the endpoint stays unavailable.

Existing installations do **not** need new provider consent or mailbox recreation. `MCP_ENABLED`
is the only new switch required to expose the MCP endpoint; leave it unset/false if external AI
access is not wanted.

Docker images now contain the preview runtime and its pinned native/Python dependencies. Optional
ClamAV remains a separate service.

Set `INBOXORA_VERSION=4.3.0` and follow [Upgrading](Upgrading.md#upgrading-to-430).

## Published artifacts

Stable container tags are:

- `ghcr.io/dragonk/inboxora-backend:4.3.0`
- `ghcr.io/dragonk/inboxora-frontend:4.3.0`

`v4.3.0` and `latest` point to the same multi-architecture AMD64/ARM64 manifests after publication.

The GitHub release also contains a Windows installer; Linux DEB/RPM packages for x64 and ARM64;
Android APK/AAB; and signed SHA-256 checksums. No macOS package is published.

## Known limitations

- MCP requires a correctly configured public HTTPS origin for hosted clients. Client plan/workspace
  policy can still prevent a connection even when Inboxora is configured correctly.
- MCP Streamable HTTP is stateless; clients that only support stdio or legacy HTTP+SSE need their
  own compatible bridge.
- Binary attachment reads through MCP are deliberately bounded; larger files are handled in Inboxora.
- Provider-backed search is bounded and can report partial coverage when a provider is slow,
  rate-limited or unavailable.
- Attachment previews prioritize safety and bounded resource use over accepting every file format.
  Unsupported formats remain downloadable.
- PDF signature validation reports the current cryptographic/trust evidence; it is not a legal
  certification of the document or signer.

Older release notes are available in [Archive](Archive.md).
