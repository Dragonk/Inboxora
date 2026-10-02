# External AI applications (MCP)

Inboxora exposes a native **Streamable HTTP MCP server** at `/mcp`. It is separate from the built-in AI provider settings, browser sessions, DAV passwords and email-provider OAuth connections. It does not expose a generic SQL or HTTP execution tool.

## Enable the server

Add these settings to the **backend** environment and restart the backend after pulling both matching images:

```yaml
environment:
  MCP_ENABLED: "true"
  APP_URL: "https://mail.example.com"
  # Only for browser-hosted clients that send an Origin header:
  MCP_ALLOWED_ORIGINS: ""
```

`APP_URL` must be the externally reachable HTTPS origin, without a path, credentials, fragment or query string. HTTP is accepted only for localhost development. Set the existing persistent `ENCRYPTION_KEY` before creating connections; changing it makes stored OAuth client metadata and pending operation payloads unreadable.

The included Nginx configuration proxies `/mcp`, `/oauth/` and `/.well-known/oauth-*`. MCP credentials must never cross public plaintext HTTP. The supplied Compose files therefore bind the HTTP reverse-proxy port to `127.0.0.1` by default; set `APP_HTTP_BIND` only to a trusted private interface when a TLS-terminating proxy runs elsewhere. On that internal HTTP hop, MCP and its OAuth endpoints are accepted only when the proxy forwards `X-Forwarded-Proto: https`; direct cleartext requests are refused. An additional reverse proxy must preserve the public `Host` (including a nonstandard port), `Authorization`, `MCP-Protocol-Version`, request bodies and `WWW-Authenticate`. Do not put an interactive proxy login in front of these protocol endpoints. Keep the normal Inboxora browser login on the consent and confirmation pages. Do not disable TLS verification. MCP is disabled by default; disabling it blocks protocol access without deleting connection history.

Requests with an `Origin` header are accepted only for `APP_URL` or exact comma-separated entries in `MCP_ALLOWED_ORIGINS`. Server-to-server clients normally do not send this header. Do not add wildcard origins. Stateless MCP POST requests return JSON; GET and DELETE return 405 because this server does not maintain persistent SSE sessions.

The additive migration `0167_mcp_authorization.sql` is applied by the normal backend migration runner. Apply it before starting a new backend against an existing database. Existing mail, calendar and contact tables are not reset.

## Create a connection

Open **Settings → AI Features → External AI integrations (MCP)**. The endpoint is shown there. Choose only the permissions and resources the application needs. Each connection has its own expiration and can be revoked immediately.

Read permissions are selected initially. Write approval is enabled initially. An empty resource selection means **no access**, while “all” includes current and future resources of that type. Accounts, account/folder pairs, calendars and address books can be restricted independently. A folder's display name is not a permission: its exact account and path are checked. Gmail permissions use current labels rather than the legacy storage folder of an archived message.

Existing connections can be opened in **Settings → AI Features → External AI integrations (MCP)** to review or change their live scope/resource checkboxes. Changes apply immediately to active tokens. Inboxora cancels pending approvals prepared under the previous permission set so they cannot be approved after access changed. Revoking still invalidates the whole connection. Native provider, DAV and subscribed-calendar read-only restrictions still apply even when a connection has a write scope.

### ChatGPT

Create a custom MCP app/connector in a ChatGPT account or workspace where that feature is enabled. Use `https://mail.example.com/mcp` and select OAuth authentication. For dynamic registration, leave a manually entered client ID and secret empty when the UI permits it. Inboxora advertises OAuth authorization-server metadata, protected-resource metadata and a dynamic client-registration endpoint. Authorize in the Inboxora browser window, verify the callback address and choose the permissions.

The server implements authorization code with S256 PKCE, exact registered redirect validation, the `resource` parameter, authorization-response `iss`, rotating refresh tokens and revocation. It supports DCR rather than Client ID Metadata Documents; ChatGPT documents DCR as a fallback. The application name on the consent page is supplied by the client, not a verified identity. Public reachability is necessary for a hosted client. Enterprise policies, plan eligibility and client settings can still prevent a connection.

ChatGPT research-compatible `search` and `fetch` tools are included alongside the domain-specific tools. A read-only ChatGPT configuration cannot perform write operations merely because the server provides them.

