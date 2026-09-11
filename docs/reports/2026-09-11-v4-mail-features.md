# Inboxora — Mail Feature Inventory (v4)

Source material for the README and GitHub Wiki, covering the mail side only. Every statement was read from the code on branch `dev` at the revision this file was written against; the app was not run. Configuration requirements are noted per item, and anything experimental or opt-in is marked.

## 1. Email accounts and providers

- Users can add, edit, delete, reorder, disable and reconnect multiple accounts; each has a display name, sender name, email address and colour.
- Each account is an IMAP + SMTP pair (separate hosts, ports, TLS modes `none`/`STARTTLS`/`SSL`, credentials). Only `imap` is synced.
- The add-account form offers **Gmail**, **Yahoo Mail**, **iCloud** and **Custom** presets; the server additionally derives a capability profile from the IMAP host (google, yahoo, apple, microsoft, purelymail, generic) that tunes batching, IDLE use and body fetching.
- Mail is sent through the account's own SMTP credentials, encrypted at rest and dependent on the `ENCRYPTION_KEY` environment variable (losing it makes stored credentials unreadable). Optional separate SMTP credentials per account fall back to the IMAP ones when left blank.
- Host/port policy is admin-controlled: private/local targets, insecure TLS and non-standard ports are each gated (defaults IMAP 143/993, SMTP 465/587). Skipping TLS certificate verification is a per-account checkbox that also requires the admin policy.
- **Microsoft 365 / Outlook.com / Hotmail**: OAuth2 only, via an authorization-code flow or a device-code flow (device code suits personal accounts and needs no redirect URI). Requires an admin Azure app registration (`MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_TENANT_ID`, `MS_REDIRECT_URI`) under Settings → Integrations with delegated `IMAP.AccessAsUser.All`, `SMTP.Send`, `offline_access`, `openid`, `email`, `profile`. Tokens refresh automatically. Password-based IMAP is not offered for personal Microsoft accounts because Microsoft disabled basic auth.
- **Gmail / Google**: no OAuth mail route exists server-side, so Gmail is connected with an **app password** used as the IMAP/SMTP password (the field is labelled "Password / App password"). The transport recognises an `oauth_provider='google'` token if one is supplied through the accounts API, but the app offers no way to obtain one.
- Per-account **aliases** (send-as) carry a name, address, optional Reply-To and optional signature; they use the account's SMTP credentials, appear in the From field, and are auto-selected for a reply when the message was addressed to the alias.
- **Signatures** are per-account sanitised HTML, overridable per alias or for a single send. **Account colours** drive the sidebar swatch.
- **Unified inbox**: each account has an "Include in Unified Inbox" toggle governing All Inboxes, unified search, category counts and the total unread count; excluding an account never disables it.
- **Folder role mappings** per account (Sent, Drafts, Trash, Spam/Junk, Archive) can be set manually or left on Auto-detect, which uses IMAP special-use flags.
- Per-account actions: sync folders, reconnect, "re-index for search" with progress, and enable/disable inbox categorisation (off by default, with a global switch).

## 2. Real conversation threading (conversation engine, "CE v2")

