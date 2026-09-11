# Security policy

## Reporting a vulnerability

Please **do not** open a public issue containing exploit details, credentials, message content or
personal data.

Use GitHub's [private vulnerability reporting](https://github.com/Dragonk/Inboxora/security/advisories/new)
on this repository. If that is unavailable to you, open a minimal public issue that asks for a
private channel and contains no technical detail about the vulnerability.

Include, where you can:

- the affected version (visible in **Settings → About**) and how Inboxora is deployed,
- what an attacker can achieve and under which preconditions,
- reproduction steps or a proof of concept,
- any suggested mitigation.

You will get an acknowledgement as soon as possible. Please give the maintainer a reasonable
window to ship a fix before publishing details.

## Supported versions

Only the latest released minor line receives security fixes. Pre-release `:dev` images are build
candidates for testing and are not supported for production use.

## What is already in scope for review

The project cares especially about these boundaries, and reports about them are welcome:

- authentication, session handling, TOTP, SSO and the screen lock,
- the CardDAV and CalDAV servers and their application-password authentication,
- encryption of stored mail, DAV, calendar and system-mail credentials,
- the server connection policy that restricts which hosts Inboxora may contact,
- rendering of untrusted message HTML and remote-content blocking,
- attachment handling and archive downloads,
- the privilege boundary between regular users and administrators.

## Handling secrets

Never include real credentials in a report. Reproduce with a test account and redact addresses,
tokens, connection strings and message bodies. The built-in diagnostics report is already
redacted and is safe to attach; see [Troubleshooting](wiki/Troubleshooting.md).
