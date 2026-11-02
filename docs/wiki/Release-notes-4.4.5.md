# Inboxora 4.4.5

Released **2026-11-02**.

[Downloads](https://github.com/Dragonk/Inboxora/releases/tag/v4.4.5) -
[Changelog](https://github.com/Dragonk/Inboxora/blob/v4.4.5/docs/CHANGELOG.md) -
[Upgrading](Upgrading.md#upgrading-to-445)

## Draft identity and ghost messages

Two stubborn bugs are fixed: drafts on Gmail accounts still multiplied while
composing, and a message that no longer exists at the provider (a "ghost") could
not be moved, trained as spam or deleted from Inboxora at all.

## Fixed

- **Draft "versions" still multiplying in the Drafts list (Gmail).** Gmail mints
  draft ids that exceed JavaScript's safe-integer range (63-bit integers,
  ~9.1e18), so the draft-identity check rejected the id of the very draft it was
  resuming and every autosave created a new provider draft instead of updating
  the existing one. Draft ids are now carried and compared as strings
  end-to-end, so an autosave resolves to the draft it is continuing.
- **Drafts that could not be deleted.** The draft delete route read the uid with
  `parseInt`, which silently rounds ids beyond the safe-integer range, so the
  identity of the draft being deleted could never be confirmed and the delete
  always failed with 409. The route now reads the uid without narrowing its
  precision.
- **Drafts surviving a send composed in the app.** The composer did not include
  the draft identity in the send request, so the server-side draft consumption
  shipped in 4.4.4 never ran for sends made from the compose dialog - only MCP
  sends carried the identity. The composer now includes the draft identity on
  send, scheduled send and merge, so the superseded draft is consumed after
  delivery.
- **Ghost messages that could not be moved, trained as spam or deleted.** A
  message that no longer exists at the provider (already removed server-side)
  made every Inboxora action on it fail with 409/502 and left the undeletable
  row in the list. Delete, spam-move and bulk moves now recognise "gone at the
  provider" as a success case: the provider call confirms the message is gone,
  the local row is removed, folder counts are adjusted and the client is
  notified, so the ghost disappears with the action instead of blocking it. A
  bulk move that meets ghosts reports them as moved rather than failed, so the
  client no longer restores them into the source list.
- **Mover failures conflated with vanished messages.** A folder or label that
  could not be resolved was reported as `RESOURCE_NOT_FOUND` - the same code a
  missing message returns - so a misconfigured destination could be mistaken for
  a message gone at the provider. Destination resolution failures now report
  `DESTINATION_NOT_FOUND`, distinct from the message-gone case the ghost
  cleanup keys on.

## Security

- Production dependencies were patched for advisories published since 4.4.4:
  frontend `dompurify` (critical - DOMPurify template bypass, IN_PLACE hook
  arming, SMIL href guard skip in XHTML mode) and backend `body-parser`,
  `deepmerge`, `fast-uri` and `zod`. Both CI audit gates pass at
  `--audit-level=high` again.

## Known safe limitations

- Marking a ghost as read or flagging it remains best-effort (the asynchronous
  Graph tombstone path is unchanged); a ghost that resists these actions can be
  removed with delete or a move to spam, both of which are now decisive.
- Bulk archive keeps its existing failure reporting; only delete, spam-move and
  bulk move gained ghost cleanup in this release.
- Ghost cleanup removes the local row only after the provider call itself
  confirms the message no longer exists there; a provider error other than
  "not found" still fails the action, never silently drops the row.

## Validation

- Backend: typecheck, lint, the full test suite (4366 passed) and the build passed. New and updated
  suites cover the string-uid draft route (including ids beyond the
  safe-integer range and their rejection when malformed), the Graph delete and
  spam paths meeting a vanished message (success, row removal, no spam training
  on a ghost), bulk moves over ghosts, and the `DESTINATION_NOT_FOUND`
  distinction.
- Frontend: the full test suite (3969 passed), typecheck, lint, build and the i18n
  suite (2699 passed) passed. The composer change is covered by the existing
  send-path tests.