- A server-side engine with three layers: **conversations** (a container per user and account), **logical messages** (one per real RFC message), and **physical copies** (the folder/UID `messages` rows). A conversation aggregates logical messages; a logical message aggregates its copies.
- A logical message is identified primarily by the normalised RFC `Message-ID` (validated, de-duplicated, case preserved); without one, identity falls back to a body + header fingerprint.
- Membership is decided in order by: a strong provider thread id → the RFC `In-Reply-To`/`References` parent chain (highest confidence) → a new root conversation. Unresolved `References` are queued and re-parented when the referenced message later arrives.
- **Provider mapping**: Gmail's `X-GM-THRID` is a strong thread id; Outlook's `Thread-Index` is base64-decoded to its 22-byte root hex and used as a non-strong provider thread; generic IMAP `THREADID`/`OBJECTID` values are metadata only and never select a conversation.
- Subject canonicalisation strips the reply prefixes `re`, `odp`, `aw`, `sv`, `vs`, `antw`, `ant`, `ref`, `rif`, `ynt`, `tr` (not `fwd`) with Unicode NFKC normalisation.
- **Account is the identity boundary**: the same `Message-ID` in two accounts becomes two logical messages and two conversations, so the unified inbox shows two rows.
- **Cross-folder copies** within one account are one logical message with several physical copies. List filters such as `folder=INBOX` are entry predicates only; aggregates and previews read the whole account-local graph.
- **Resolving a flat message to its conversation**: `GET /api/mail/messages/:ref/conversation` accepts a physical-copy UUID or a Message-ID, honours optional `accountId`, ignores deleted rows, prefers the INBOX copy, and returns `409 CONVERSATION_REFERENCE_AMBIGUOUS` unless the reference resolves to exactly one logical message/conversation.
- **Manual overrides** (per user) beat automatic grouping: merge conversations, split a logical message (optionally with replies), move it to another conversation, lock a conversation against re-grouping, unlock, and force-include or force-exclude a message. The most recent include/exclude and lock/unlock event wins; merges write a cycle-guarded alias resolved everywhere.
- A **threading diagnostics** view reports kind, confidence, logical-message and copy counts, parent message, threading reason and overrides. A **rebuild** endpoint re-runs grouping per account with dry-run mode (the default), a progress job id, a per-user rate limit and an audit record.
- Two per-user preferences are stored server-side (`conversation_list_view_enabled`, `conversation_reader_view_enabled`); the list preference surfaces as the threaded-list toggle, and the thread/reader endpoints are always mounted regardless of them.
- **Experimental, config-only**: `automated_series_mode` (`off` | `strict` | `smart`, default **off**) can segment automated mail such as newsletters and OTP/receipt bursts using DKIM/SPF/DMARC, sender/recipient equality, subject and References evidence. It has **no API route and no UI**.

## 3. The threaded list and the conversation reader

- Two **independent** toggles, both off by default: **"Group messages into conversations"** collapses a message and its replies into one list row (based on the native thread key) with inline expansion and thread-wide actions; **"Conversation reader"** opens the whole conversation in the reading pane instead of one message at a time.
- The reader merges the account-local native thread (`GET /api/mail/thread/:threadId`) with conversation-engine metadata so incomplete engine state cannot shrink it below the native thread, falling back to engine-only data when no native thread exists.
- Individual messages expand and collapse; the selected message is auto-expanded and the reader auto-scrolls to align it, abandoning alignment if the user scrolls, clicks or taps.
- **Quote folding** detects quoted reply text and folds it behind a "Show quoted text" / "Hide quoted text" control, shrinking the frame again when re-folded.
- Reader actions are **per physical copy**, with a scope choice where relevant: this copy, all copies of the message, copies on this account, or the whole conversation. Removed copies are dropped optimistically behind a delete guard.
- Opening a conversation marks only the selected physical copy read, and read writes are serialised per copy so a late automatic read cannot overwrite a newer explicit unread.
- The reader shows "Copy used: <folder> (<account>)" and can reveal message details and the subject.

## 4. Reading and rendering

