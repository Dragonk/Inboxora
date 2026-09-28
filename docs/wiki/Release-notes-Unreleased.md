# Development changes — unreleased

These changes are on the development branch for pre-merge testing. They are **not part of the published 4.1.2 release**; a release version has not been assigned.

## Sender addresses and automatic From selection (#9)

In Settings → Accounts → the account menu → Aliases, the Sender addresses view always includes the primary mailbox address. It cannot be deleted from this view. The radio buttons select exactly one default sender for new messages, independently for each account. Existing aliases keep their display name, Reply-To and signature settings, and can still be edited or removed.

New messages and forwards start with the selected default. The From menu still permits an explicit primary address or another configured alias. The default is a compose-time preference, not an instruction to rewrite an already open message: changing settings or refreshing the account list does not replace a manual selection or a saved draft identity.

Replies and Reply All first select a configured alias from ordered delivery metadata, then match To and Cc identities. A primary mailbox address in delivery metadata is considered only after those matches: forwarded mail can contain both the final primary destination and an originally contacted alias, and the latter must not be hidden. The primary address participates in visible recipient matching, so a Cc alias does not override a primary To match. The original From remains a final fallback for outgoing conversations. Alias creation order no longer outranks the recipient fields. Only the account's primary and configured aliases can be selected. Unconfigured catch-all or BCC delivery metadata does not grant send-as permission. Reply All continues excluding the user's own recipient identities.

Removing the default alias resets the account preference to primary. A new message whose configured default is unavailable also falls back to primary. In contrast, a saved draft or an already explicit sender selection referencing a removed alias is rejected by the existing send/draft API with HTTP 409 until the user chooses an available sender. This avoids silently exposing another address.

The same account preference and composer apply to IMAP/SMTP, Gmail API and Microsoft Graph. The provider must independently permit sending as the selected alias; Inboxora does not provision provider aliases or change provider permissions. Existing send/draft callers that omit an alias continue to select the primary identity. `PUT /api/accounts/:id/default-sender` accepts `{ "aliasId": "<owned alias UUID>" }` or `{ "aliasId": null }` and returns the persisted account/default selection.

## Administrator upgrade requirements

Back up the database first. Apply the normal migration chain through **`0150_account_default_sender.sql`**, after `0149_body_cache_retention.sql`, **before the updated backend handles requests**. Normal backend startup runs pending migrations. This additive migration adds `email_accounts.default_alias_id`, a same-account composite foreign key and an index. Existing accounts retain their primary default. Deleting a selected alias clears only the optional default reference, not the mailbox. Previously published migrations are unchanged.

The column-specific `ON DELETE SET NULL` requires PostgreSQL 15 or later; the supported Compose/CI PostgreSQL 16 configuration is covered by the database tests. No new environment variables, provider scopes or user data backfill are needed.

## Validation and acceptance

Regression coverage includes per-account defaults, primary/manual/saved-draft preservation, delivery/To/Cc precedence, malformed address metadata, account ownership checks and deletion races. A fresh production migration chain and four real PostgreSQL constraint/cascade tests pass on PostgreSQL 16. Browser regressions cover protected primary controls, persistence, new-message defaults and manual selection, default deletion, failed saves and stale settings responses on desktop and mobile.

For acceptance testing, select an alias as default, start a new message, manually switch From, reply to messages addressed to both the primary address and a different alias, reopen a saved draft, and remove the selected default alias. Test sending only with provider-authorized identities. The development image should be published from the exact reviewed SHA after CodeRabbit and required CI checks pass; main remains unmerged until acceptance.
