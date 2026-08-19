# Security Policy

## Reporting a vulnerability

**Report privately via [GitHub Security Advisories](https://github.com/mazze93/github-mcp-gateway/security/advisories/new).**
Do not open a public issue — this repository is an OAuth authorization
server, and a public report is a live disclosure while the Worker is
still deployed.

You can expect an acknowledgement within 72 hours. If the report is
accepted, the fix ships through the normal PR → `main` → auto-deploy
path and the advisory is published once the deployed Worker is patched.

## What is in scope

This project runs one deployed Worker at
`github-mcp-gateway.mazzewhiteley93.workers.dev`. The security-relevant
surface is small and specific:

| Area | Where | What would be a finding |
|---|---|---|
| Downstream OAuth 2.1 | `src/index.ts`, `@cloudflare/workers-oauth-provider` | Token issued to a client that shouldn't hold one; PKCE or audience bypass |
| Consent / CSRF | `src/oauth/workers-oauth-utils.ts` | Forged consent, state replay, session fixation, cookie forgery against the HMAC-signed approved-clients cookie |
| Identity gate | `src/oauth/allowlist.ts`, `/callback` | Any GitHub identity outside `ALLOWED_GITHUB_LOGINS` completing a grant |
| Redirect handling | `src/oauth/loopback.ts` | A redirect URI reaching an origin other than loopback via the `localhost` → `127.0.0.1` normalisation |
| Upstream token storage | `src/github-client.ts`, `OAUTH_KV` | GitHub access/refresh tokens leaking to a client, a log, or a tool result |
| Tool layer | `src/tools/*.ts` | A tool reaching a repository outside the GitHub App installation's grant |

Out of scope: findings that require the account holder's own GitHub
credentials, and rate-limiting or availability of the free-tier Worker.

## Design properties this build relies on

If a change breaks one of these, treat it as a security regression:

- The MCP client **never receives the GitHub token**. It holds a token
  scoped to this Worker only; the GitHub token stays in `OAUTH_KV`.
- Every cookie uses the `__Host-` prefix — browser-enforced proof that it
  was set by this exact origin over HTTPS with no widening `Domain`.
- OAuth state is **one-time-use and server-side** (KV, 10 min TTL), with a
  session-binding cookie proving the browser finishing the flow is the one
  that started it.
- The allowlist is checked at `/callback` **before** any token is persisted
  or any grant completed.
- `ALLOWED_GITHUB_LOGINS` is defense in depth, not the only gate — the
  GitHub App installation scopes repository access independently.

## Supported versions

The deployed Worker is the only supported artifact, and it always tracks
`main`. Released tags exist for provenance and for the toolchain image;
fixes are not backported to older tags.

## Automated checks

Every pull request runs typecheck, the test suite on the real Workers
runtime (`workerd`), a `wrangler --dry-run` build, and CodeQL.
`npm audit --omit=dev` must report **zero** production advisories — that
gate is a required check, not advisory.