- HTML bodies render in a **sandboxed iframe** (`sandbox="allow-same-origin"`, no scripts) with CSP `default-src 'none'`; inline styles are allowed and remote resources are not. Plain-text bodies render escaped in a preformatted block.
- HTML is sanitised twice — on the backend at storage/response time, and client-side with a policy forbidding `script`, `iframe`, `object`, `embed`, `form`, `video`, `audio`, `source`, `track` and inline event handlers. Links open in a new tab and only `https:` and `mailto:` are permitted.
- **Remote images are blocked by default**, tracking pixels included. The reader offers "Load images", "Always allow from <address>" and "Always allow from @<domain>"; Settings → Privacy holds a global block/unblock preference plus address and domain allow-lists. The unblocked HTML is never written back to the cache.
- **Attachments** list with filename and size, download individually or all at once as a ZIP, and inline `cid:` images are resolved to data URIs so they render in the body.
- A **full headers** viewer shows raw headers with a copy action; messages can also be printed, and an **in-message find** overlay provides match case plus previous/next navigation.
- Sender identity uses a contact photo, a Gravatar (opt-in, off by default) or a sender favicon from Twenty Icons (admin toggle; only the sender's domain is sent). Mobile sender avatars are separately toggleable.
- Reader layout is configurable: five layouts (**Focused**, **Compact**, **Comfortable**, **Wide**, **Vertical split**), interface density, font-size scaling, font pairings, custom CSS (admin) and multiple themes. A **dark theme** ships and is the default when no light theme has been chosen, following the OS `prefers-color-scheme` on first use.
- Message-list options: unread-only filter, paginated or infinite scrolling with page size, message previews on/off, quick actions on hover, sync frequency, folder-list sync frequency, and configurable left/right **swipe actions** (star, archive, delete, mark read, reply, reply all, disabled).
- **Mobile**: layouts switch below 767 px, with swipe rows, pull-to-sync, a mobile module header, a floating compose action, top or bottom navigation position, and swipe/button back navigation.
- A message can be opened in a **detached window** that moves, resizes, minimises and closes independently of the main layout.

## 5. Composing and sending

- The composer supports new messages, **Reply**, **Reply All** and **Forward**, with the default Reply button behaviour configurable (reply vs reply-all). Replies set `In-Reply-To` and append to `References`; forwards build a quoted "Forwarded message" block and carry the original's file attachments.
- Recipient fields To / Cc / Bcc, per-address copy and "copy all in this field"; recipients and single-line headers are validated against header injection.
- **Rich text or plain text** per the user's compose-format preference. Rich text supports bold, italic, underline, strikethrough, lists, text colour, highlight, links, tables, images and clear-formatting.
- **Attachments**: up to 100 uploaded and 100 forwarded files, with a combined 25 MiB cap across uploaded, inline and forwarded content, checked against both declared and actually fetched sizes. Oversized requests are rejected with a clear message rather than failing mid-send.
- **Inline images** (`data:` URIs) become proper `cid:` attachments with `Content-Disposition: inline`; plain-text mode disables this.
- Guard rails: a **forgotten-attachment** prompt when the body mentions an attachment but none is attached, and an **empty-subject** confirmation before sending.
- **Drafts** save to the account's IMAP Drafts folder (role-mapped or `\Drafts`) and auto-save while composing; the composer can save or discard manually and asks what to do when closed with unsaved content. **File attachments are not stored in drafts**, which the UI warns about.
- **Signatures** are inserted from the account/alias and can be edited for one send.
- **Send reliability**: the endpoint takes an idempotency key so a retry after a lost response returns the cached result instead of sending twice, and a concurrent duplicate is rejected with 409. The key lives in Redis, so **Redis is required for sending** (503 otherwise). Connection attempts fall back across the validated IP addresses of the SMTP host within a 45-second budget, and SMTP, authentication, rate-limit, rejection and TLS errors are mapped to non-technical messages.
- **Sent-folder handling**: the exact MIME is appended to the resolved Sent folder; Gmail and Microsoft OAuth accounts are polled for the server's own copy (3 s / 10 s / 20 s) and appended only once if conclusively absent, avoiding duplicates. If delivery succeeded but the Sent copy could not be stored, the UI reports "Sent, but not saved to your Sent folder" instead of a failure that would invite a duplicate send. Successful sends file a local Sent row, sync the folder and offer a "View" action on the toast.
- Message **priority** (high / normal / low) can be set, and recipients of sent mail are added to the address book to improve autocomplete.
- **Not implemented**: no **scheduled send / send-later**, no **undo-send delay** (mail goes to SMTP immediately), and no **per-user send quota or rate limit** beyond what the SMTP server enforces.
- Separately, an admin-only **system email** account sends invites, verification codes and other application mail; it is unrelated to user composing.

## 6. Organisation and actions

- **Folders**: per-account list with unread counts, create, create subfolder, rename, delete, empty, hide/unhide, mark all read, sync now, favourite/recent shortcuts in the move menu, and folder search when moving. Folders created elsewhere arrive on the folder-sync interval.
- **Actions**: star/unstar, mark read/unread, archive, delete (to Trash; drafts and already-trashed mail are permanently deleted), move to folder, mark all read in a folder, empty folder, and mark as spam / not spam. Bulk variants use a selection with select-all/deselect-all; moving a cross-account selection is refused with an explanation.
- **Archive** requires a configured archive folder; otherwise the UI points at Folder Mappings. Gmail's All Mail is understood as the archive target.
- **Snooze**: in 3 hours, tomorrow morning, next week or a custom time. The message (and its header reply chain) moves to a `Snoozed` folder created on demand; an in-process watcher wakes it every 60 seconds, restores it to its original folder and marks it **unread**. Snooze requires an RFC `Message-ID` and accepts at most 30 days ahead.
- **Rules**: per-user, optionally restricted to one account, ordered and reorderable. Conditions on From, To, Subject, Body, an arbitrary header (plus header name), has-attachment and read status, with contains / does-not-contain / is-exactly / starts-with / ends-with / regex operators, AND/OR logic and a stop-processing flag. Actions: mark read, star, archive, move to folder, move to trash, forward to one address. Rules run server-side on incoming INBOX mail during sync, and can be run manually over existing inbox mail in batches with a matched/processed count. Body conditions need an already-downloaded body; there is **no label or block action**, and rules do not run on non-INBOX folders.
- **Block list**: per-user, exact email address (not domain). Matching mail is moved to Trash as it arrives; it is not retroactive and does not mark mail as spam.
- **Spam handling is manual only** — no automatic classifier ships. "Mark as Spam" moves a message to the resolved junk folder and "Mark as Not Spam" moves it back to the inbox; the junk folder resolves from the folder mapping, then `\Junk`, then common junk folder names.
- **Unsubscribe**: when a message advertises `List-Unsubscribe`, the reader offers one-click unsubscribe (RFC 8058 POST), a mailto or a link, and can move the message to Trash afterwards.
- **Search** runs entirely in PostgreSQL (no IMAP or provider search for user queries) over a full-text index, with operators `from:`, `to:`, `subject:`, `has:attachment`, `is:unread|read|starred`, `after:`, `before:`, `in:<folder>`, leading `-` negation, quoted values and free terms. Unified search spans all unified-inbox accounts. It is rate-limited to 20 searches per minute per user, results are capped, and contact autocomplete is a separate endpoint.
- **Categories** (Primary, Newsletters, Promotions, Automated, Social) are heuristic inbox tabs computed from headers at sync time. Categorisation is **opt-in per account** (off by default) with a global switch; Social sources can be tuned with manual domains, built-in domain sets and URL-subscribed lists, and existing mail can be re-categorised. A manual "Classify with AI" action exists for uncategorised mail when AI is configured.
- **GTD / Triage** is an **opt-in plugin** (see §8) adding Todo, Watch, Delegated, Someday and Reference states, with Watch + Delegated shown merged as "Waiting". A state is applied as a labelled folder copy, the last classification can be undone, and "mark done" marks the thread read, strips the labels and archives the inbox copy. Classified mail cleared by a reply is removed automatically, and an inbox-zero pet is part of the plugin.
- **Undo** for delete, archive and move is **client-side only**: the action is shown optimistically with a roughly 4.5-second window while the server commit is delayed. The only server-side undo is the GTD classification undo.
- **Unread counts** refresh per account, per folder and in total (the INBOX total is computed live from the messages table), feed the category tab counts, and adjust optimistically before the server confirms with rollback on failure. The count also drives the browser tab title, the PWA app-icon badge and the native badge.

## 7. Live updates and notifications

- Each account normally holds one **persistent IMAP connection in IDLE**, so new mail is pushed rather than polled. Provider profiles decide whether IDLE is used and whether flag changes are pushed or polled; `IMAP_MAX_PERSISTENT_PER_HOST` caps always-on connections on limited servers, with the remainder falling back to poll-only sync.
- A per-user **WebSocket** streams `new_messages`, `message_flags`, `folder_updated`, `sync_complete`, `folders_synced`, `snooze_wakeup`, `account_error`, backfill progress and plugin events. It reconnects with exponential backoff and jitter, detects and drops half-open sockets, and refreshes list and counts after any reconnect; with the socket closed the client falls back to periodic refreshes.
- **Web Push** works for installed/PWA and mobile clients and **requires a VAPID key pair** (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, optional `VAPID_SUBJECT`). Only new INBOX mail not silenced by a rule triggers a push; delivery uses high urgency, a 24-hour TTL and up to three attempts for transient/429/5xx failures, prunes expired subscriptions and deep-links to the message. On iOS the UI explains that the app must be added to the Home Screen first.
- **Notification sound** is selectable, including an uploaded audio file under 2 MB, with a "None" option; the app-icon unread badge is toggleable. Mail that a rule marks read is deliberately silenced — no sound, toast or push.

## 8. Other user-visible mail surfaces

- **Command palette** for compose, go to inbox, open settings, open themes, switch theme and jump to a specific account's inbox.
- **Keyboard shortcuts** for next/previous, open, go to inbox, reply, reply all, forward, archive, delete, star, toggle read, select, print, compose, focus search, shortcut help, toggle the right sidebar, plus GTD classify and GTD undo — all user-reassignable with conflict reporting and reset-to-default.
- **Todoist integration**: create a task from a message with title, description, project, labels, priority and due date, using a personal Todoist API token.
- **AI features** (any OpenAI-compatible provider, admin-configured, each feature toggleable): one-click message summarisation, composer assistance (write draft, improve, shorten, fix grammar), and user-defined AI actions applied to a message's content. GTD also lazily generates one-line gists for waiting items when a provider is configured.
- **Calendar invitations** received by mail render as an in-message card with "Add to calendar" and show cancellation state.
- **Diagnostics**: a shareable, value-redacted report covering versions, environment, per-account and folder counts, sync error categories and server health.

## 9. Configuration requirements (mail side)

- Required secrets: `SESSION_SECRET`, `DB_PASSWORD` and `ENCRYPTION_KEY` (which encrypts stored mail credentials and OAuth tokens); `APP_URL` is required in production.
- PostgreSQL is the sole persistent store for messages, folders, rules, block list, labels, snooze records, spam logs, full-text search and the conversation engine, and is bundled by default.
- Redis is required in practice (session store, rate limiting, favicon cache) and is **required for send idempotency** — without it the send endpoint returns 503.
- Per account: IMAP and SMTP hosts/ports/TLS and credentials, or Microsoft OAuth, which additionally requires the admin Azure app registration. Web Push requires the VAPID key pair; optional Let's Encrypt TLS requires `DOMAIN` and `ACME_EMAIL`.
- There is **no external cron or worker process**: mail sync, snooze wake-up and plugin ticks are all in-process timers.

## 10. Not verified / uncertain

- The app was not run and no tests were executed; all statements come from source, so runtime behaviour, performance on very large mailboxes and real-provider quirks are unconfirmed.
- `ensureConversationFeatureDefaults` and `conversationViewEnabled` look like unused production exports; whether a server-side conversation-list setting is enforced anywhere, and how it relates to the client threaded-list toggle (which reads `localStorage`), could not be confirmed.
- `automated_series_mode` (strict/smart) has no UI or API and is therefore unreachable by a normal deployment; whether any migration or operator tooling sets it was not confirmed.
- Google mail OAuth is recognised by the transport but has no route or UI; whether any other code path can populate a Google token is unverified.
- The exact snooze preset times ("tomorrow morning", "next week") are defined in the client and their precise hours were not traced.
- The experimental `VITE_EMAIL_DIV_RENDER` div-based renderer exists behind an environment flag; whether it is still functional was not verified.
- The backend enforces remote-image blocking for conversation bodies via an opt-in request header; whether every client path sends it consistently was not traced end to end.
- A "Important" folder label exists in the translation catalogue but no matching backend route or action was found, so it is likely unused.
- Whether detached message windows and some mobile gestures are available on every platform (browser, PWA, native shell) was not verified, and neither large-file attachment downloads nor the ZIP-all endpoint's memory behaviour were measured.
