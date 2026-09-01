<p align="center"><img src="media/inboxora-logo.png" width="200" alt="Inboxora logo"></p>

# Inboxora

Self-hosted unified inbox for email, contacts and calendars.

> **Thanks to [maathimself](https://github.com/maathimself), creator of [MailFlow](https://github.com/maathimself/mailflow).** Inboxora is an independently developed AGPL-3.0-only fork with distinct product goals; required upstream notices remain preserved.

## Start here

- **Images:** `ghcr.io/dragonk/inboxora-backend:dev` and `ghcr.io/dragonk/inboxora-frontend:dev` are development candidates; use a tagged release for stable deployments.
- **Quick start:** copy `docker-compose.ghcr.yml` and `.env.example`, set the required secrets, then run `docker compose up -d` behind your configured reverse proxy.
- **Development:** `npm test`, `npm run lint`, and `npm run build` in `frontend/` and `backend/`; browser coverage uses Playwright.
- **Support:** [Issues](https://github.com/Dragonk/Inboxora/issues) · [Contributing](CONTRIBUTING.md) · [Roadmap](ROADMAP.md)

## Documentation

The project **Wiki is the canonical documentation** for installation, configuration, security, calendars, contacts/DAV, external sources, mobile navigation, troubleshooting and development. Wiki source is maintained in [`docs/wiki/`](docs/wiki/); it is published to the repository Wiki as part of reviewed releases.

## License

[AGPL-3.0-only](LICENSE). Network users of a modified deployment must be offered its corresponding source, as required by the AGPL. Contributions are accepted under the same terms.
