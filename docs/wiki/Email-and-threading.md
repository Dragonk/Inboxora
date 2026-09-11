# Email and threading

Inboxora's central feature is **real email threading**: a message and its replies are one
conversation, no matter which folder or account each copy lives in. This page explains how that
works in practice and what the rest of the mail side offers.

## Accounts, folders and the unified inbox

- Multiple IMAP/SMTP accounts can be added, edited, reordered, disabled and reconnected.
- Each account has a colour, a sender name, optional **aliases** (send-as addresses with their
  own Reply-To and signature) and an HTML **signature**.
- Folder roles (Sent, Drafts, Trash, Spam, Archive) are detected from IMAP special-use flags or
  set by hand per account.
- An account can be excluded from the **unified inbox** without being disabled. The unified
  inbox, unified search and unread totals follow that setting.
- Unread counts are kept per folder, per account and in total, and drive the browser tab title
  and the app badge.

## How conversations are built

Threading runs on the server, in three layers:

| Layer | Meaning |
| --- | --- |
| **Conversation** | The thread you see as one row. |
| **Logical message** | One real message, identified primarily by its RFC `Message-ID`. |
| **Physical copy** | The stored copy of a logical message in one folder of one account. |

A message is matched to a conversation in this order:

1. a strong provider thread identifier,
2. the `In-Reply-To` / `References` chain,
3. otherwise it starts a new conversation.

Unresolved references are re-checked later, so a reply that arrives before its parent still
joins the right thread.

Provider mapping differs by service:

- **Gmail** — `X-GM-THRID` is treated as a strong thread identifier.
- **Outlook / Microsoft 365** — `Thread-Index` is decoded to its conversation root and used as a
  non-strong identifier.
- **Generic IMAP** — server thread identifiers are kept as metadata and never decide grouping
  on their own.

Two rules matter when you read your mail:

- **Your account is the identity boundary.** The same message delivered to two of your accounts
  forms two conversations; the unified inbox shows two rows.
- **Copies in several folders are one message.** A reply you filed in Archive and kept in the
  inbox is one logical message with two physical copies.

When automatic grouping gets it wrong, you can override it: merge conversations, split one
message (optionally with its replies) into its own conversation, move a message to another
conversation, or lock a conversation so it is never regrouped. **Threading diagnostics** show
why a message was grouped as it was, and an administrator can run a dry-run rebuild per
account.

## The threaded list

**Group messages into conversations** turns a conversation into a single list row showing the
subject, the participant count and the newest message. Tapping the row's count expands the
individual messages inline; each child row can be selected on its own. Selecting a parent row
opens the newest message.

## The conversation reader

**Conversation reader** changes the reading pane so the whole conversation is shown rather than
one message:

