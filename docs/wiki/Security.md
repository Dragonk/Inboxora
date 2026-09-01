# Security

Keep Inboxora behind the configured reverse proxy. Do not expose additional host ports for browser access. Store deployment secrets outside source control.

Calendar imports validate their destination and follow the server's connection policy to reduce SSRF exposure. External CalDAV credentials are encrypted at rest; invitation delivery requires selecting an owned enabled SMTP account.
