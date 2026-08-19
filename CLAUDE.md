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
npm run typecheck   # tsc --noEmit — run before every deploy
npm test            # vitest run, via @cloudflare/vitest-pool-workers (real workerd, not a Node polyfill)
npm run dev         # wrangler dev at http://localhost:8788 (needs .dev.vars)
npm run deploy      # wrangler deploy
npm run tail        # live worker logs
```

`test/*.test.ts` covers the OAuth allowlist gate, CSRF/state/signed-cookie
handling, loopback redirect normalisation, token refresh, and tool
error-wrapping — see `vitest.config.ts` for how bindings are sourced from
`wrangler.jsonc`. CI runs it as a required gate. Not covered: the
`GET`/`POST /authorize` route wiring, and a few timing/concurrency edges
noted in PR #13's description. `typecheck` + `test` + a live tool call
against the deployed worker is the verification bar.

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
plain serializable objects — `ok()` JSON-stringifies them. Then typecheck,
deploy, and reconnect the MCP client (tool lists are fetched at session start).

## Constraints

- **Destructive tools** — `github_merge_pull_request` and `github_delete_file`
  are irreversible; always confirm with the user before invoking them.
- **Code style** — tabs for indentation, double quotes, trailing commas.
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
