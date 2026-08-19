# github-mcp-gateway

Remote MCP server on Cloudflare Workers giving MCP clients (Claude Code,
Claude.ai/Cowork, and any spec-compliant client) authenticated GitHub access
via a GitHub App user-to-server OAuth flow.

## Deployment facts (live)

- **Worker:** `github-mcp-gateway` — https://github-mcp-gateway.mazzewhiteley93.workers.dev
- **MCP endpoint:** `/mcp` (streamable HTTP) and `/sse` (legacy SSE)
- **KV namespace:** `OAUTH_KV` = `0773ec3dd785418c984559f47d1623e9`
- **Secrets set on the worker:** `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `COOKIE_ENCRYPTION_KEY`
- **Allowlist var:** `ALLOWED_GITHUB_LOGINS="mazze93"` (in `wrangler.jsonc`)
- **GitHub App permissions:** Contents RW, Issues RW, Pull requests RW, Metadata R.
  It does **not** have Administration — `github_update_repo` will 403 until that
  permission is added to the App and re-approved on the installation. Use the
  locally-authenticated `gh` CLI as the fallback for repo description/topic edits.

## Commands

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run, via @cloudflare/vitest-pool-workers (real workerd, not a Node polyfill)
npm test test/loopback.test.ts   # one file
npm test -- -t "localhost"       # one test by name
npm run dev         # wrangler dev at http://localhost:8788 (needs .dev.vars)
npm run tail        # live worker logs

npx wrangler deploy --dry-run --outdir dist   # local build check; catches
                    # bundling/binding errors tsc cannot see. Never publishes.
```

**Deployment is automatic.** `.github/workflows/deploy.yml` typechecks, tests,
and deploys on every push to `main` — it is the only place a Cloudflare token
exists (`ci.yml` runs on PRs including forks and is deliberately
credential-free). `npm run deploy` is a manual fallback, not the normal path;
production drifting behind `main` because someone forgot to run it by hand is
the exact failure that workflow was added to close.

`test/*.test.ts` covers the OAuth allowlist gate, CSRF/state/signed-cookie
handling, loopback redirect normalisation, token refresh, and tool
error-wrapping — see `vitest.config.ts` for how bindings are sourced from
`wrangler.jsonc`. CI runs it as a required gate. Not covered: the
`GET`/`POST /authorize` route wiring, and a few timing/concurrency edges
noted in PR #13's description. `typecheck` + `test` + a live tool call
against the deployed worker is the verification bar.

## Releasing

Semantic versioning, tag-triggered. Cutting a release is one commit and
one tag:

```bash
# 1. Bump VERSION and package.json to the SAME number, update CHANGELOG.md,
#    and land it through a PR (main is protected).
# 2. Then, on main:
git tag -s v1.2.3 -m "v1.2.3"
git push origin v1.2.3
```

`release.yml` verifies the tag agrees with `VERSION` **and**
`package.json` before publishing anything, re-runs the full gate
(typecheck, tests, production audit) because a tag can point at a commit
that never went through a PR, then builds and pushes the multi-arch
toolchain image, signs it keyless with cosign, and opens the GitHub
Release.

**A tag does not deploy the Worker.** `deploy.yml` does that, on merge to
`main`. The version number describes the gateway's own contract — its
tool surface, tool result shapes, and OAuth behaviour — not the image.

**The image is a toolchain, not a server.** `ghcr.io/mazze93/github-mcp-gateway-toolchain`
carries a pinned, non-root wrangler that *builds and deploys* the Worker.
It cannot run the gateway: no Workers runtime, no Durable Object
namespace, no KV binding exists in a container. Anyone wanting a running
gateway wants the deployed Worker. CI builds this image on every PR
(without pushing) and asserts the entrypoint works and the final stage is
non-root, so the Dockerfile is exercised before release time.

## Architecture

```
MCP client ──OAuth 2.1 (DCR, PKCE)──▶ Worker ──GitHub App OAuth──▶ GitHub
                                        │
                                        ▼
                                 OAUTH_KV: oauth:state:* (10 min TTL)
                                          github:tokens:{login} (rotating pair)
```