![Conversation reader](https://raw.githubusercontent.com/Dragonk/Inboxora/main/media/screenshots/mail-conversation-desktop.png)

- The newest message is expanded and the pane scrolls to it, as long as you have not started
  scrolling yourself.
- Collapsed messages show sender, time and a snippet; expanding one loads its body lazily.
- Quoted reply history is folded behind **Show quoted text**, and collapses again when you hide
  it.
- Actions such as star, read, archive, move and delete apply to the **selected physical copy**,
  with a scope choice where it matters: this copy, all copies of the message, copies on this
  account, or the whole conversation.
- Opening a conversation marks only the copy you opened as read.
- The message details view also tells you which copy is being shown (`Copy used: <folder>
  (<account>)`).

The list and reader preferences are independent: you can have a flat list with a conversation
reader, or a threaded list that opens single messages.

| Threaded list on a phone | Conversation reader on a phone |
| --- | --- |
| ![Threaded list on a phone](https://raw.githubusercontent.com/Dragonk/Inboxora/main/media/screenshots/mail-threaded-list-mobile.png) | ![Conversation reader on a phone](https://raw.githubusercontent.com/Dragonk/Inboxora/main/media/screenshots/mail-conversation-mobile.png) |

## Reading mail safely

- HTML is rendered in a sandboxed frame without scripts, and it is sanitised both when it is
  stored and when it is displayed.
- **Remote images are blocked by default**, including tracking pixels. Load them for one
  message, allow the sender's address, allow the whole domain, or manage the global allow-list
  under **Settings → Privacy**.
- Attachments download individually or together as a ZIP; inline images referenced by `cid:`
  render inside the body.
- A **headers viewer** shows the raw message headers, and **in-message find** searches the
  current message.
- Links open in a new tab and are limited to `https:` and `mailto:`.

## Composing, replying and sending

![Composer](https://raw.githubusercontent.com/Dragonk/Inboxora/main/media/screenshots/mail-composer-desktop.png)

- New messages, **Reply**, **Reply All** and **Forward**, with the default reply behaviour
  configurable. Replies set the correct `In-Reply-To` and `References` headers so other clients
  thread them too.
- Rich text or plain text, per your compose preference. Rich text supports formatting, lists,
  links, tables and images.
- To, Cc and Bcc with per-address copy, plus header-injection validation.
- Attachments and inline images, with a combined size limit; the composer warns when the body
  mentions an attachment but none is attached, and asks for confirmation when the subject is
  empty.
- Drafts autosave to the account's IMAP **Drafts** folder. Attachments are **not** stored in
  drafts, and the interface says so.
- Sending is idempotent: a retry after a lost response returns the first result instead of
  sending twice. If the message was delivered but the copy could not be saved to the Sent
  folder, Inboxora says *Sent, but not saved to your Sent folder* rather than reporting a
  failure that would invite a duplicate.
- There is no scheduled send, no undo-send delay and no per-user send quota.

## Organising mail

- **Folders** — create, rename, delete, empty, hide and reorder per account, with unread counts.
- **Actions** — star, read/unread, archive, delete, move, mark as spam or not spam, in bulk
  where a selection exists. Delete and archive show an undo window before the change is
  committed.
- **Snooze** — 3 hours, tomorrow morning, next week or a custom time. The message is parked in a
  `Snoozed` folder and returns to its original folder, unread, when the time is up.
- **Rules** — per-user and ordered, with conditions on sender, recipient, subject, body, an
  arbitrary header, attachments and read state, and actions such as mark read, star, archive,
  move, trash and forward. Rules run on incoming mail and can be applied to the existing inbox.
- **Block list** — exact addresses that go straight to Trash as they arrive.
- **Spam** — handled manually: *Mark as Spam* moves a message to the junk folder, *Mark as Not
  Spam* moves it back. There is no automatic classifier.
- **Unsubscribe** — when a message advertises `List-Unsubscribe`, the reader offers one-click
  unsubscribe and can move the message to Trash.
- **Categories** — optional inbox tabs (Primary, Newsletters, Promotions, Automated, Social)
  computed from message headers. Off by default, enabled per account.
- **GTD / Triage** — an optional plugin adding Todo, Watch, Delegated, Someday and Reference
  states with an undo for the last classification.

## Search

Search runs over a PostgreSQL full-text index and covers every account in the unified inbox.
Supported operators include:

| Operator | Example |
| --- | --- |
| `from:` / `to:` | `from:anna@example.test` |
| `subject:` | `subject:invoice` |
| `has:attachment` | `has:attachment report` |
| `is:unread` / `is:read` / `is:starred` | `is:unread` |
| `after:` / `before:` | `after:2026-01-01` |
| `in:<folder>` | `in:Archive` |
| `-` negation and quoted values | `-"newsletter"` |

## Live updates and notifications

- Each account keeps a persistent IMAP connection in IDLE, so new mail and flag changes arrive
  without polling. On mail servers with connection limits, the operator can cap always-on
  connections with `IMAP_MAX_PERSISTENT_PER_HOST`.
- A WebSocket streams new messages, flag changes, folder updates, sync completion and errors to
  the open app, reconnecting on its own.
- **Web Push** notifies installed apps and phones about new inbox mail; it requires the VAPID
  keys described in [Installation](Installation.md). Messages silenced by a rule do not
  notify.
- The notification sound is configurable, and you can upload your own.

## Extras

- **Command palette** for jumping to accounts, composing, opening settings and switching theme.
- **Keyboard shortcuts** for navigation, actions and composing, all rebindable.
- Optional **AI assistant** for summarising a message, drafting or improving replies, and
  user-defined AI actions.
- Optional **Todoist** integration for turning a message into a task.
- A redacted **diagnostics report** you can attach to a bug report.
