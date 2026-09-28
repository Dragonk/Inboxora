# Development changes — unreleased

These changes are on the development branch for pre-merge testing. They are **not part of the published 4.1.2 release**; a release version has not been assigned.

## Sender addresses and automatic From selection (#9)

In Settings → Accounts → the account menu → Aliases, the Sender addresses view always includes the primary mailbox address. It cannot be deleted from this view. The radio buttons select exactly one default sender for new messages, independently for each account. Existing aliases keep their display name, Reply-To and signature settings, and can still be edited or removed.

New messages and forwards start with the selected default. The From menu still permits an explicit primary address or another configured alias. The default is a compose-time preference, not an instruction to rewrite an already open message: changing settings or refreshing the account list does not replace a manual selection or a saved draft identity.

Replies and Reply All first select a configured alias from ordered delivery metadata, then match To and Cc identities. A primary mailbox address in delivery metadata is considered only after those matches: forwarded mail can contain both the final primary destination and an originally contacted alias, and the latter must not be hidden. The primary address participates in visible recipient matching, so a Cc alias does not override a primary To match. The original From remains a final fallback for outgoing conversations. Alias creation order no longer outranks the recipient fields. Only the account's primary and configured aliases can be selected. Unconfigured catch-all or BCC delivery metadata does not grant send-as permission. Reply All continues excluding the user's own recipient identities.

Stored recipient objects may expose both `email` and `address`. Sender matching and Reply All self-exclusion normalize `email` first, then fall back to `address` only when the first value is unusable. A valid `email` keeps precedence. This also prevents sending a Reply All copy back to a catch-all address whose metadata has a blank `email`; it does not authorize that address as a sender.

Removing the default alias resets the account preference to primary. A new message whose configured default is unavailable also falls back to primary. In contrast, a saved draft or an already explicit sender selection referencing a removed alias is rejected by the existing send/draft API with HTTP 409 until the user chooses an available sender. This avoids silently exposing another address.

The same account preference and composer apply to IMAP/SMTP, Gmail API and Microsoft Graph. The provider must independently permit sending as the selected alias; Inboxora does not provision provider aliases or change provider permissions. Existing send/draft callers that omit an alias continue to select the primary identity. `PUT /api/accounts/:id/default-sender` accepts `{ "aliasId": "<owned alias UUID>" }` or `{ "aliasId": null }` and returns the persisted account/default selection.

## Default CC and BCC recipients (#6)

Account general settings now include **Default CC recipients** and **Default BCC recipients**. Enter bare email addresses separated by commas or semicolons. The lists are saved on the server, separately for every account, and are shared by that account's primary address and all its aliases. This makes the same preferences available in web, desktop and Android clients. Empty lists disable the feature; no provider permission or environment setting is added.

New messages, replies, Reply All and forwards include these recipients as visible, removable chips. Existing message recipients take precedence over automatic additions. Matching ignores address case and display labels; an address configured in both default lists is added only as BCC to avoid exposing a blind recipient. The backend validates each submitted list before saving: at most 50 bare addresses per field, at most 254 characters per address, and no header/control characters, display names or groups.

Changing From to another account removes only untouched automatically added recipients from the previous account, preserves manual recipients, and adds the new account's defaults without duplication. Changing aliases within the same account or refreshing account data does not reset recipient edits or restore removed defaults. Reopening an existing saved draft preserves its saved recipients rather than adding the current defaults again. A subsequent deliberate switch to another account applies that new account's defaults; saved recipients are treated as explicit recipients.

Long recipient lists have a bounded scroll area on desktop/landscape layouts, keeping the editor and sending controls reachable even with both default lists filled.

Defaults are a composer preference, not a sending rule. SMTP, Gmail API and Microsoft Graph receive the visible recipient fields through the existing sending pipeline. No server-side send, retry or draft operation silently inserts CC/BCC, and API callers without the updated composer retain their existing behavior. This feature does not implement conditional mail rules or independent recipient defaults for individual aliases.

## Administrator upgrade requirements

Back up the database first. Apply the normal migration chain through **`0151_account_default_recipients.sql`**, after `0149_body_cache_retention.sql` and `0150_account_default_sender.sql`, **before the updated backend handles requests**. Normal backend startup runs pending migrations. Migration `0150_account_default_sender.sql` adds `email_accounts.default_alias_id`, a same-account composite foreign key and an index. Existing accounts retain their primary default. Deleting a selected alias clears only the optional default reference, not the mailbox. Previously published migrations are unchanged. Migration `0151_account_default_recipients.sql` then adds bounded, non-null `default_cc` and `default_bcc` text arrays with empty defaults. Existing accounts do not gain any automatic recipients on upgrade. Replace the backend and frontend together so the settings and composer agree.

The column-specific `ON DELETE SET NULL` requires PostgreSQL 15 or later; the supported Compose/CI PostgreSQL 16 configuration is covered by the database tests. No new environment variables, provider scopes or user data backfill are needed.

## Validation and acceptance

Regression coverage includes per-account defaults, primary/manual/saved-draft preservation, delivery/To/Cc precedence, malformed address metadata, account ownership checks and deletion races. A fresh production migration chain and four real PostgreSQL constraint/cascade tests pass on PostgreSQL 16. Browser regressions cover protected primary controls, persistence, new-message defaults and manual selection, default deletion, failed saves and stale settings responses on desktop and mobile.

For acceptance testing, select an alias as default, start a new message, manually switch From, reply to messages addressed to both the primary address and a different alias, reopen a saved draft, and remove the selected default alias. Test sending only with provider-authorized identities. The development image should be published from the exact reviewed SHA after CodeRabbit and required CI checks pass; main remains unmerged until acceptance.

CC/BCC regression coverage additionally exercises API ownership and atomic validation, 22 PostgreSQL migration/constraint cases, automatic-recipient ownership, uncommitted input, partial-send retry preservation, settings persistence and failures, exact send payloads, blank-message autosave and saved-draft reopening. Desktop and mobile browser cases also protect the existing sender-alias behavior.

For CC/BCC acceptance testing, save multiple defaults on two accounts, compose using primary and alias identities, remove a default, add manual recipients, switch accounts, and save/reopen a draft. Confirm the exact visible To/CC/BCC fields before sending a test message. Also test Reply/Reply All transitions and the mobile composer.
