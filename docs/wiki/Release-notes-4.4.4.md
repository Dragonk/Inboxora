# Inboxora 4.4.4

Released **2026-10-21**.

[Downloads](https://github.com/Dragonk/Inboxora/releases/tag/v4.4.4) -
[Changelog](https://github.com/Dragonk/Inboxora/blob/v4.4.4/docs/CHANGELOG.md) -
[Upgrading](Upgrading.md#upgrading-to-444)

## Draft lifecycle: a draft never survives the message it becomes

The draft lifecycle is repaired so that composing an email leaves exactly one draft while
writing and none after sending - across Gmail, Microsoft Graph and IMAP/SMTP accounts.

The motivating report: composing one email on a Gmail account produced nine "versions" in
the Drafts list, and the draft did not disappear after the message was sent.

## Fixed

- **Draft "versions" multiplying in the Drafts list (Gmail).** Gmail mints a new provider
  message id for every save of a draft; the local row mirroring the previous id was left in
  place, so every autosave added another visible "version" of the same single Gmail draft.
  The superseded local row is now removed with the save that replaces it.
- **Duplicate drafts leaking at Gmail.** The `drafts.list` read that resolves a draft id
  is eventually consistent: a draft saved moments earlier can be missing from the listing,
  so the save created a second provider draft while the first survived at Gmail. The lookup
  is now retried before that conclusion is drawn, and a lookup that still missed is retried
  again after the save, so the superseded provider draft is found and removed.
- **Drafts surviving the send.** Draft removal was the client's fire-and-forget delete - a
  path MCP sends never had - and a delete that could not confirm the draft's identity
  dropped the local row anyway, letting the next sync resurrect the provider draft. A
  delivered send now consumes the superseded draft server-side (the provider object first,
  then the local rows); the MCP send tools (`send_email`, replies, forward) accept a
  `draftMessageId` naming the draft the send replaces and consume it after delivery; and
  an unconfirmable draft delete retains the local row for the sync to reconcile.

## Known safe limitations

- A Gmail draft whose identity survives all retries without confirmation is deliberately
  retained (locally and at the provider); the next sync reconciles it rather than the send
  guessing which provider object to remove.
- IMAP draft consumption only removes a draft whose identity the folder's stored
  UIDVALIDITY confirms; an unconfirmed identity is never expunged.

## Validation

- Backend: typecheck, lint, the full test suite (4359 passed) and the build passed.
  New suites cover the Gmail draft route (in-place update with superseded-row removal, the
  late-lookup leak cleanup, the delete paths with identity retention), the draft
  consumption service (Gmail/Graph/IMAP, confirmed and unconfirmed identities,
  deduplication, non-fatal failures) and the bounded-retry `drafts.list` lookup.
- Frontend: the full test suite (3969 passed), typecheck, lint and build passed; the i18n
  suite passed. No frontend change was needed - the composer already sends the draft
  identity with the send, which the backend now consumes.
