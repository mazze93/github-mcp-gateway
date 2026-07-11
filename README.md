# github-mcp-gateway

A remote MCP server that gives MCP clients — Claude Code, Claude.ai/Cowork,
or any spec-compliant client — authenticated access to GitHub: repos, issues,
pull requests, file contents, and search, over a proper OAuth 2.1 handshake.
Runs on Cloudflare Workers.

**Status: deployed and live** at
`https://github-mcp-gateway.mazzewhiteley93.workers.dev/mcp`.

## Why this exists, and the shape of it

An MCP client can't talk to GitHub's API directly with your credentials — it
needs something in between that (a) proves who's asking, (b) holds a real
GitHub token, and (c) translates tool calls into GitHub API requests. This
Worker is that middle layer, and it plays **two OAuth roles at once**:

- **OAuth client** to GitHub (upstream) — it sends you through GitHub's own
  consent screen and exchanges the resulting code for a token.
- **OAuth server** to the MCP client (downstream) — the client never sees
  your GitHub token. It gets its own token from this Worker, scoped to this
  Worker only. `@cloudflare/workers-oauth-provider` (Cloudflare's own
  library) implements that downstream half: OAuth 2.1, PKCE, and Dynamic
  Client Registration (DCR) — DCR specifically is what lets a client
  register itself on first connection without you manually creating
  credentials for it.

```
MCP client ──OAuth (DCR, PKCE)──▶ this Worker ──OAuth (GitHub App)──▶ GitHub
                                       │
                                       ▼
                               Workers KV (OAUTH_KV)
                           state · refresh tokens · approved clients
```

### Why a GitHub App instead of a classic OAuth App

Cloudflare's own template uses a classic OAuth App, which is simpler but
gives you all-or-nothing repo scope and a token that never expires unless
you build expiry yourself. This build uses a **GitHub App** with the
*user-to-server* token flow instead:

- **Per-repo scoping at install time** — you pick exactly which repos this
  server can touch (GitHub's own installation picker), not "everything this
  account can see."
- **Tokens that actually expire and renew themselves** — with "Expire user
  authorization tokens" turned on, GitHub hands back an 8-hour access token
  plus a 6-month refresh token, and using the refresh token mints a new pair
  of both. As long as you use this server at least once every 6 months, it
  never goes stale and you never have to manually mint a new token.

That refresh cycle is handled by `src/github-client.ts`, independently of
Cowork's own session with this Worker — see **Token lifecycle**, below.

## 1. Create the GitHub App

Go to **github.com/settings/apps/new** (personal account) or
**github.com/organizations/&lt;org&gt;/settings/apps/new** (org-owned —
use this if you want it under an org rather than your personal account).

| Field | Value |
|---|---|
| GitHub App name | `github-mcp-gateway` (must be globally unique — append your username if taken) |
| Homepage URL | `https://github-mcp-gateway.<your-subdomain>.workers.dev` |
| Callback URL | `https://github-mcp-gateway.<your-subdomain>.workers.dev/callback` |
| Webhook | **Uncheck "Active"** — this server doesn't use webhooks |
| Repository permissions → Contents | Read & write |
| Repository permissions → Issues | Read & write |
| Repository permissions → Pull requests | Read & write |
| Repository permissions → Metadata | Read (mandatory, auto-selected) |
| Where can this GitHub App be installed? | Only on this account |

After creating it:

1. Note the **Client ID** at the top of the app's settings page.
2. Click **Generate a new client secret** — copy it now, it's shown once.
3. Under **Optional features**, find **User-to-server token expiration**
   and click **Opt-in**. This is what makes refresh tokens exist at all —
   skip it and the server will fail at the callback step with a clear error
   telling you to come back and do this.
4. Go to **Install App** (left sidebar) and install it on your account,
   choosing **Only select repositories** — pick the repos you want this
   server to reach (you can add more later from the same screen).

You'll want a **second** GitHub App, identically configured but with the
callback URL `http://localhost:8788/callback`, if you plan to iterate with
`wrangler dev` locally before deploying.

## 2. Create the KV namespace

```bash
cd github-mcp-gateway
npm install
npx wrangler kv namespace create OAUTH_KV
```

Copy the returned `id` into `wrangler.jsonc`, replacing
`REPLACE_WITH_KV_NAMESPACE_ID`.

## 3. Set secrets and the allowlist var

```bash
npx wrangler secret put GITHUB_APP_CLIENT_ID
npx wrangler secret put GITHUB_APP_CLIENT_SECRET
openssl rand -hex 32 | npx wrangler secret put COOKIE_ENCRYPTION_KEY
```

`ALLOWED_GITHUB_LOGINS` is a plain var, not a secret — add it to
`wrangler.jsonc` under a top-level `"vars"` block:

```jsonc
"vars": {
  "ALLOWED_GITHUB_LOGINS": "mazze93"
}
```

This is a defense-in-depth allowlist checked at the OAuth callback: even
though only you can complete the GitHub consent screen for your own account,
this makes the gate explicit in code rather than implicit in "whoever can
authenticate." **Confirm `mazze93` is actually your GitHub login** — it's
inferred from your repo namespaces, not verified.

## 4. Deploy

```bash
npx wrangler deploy
```

## 5. Connect a client

Point any MCP client at:

```
https://github-mcp-gateway.<your-subdomain>.workers.dev/mcp
```

- **Claude Code:** `claude mcp add --transport http github-mcp-gateway <url>`
- **Claude.ai / Cowork:** add a custom MCP connector with that URL.

The client registers itself via DCR, redirects you through this server's
consent screen, then GitHub's, and lands back with tools available.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in the *local* GitHub App's credentials
npx wrangler dev
```

`wrangler dev` serves at `http://localhost:8788` — point an MCP client (e.g.
the MCP Inspector) at `http://localhost:8788/mcp`.

