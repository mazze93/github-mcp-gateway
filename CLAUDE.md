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
- **GitHub App permissions:** Contents RW, Issues RW, Pull requests RW, Metadata R,
  Administration RW. `github_update_repo` works directly (verified 2026-10-21 with a
  no-op description update).

## Commands

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run, via @cloudflare/vitest-pool-workers (real workerd, not a Node polyfill)
npm test test/oauth-boundaries.test.ts   # one file
npm test -- -t "localhost"       # one test by name
npm run dev         # wrangler dev at http://localhost:8788 (needs .dev.vars)
npm run tail        # live worker logs
bash scripts/test-toolchain.sh  # Apple container preferred; Docker fallback; dry-run only

npx wrangler deploy --dry-run --outdir dist   # local build check; catches
                    # bundling/binding errors tsc cannot see. Never publishes.
```

**Deployment is automatic.** `.github/workflows/deploy.yml` typechecks, tests,
and deploys on every push to `main` — it is the only place a Cloudflare token
is exposed to a deploy step (`ci.yml` runs on PRs including forks and is
deliberately credential-free). `npm run deploy` is a manual fallback, not the normal path;
production drifting behind `main` because someone forgot to run it by hand is
the exact failure that workflow was added to close.

`test/*.test.ts` covers the OAuth allowlist gate, CSRF/state/signed-cookie
handling, loopback redirect validation, token refresh, and tool
error-wrapping — see `vitest.config.ts` for how bindings are sourced from
`wrangler.jsonc`. CI runs the suite as a verification gate. The authorize
routes are covered in `test/authorize-routes.test.ts`;
`test/oauth-boundaries.test.ts` also covers token audience isolation and
legacy path-bound grant rejection. Cross-location KV refresh races remain
a known limitation. `typecheck` + `test` + a live tool call
against the deployed worker is the verification bar.

## Discovery metadata

Three places, and they drift apart if only one is touched:

- **Repo topics + description** — GitHub-side, not in the tree. Edit with
  `github_update_repo` (the App has Administration) or `gh repo edit`.
- **`package.json`** — `keywords`, `repository`, `bugs`, `homepage`. The
  package is `private: true` and unpublished, but registries and MCP
  directories read this file from the repo.
- **`README.md`** — the header block: one-sentence description, CI/release/
  license badges, and the "What you get" table. The tool count there is a
  claim about `src/tools/*.ts`; if you add a tool, update it (currently 21 —
  `grep -c 'server.tool(' src/tools/*.ts`).

`isTemplate` is set on the repo, which matches the fork-and-deploy model.

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
  workers-oauth-provider 1.x needs one canonical `resourceMetadata.resource`
  (every token's audience) and only protects routes at/under its path, so
  the resource is the bare request **origin** — one provider is built per
  origin. Setting it to `<origin>/mcp` makes construction throw over `/sse`;
  `test/entrypoint.test.ts` pins this.
- `src/github-mcp-agent.ts` — Durable Object (`MCP_OBJECT`), one per session;
  registers all tool modules in `init()`.
- `src/oauth/github-handler.ts` — `GET /` landing page, consent screen, GitHub redirect, `/callback`
  (allowlist gate + token persistence).
- `src/oauth/brand.ts` — shared page shell for the landing and consent pages
  (Kintsugi palette, system font stacks, static CSP with no `form-action` — it
  would apply to the 302 to github.com). Change styling here, once.
- `src/oauth/workers-oauth-utils.ts` — CSRF, one-time KV state, session-binding
  cookie, HMAC-signed approved-clients cookie. All cookies `__Host-` prefixed.
- Loopback redirect URIs are validated directly by workers-oauth-provider:
  `localhost`, IPv4 loopback and IPv6 `::1` retain their registered hostname
  while ephemeral ports are accepted. Do not rewrite localhost to an IP:
  that breaks hostname-strict registrations. `test/oauth-boundaries.test.ts`
  exercises registration, GitHub callback and PKCE token exchange through
  the real entrypoint, with only upstream GitHub HTTP calls mocked.
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
- **`McpAgent` is feature-frozen upstream.** As of `agents` 0.21.0 its type
  carries `@deprecated McpAgent is feature-frozen. Migrate to an SDK v2 factory
  with createMcpHandler from agents/mcp/server.` Frozen is not removed —
  `serve`/`serveSSE` still work and nothing breaks — but new capability lands on
  `createMcpHandler`, not here. Migration is deliberately deferred: the Durable
  Object is sessionful on purpose (per-session tool registration in `init()`),
  and the deprecation text names that as the case warranting a stateless route
  running *beside* the existing one until sessions drain, not a swap.
- **Code style** — tabs for indentation, double quotes, trailing commas.
- **CIMD needs two things, not one.** workers-oauth-provider gates it on
  `!!options.clientIdMetadataDocumentEnabled && hasGlobalFetchStrictlyPublic()`
  — the `global_fetch_strictly_public` compatibility flag in `wrangler.jsonc`
  **and** `clientIdMetadataDocumentEnabled: true` in `src/index.ts`. Drop
  either and a URL `client_id` stops being fetched as a metadata document and
  silently degrades to a bare `OAUTH_KV.get("client:<url>")`, so Claude Code
  authenticates only while a stale record survives in KV. The flag sat here
  for months without the option and `deploy.yml`'s smoke test flipped 200 →
  400 across two deploys of identical code before anyone noticed.
- **`overrides` in `package.json`** (`undici`, `@hono/node-server`) exist to hold
  CI's production audit gate at zero while upstream lags a patch. Don't drop them
  during a dependency bump — re-check `npm audit --omit=dev` first.
- **Never commit** `.dev.vars` or real credentials. `.dev.vars.example` is the
  template.
- The `Props` type is fixed at OAuth-grant time and does not update on token
  refresh — that's why token state lives in KV, deliberately outside
  workers-oauth-provider's `tokenExchangeCallback` (upstream bug, see README).

## Recovery

- **Re-auth required errors** from tools → **retry the call once first.** Every
  session shares one stored GitHub login, and GitHub refresh tokens are
  single-use: two sessions refreshing together used to leave the loser with a
  false re-auth error while the stored login was fine. `getFreshAccessToken()`
  now re-reads KV before throwing, which narrows that race but cannot close it
  (KV has no compare-and-swap). Only if the retry fails too did the refresh
  token really expire or get revoked — then disconnect/reconnect. A reconnect
  re-authorizes and can revoke this client's other grants, so it is not free.
- **Client connection fails at token exchange** → check workers-oauth-provider
  issues #133/#108 (path audience validation) before debugging locally.
- Changing GitHub App permissions requires Mazze to approve the change on the
  installation page: https://github.com/settings/installations