References: [OpenAI authentication documentation](https://developers.openai.com/plugins/build/auth) and [connecting from ChatGPT](https://developers.openai.com/plugins/deploy/connect-chatgpt).

### Mistral Vibe

Vibe's documented MCP configuration currently does not support OAuth. Create a personal access token in Inboxora instead. It is displayed once. Store it in a secret store or environment variable, never in a repository, chat message or URL:

```bash
export INBOXORA_MCP_TOKEN='your-token'
```

Add to `~/.vibe/config.toml`:

```toml
[[mcp_servers]]
name = "inboxora"
transport = "streamable-http"
url = "https://mail.example.com/mcp"
api_key_env = "INBOXORA_MCP_TOKEN"
api_key_header = "Authorization"
api_key_format = "Bearer {token}"
tool_timeout_sec = 300
```

Restart/reload the client's MCP connections, list the available tools and call `get_capabilities` first. Vibe tool names can include the configured server-name prefix.

Reference: [Mistral Vibe MCP servers](https://docs.mistral.ai/vibe/code/cli/mcp-servers).

### Other clients and a read-only connection check

Use Streamable HTTP with OAuth discovery/DCR, or a personal token in `Authorization: Bearer ...`. A browser session cookie is not an MCP credential. Clients that support only stdio or the legacy HTTP+SSE transport need a compatible bridge provided by that client; Inboxora does not pretend to expose a stdio endpoint.

The backend's automated integration test uses the official TypeScript MCP client over a real HTTP listener and PostgreSQL. It tests discovery, initialization, scoped tool listing/calls, PKCE, resource/redirect binding, refresh rotation/replay, browser-only approval, revocation and concurrent replay protection. It also performs synthetic local calendar/contact CRUD. These tests are not a claim that a particular hosted ChatGPT account or an installed Vibe version has completed a live login.

## Tools and permissions

| Area | Operations | Permissions |
| --- | --- | --- |
| Mail | Accounts/aliases, folders, search, message body, thread headers, attachment text/base64 | `mail.read` |
| Composition | Read/create/edit draft; new message, reply, reply-all and forward | `mail.draft`, `mail.send`; source-reading operations also require `mail.read` |
| Organization | Read/star status, move/archive, Trash/permanent deletion, spam/ham, unsubscribe | Separate `mail.modify`, `mail.delete`, `mail.spam`, `mail.unsubscribe` scopes |
| Calendars | Hidden and visible calendars, ranged occurrences, event search/details, synchronized availability | `calendar.read` |
| Calendar changes | Create/edit/delete series or single/following occurrences, import an email invitation | `calendar.write`; email invitations also require `mail.read` |
| Notifications | New/existing event attendees and provider-generated invitations/cancellations | Additional `calendar.invite` |
| Contacts | Address books, search/list, contact details, create/edit/delete | `contacts.read`, `contacts.write` |
| Integration | Effective permissions, operating guide, operation receipt | `get_capabilities`, `get_operation` |

Reading an email does not mark it as read. Binary attachment downloads are limited to 1 MiB through MCP; larger files must be downloaded in Inboxora. The client may process returned base64; the server does not silently claim to extract text from every binary format. The configured attachment scanner is reused, and the result reports its scan status. New inline attachment uploads are limited to 3 MiB total and prepared compositions to 6 MiB. Message text is paged at up to 60,000 characters, normal list pages at 100 items, search input at 500 characters, and calendar ranges at 366 days.

Calendar availability is derived from synchronized permitted calendars, not a live query of other people's calendars. Incomplete recurrence projections do not produce confident free-time slots. An imported email invitation is a local calendar copy, **not an RSVP**. Subscribed ICS/webcal sources remain read-only. Event and contact changes require the revision returned by the read operation.

Reply recipients are explicit: read the original headers, then provide the intended To/CC/BCC lists. Omitted CC/BCC and sender alias use the account defaults; an explicit empty CC/BCC list disables those defaults. Omit `signature` to use the configured signature of the selected sender, supply `signature`/`signatureIsHtml` to override it for one message, or pass an empty signature to suppress it. `list_accounts` exposes the configured/effective sender signatures for agents that need to preserve or deliberately adjust them. The resolved sender, recipients, sanitized signature, quoted content and attachment bytes are prepared before approval. Editing a draft replaces its editable fields and attachments; preserve the original values that should remain.

## Write approval and retry safety

Each mutation requires a stable `requestId` identifying one exact intended operation. With approval enabled, the first call records a pending operation and returns an Inboxora URL. The user signs in, reviews the resolved operation and approves or denies it. For outgoing mail, the approval page uses Inboxora's message presentation and the same recipient-chip/signature controls as the normal composer. It shows sender/recipients/BCC/subject/body/signature/attachments and lets the user edit recipients, subject, rich message body and the inline composer signature before approval. Every edit is revalidated and re-prepared server-side so the refreshed preview is the exact frozen payload that can be sent. A bearer token and the model cannot approve an operation. Clicking **Approve** is the final user action: Inboxora atomically claims and executes that frozen operation immediately. The AI client may poll `get_operation` or repeat the same `requestId` only to read the durable receipt; it does not need to submit the mutation again.

The AI client's original arguments cannot be changed under an existing request ID. Human edits made inside the Inboxora approval page are stored only in the encrypted prepared snapshot and are revalidated before they replace the pending preview. The server checks current permissions again before dispatch and uses an atomic state transition to prevent concurrent duplicate dispatches. A provider timeout or uncertain SMTP outcome is not reported as definitely unsent. Never change the request ID to retry an `executing`, `partial` or `uncertain` operation. Inspect Inboxora and the provider first. Already dispatched external actions cannot be undone by revoking the connection.

Pending approvals expire after 30 minutes and approved operations after 10 minutes. Expired prepared payloads are erased by maintenance. An execution interrupted for over one hour becomes uncertain, never automatically retried. Detailed completed receipts are retained for 30 days; their IDs and fingerprints remain while the grant exists so an old request ID cannot become a new operation. Token hashes are stored instead of bearer tokens; sensitive OAuth metadata and operation payloads are encrypted. Public client registrations without a grant or active authorization are removed after 30 days. There are per-user connection/pending-operation limits and per-process request/concurrency limits; retain reverse-proxy rate limits for multi-replica deployments.

Treat email, contact notes, event descriptions and attachments as untrusted data. A message asking an AI to forward secrets is not authorization from the user. Approval screens render external content as text, not executable HTML.

## Search changes and troubleshooting

The UI searches all folders by default; the current-folder option remains available. UI and MCP share the same query parser and SQL search. Quoted phrases, literal `%`/`_`, Polish text, recipients, repeated filters and date boundaries have regression tests. Gmail, Microsoft Graph and IMAP server-side searches supplement the local cache, including older mail and messages whose body has not been downloaded. Provider hits are rechecked against current ownership, folder membership and filters before pagination.

A shared eight-second request budget returns locally available matches without blocking the UI on every slow account. When that deadline is the reason coverage is incomplete, the UI keeps the search in a visible in-progress state and automatically retries the same query (up to four attempts) against the coalesced provider operation instead of showing a false empty result. Already-started coalesced reads are deliberately not cancelled at the response deadline: another request may share them. They retain their 35-second transport limit, occupy one of at most 40 in-flight slots per process, and can populate the cache for a retry. This is an accepted resource-use trade-off; requests beyond the capacity receive a partial-coverage warning. For IMAP accounts, a server-advertised `\All` mailbox is searched first as the complete ordinary-mail corpus (with Junk separately); servers without `\All` prioritize Inbox, Sent and Archive before other folders. Remote searches are bounded (up to 1,000 provider hits per account, and up to 50 IMAP folders) and can time out, be rate-limited or require reconnecting an account. `partial`, `providerErrors`, `coverage` and `nextOffset` describe the result; the UI displays an incomplete/failure warning rather than equating an error with no matching mail. Narrow the query or select an account/folder when a limit is reached. A full local page alone is not proof of complete server coverage. A 15-second provider-hit cache coalesces repeated requests; it never bypasses current permission checks.

For a 401, verify the token's expiry, revocation, correct `/mcp` resource and preserved Authorization header. For 403, check the scope, exact resource selection and Origin/Host policy. For a tool error, inspect its code and the source's read-only or provider status. For a pending mutation, follow the approval flow instead of issuing a new request ID. When disabled, `/mcp` returns 404 intentionally.

OAuth token exchange and revocation support public clients (`none`), HTTP Basic (`client_secret_basic`) and form-post client secrets (`client_secret_post`). Inboxora enforces the registered method and rejects conflicting header/body credentials. All three flows are covered by the PostgreSQL HTTP integration suite.
