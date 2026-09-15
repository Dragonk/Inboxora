# Changelog

## Unreleased

### Fixed

- Restored TypeScript/TSX discovery in Tailwind and made the PostgreSQL migration workflow execute TypeScript entry points and tests.
- Returned controlled SMTP credential errors, converted existing Microsoft password accounts to OAuth, and required STARTTLS upgrades when configured.
- Prevented IMAP connection-pool over-allocation and preserved explicit IMAP TLS choices on custom ports.
- Preserved calendar projection coverage for concurrent wider windows and per-request iteration budgets in worker jobs.
- Reset session-owned mail, draft, search, thread, notification, and account state when the SPA user changes.
- Prevented replacement of active TOTP enrollment without first disabling it.
- Removed bidirectional control characters from imported attachment filenames.
- Reported partial SMTP recipient acceptance without encouraging re-sends, and renewed ownership-checked idempotency leases during long sends.
- Applied explicit Microsoft integration configuration clears to the live runtime and revalidated/pinned AI-provider requests against the current connection policy.
- Made conversation AI output collapse with its email, render sanitized Markdown, and support sanitized Mermaid diagrams.