- `src/index.ts` — OAuthProvider wiring; `/mcp` + `/sse` registered at root
  (do NOT nest them under a path — workers-oauth-provider issues #108/#133).
- `src/github-mcp-agent.ts` — Durable Object (`MCP_OBJECT`), one per session;
  registers all tool modules in `init()`.
- `src/oauth/github-handler.ts` — consent screen, GitHub redirect, `/callback`
  (allowlist gate + token persistence).
- `src/oauth/workers-oauth-utils.ts` — CSRF, one-time KV state, session-binding
  cookie, HMAC-signed approved-clients cookie. All cookies `__Host-` prefixed.
- `src/oauth/loopback.ts` — rewrites `http://localhost:<port>` redirect URIs to
  `127.0.0.1` on **both** `/authorize` and `/token`. Not cosmetic: workers-oauth-
  provider's `isLoopbackUri()` doesn't recognise the hostname `localhost`, so
  Claude Code's ephemeral-port callback fails exact-match against its registered
  portless URI. Every published version through 0.8.3 behaves this way — don't
  delete it after a dependency bump without re-testing a Claude Code connection.
- `src/oauth/allowlist.ts` — `isLoginAllowed()`, the pure predicate behind
  `ALLOWED_GITHUB_LOGINS`; `src/oauth/utils.ts` — GitHub App authorize-URL and
  token/refresh exchange (App flow, so `scope` is ignored upstream; repo access
  is scoped at install time).
- `src/github-client.ts` — token refresh. GitHub access tokens live 8h; refresh
  tokens 6 months. `getFreshAccessToken()` refreshes 5 min before expiry and
  persists the rotated pair to KV. `props.accessToken` is a **bootstrap value
  only** — always resolve tokens through `getOctokit()`.
- `src/tools/*.ts` — one module per domain (repos, issues, pulls, contents,
  search). Every handler goes through `withOctokit()` in `helpers.ts`, which
  converts `ReauthorizationRequiredError` and Octokit errors into MCP
  `isError` results instead of throws.

## Adding a tool

Add it to the matching `src/tools/*.ts` module (or a new module registered in
`github-mcp-agent.ts`). Pattern: `server.tool(name, description, zodShape,
handler)` with the handler wrapped in `withOctokit(env, props, ...)`. Return
plain serializable objects — `ok()` JSON-stringifies them. Then typecheck, test,
dry-run build, and merge to `main` (which deploys). Reconnect the MCP client
afterwards — tool lists are only fetched at session start.

## Constraints

- **Destructive tools** — `github_merge_pull_request` and `github_delete_file`
  are irreversible; always confirm with the user before invoking them.
- **Code style** — tabs for indentation, double quotes, trailing commas.
- **`global_fetch_strictly_public`** in `wrangler.jsonc`'s `compatibility_flags`
  is required, not optional: workers-oauth-provider gates CIMD (Client ID
  Metadata Document) support on it, and Claude Code authenticates with a URL
  `client_id`. Remove it and `/authorize` throws for every such client.
- **`overrides` in `package.json`** (`undici`, `@hono/node-server`) exist to hold
  CI's production audit gate at zero while upstream lags a patch. Don't drop them
  during a dependency bump — re-check `npm audit --omit=dev` first.
- **Never commit** `.dev.vars` or real credentials. `.dev.vars.example` is the
  template.
- The `Props` type is fixed at OAuth-grant time and does not update on token
  refresh — that's why token state lives in KV, deliberately outside
  workers-oauth-provider's `tokenExchangeCallback` (upstream bug, see README).

## Recovery

- **Re-auth required errors** from tools → the GitHub refresh token expired or
  was revoked; disconnect/reconnect the MCP server in the client.
- **Client connection fails at token exchange** → check workers-oauth-provider
  issues #133/#108 (path audience validation) before debugging locally.
- Changing GitHub App permissions requires Mazze to approve the change on the
  installation page: https://github.com/settings/installations