## Token lifecycle

Two independent token relationships exist, on different clocks:

1. **Cowork ↔ this Worker.** Standard OAuth 2.1 access/refresh tokens
   issued by `workers-oauth-provider`. Cowork refreshes these itself,
   automatically, per the MCP spec — nothing to manage here.
2. **This Worker ↔ GitHub.** An 8-hour access token + 6-month refresh
   token. `src/github-client.ts` checks expiry before every GitHub API
   call and refreshes transparently when within 5 minutes of expiry,
   persisting the rotated pair to `OAUTH_KV` under
   `github:tokens:{your-login}`. This is deliberately **not** wired
   through `workers-oauth-provider`'s `tokenExchangeCallback` hook — that
   mechanism has an open upstream bug (props going stale after a refresh
   triggered re-auth loops; see References) — so it's handled directly in
   the tool layer instead, where it's simpler to reason about and test.

If GitHub's refresh token itself expires (unused for 6+ months) or you
revoke the app's access, the next tool call fails with a clear
`ReauthorizationRequiredError` message instructing you to disconnect and
reconnect in Cowork. There's no silent failure mode here — either it works
quietly in the background, or it tells you exactly what to do.

## Tools

| Module | Tools |
|---|---|
| `src/tools/repos.ts` | `github_list_repos`, `github_get_repo`, `github_list_branches`, `github_list_commits`, `github_get_commit`, `github_update_repo` |
| `src/tools/issues.ts` | `github_list_issues`, `github_get_issue`, `github_create_issue`, `github_comment_on_issue`, `github_close_issue` |
| `src/tools/pulls.ts` | `github_list_pull_requests`, `github_get_pull_request`, `github_list_pull_request_files`, `github_create_pull_request`, `github_merge_pull_request` |
| `src/tools/contents.ts` | `github_get_file_contents`, `github_create_or_update_file`, `github_delete_file` |
| `src/tools/search.ts` | `github_search_code`, `github_search_issues` |

All list tools accept `per_page` and `page` for pagination.

`github_merge_pull_request` and `github_delete_file` are the two
destructive operations — irreversible via the tool itself once called.
The client should confirm with you before invoking either.

`github_update_repo` (description, homepage, topics) requires the GitHub
App to have the **Administration** repository permission. The app as
currently configured (Contents/Issues/PRs/Metadata) does not include it —
add the permission in the App settings and re-approve the installation to
enable this tool, or make those edits with the `gh` CLI instead.

## Security notes / known upstream issues this build accounts for

- **CSRF, state replay, session fixation** — handled in
  `src/oauth/workers-oauth-utils.ts` via a CSRF token + cookie pair on the
  consent form, one-time-use KV-backed state (10 min TTL), and a
  session-binding cookie (SHA-256 hash of the state token) that proves the
  browser completing the GitHub callback is the same one that started the
  flow.
- **`workers-oauth-provider` Issue #133** — a path-handling bug in
  audience validation has, in some versions, broken Claude.ai/Cowork
  connections specifically. This build avoids adding path components to
  any resource indicator (the `/mcp` and `/sse` routes are registered at
  the root of `apiHandlers`, not nested under a longer path) as the
  documented workaround. If Cowork's first connection attempt fails at the
  token exchange step, this is the first thing to check upstream.
- **Issue #108 (RFC 8707 audience validation with paths)** — same root
  cause as above; same mitigation.
- **Issue #29 (redirect URI mismatch in production)** — DCR-registered
  redirect URIs have been reported to behave differently in production
  vs. `wrangler dev` for some clients. If Cowork's redirect fails only
  after deploying (and works locally), this is the known suspect.
- **`__Host-` cookie prefix** used throughout — guarantees (browser-
  enforced) that a cookie could only have been set by this exact origin
  over HTTPS, with no `Domain` attribute that could widen its scope.

## References

- Cloudflare Agents — [Build a Remote MCP Server](https://developers.cloudflare.com/agents/guides/remote-mcp-server/)
- [`cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider) — the downstream OAuth 2.1 implementation this depends on
- GitHub Docs — [Refreshing user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)
- [`workers-oauth-provider` Issue #133](https://github.com/cloudflare/workers-oauth-provider/issues/133) (Claude.ai connection failures) and [Issue #108](https://github.com/cloudflare/workers-oauth-provider/issues/108) (RFC 8707 path audience bug)
