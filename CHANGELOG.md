# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**What a version number covers here.** This repository produces two
artifacts on different clocks:

- **The deployed Worker** — ships continuously from `main` via `deploy.yml`.
  It is not gated on a tag, and a tag does not deploy it.
- **The toolchain image** (`ghcr.io/mazze93/github-mcp-gateway-toolchain`) —
  built and published only when a `v*.*.*` tag is pushed.

The version number describes **the gateway's own contract**: its tool
surface, its OAuth behaviour, and the shape of what it returns. So a
breaking change means a removed or renamed tool, a changed tool result
shape, or an OAuth change that forces every client to reconnect — not a
change to the container.

## [Unreleased]

## [1.1.0] - 2026-09-13

Everything below shipped to the live Worker between 2026-08-19 and
2026-09-13 but sat untagged — `v1.0.0` was cut mid-session and the work
kept going past it. 1.1.0 closes that gap. Minor, not major: no tool was
renamed or removed and no tool result shape changed.

### Fixed

- **`vitest` 5 could not install at all, and it took CI *and* deploys down
  with it.** `@cloudflare/vitest-pool-workers` peers on `vitest@^4.1.0` and
  no published release accepts 5 — every version through 0.22.0 declares
  `^4.1.0`. Both workflows begin with `npm ci`, so the ERESOLVE failed
  before a single test ran. Production kept serving the last good version,
  but for several hours every merge landed nowhere. Pinned back to
  `^4.1.11`, with a Dependabot `ignore` on vitest majors and the explicit
  condition for lifting it.
- **CIMD was off despite the compatibility flag being set.** The provider
  gates it on `!!options.clientIdMetadataDocumentEnabled &&
  hasGlobalFetchStrictlyPublic()`, and only the second was satisfied — so
  `global_fetch_strictly_public` had been inert since it was added. A URL
  `client_id` silently fell back to a bare `OAUTH_KV.get("client:<url>")`
  instead of fetching the metadata document, meaning Claude Code
  authenticated only while a stale KV record happened to survive. Now
  enabled, and the discovery document's
  `client_id_metadata_document_supported: true` is finally accurate.
- **The post-deploy smoke test raced edge propagation.** `wrangler deploy`
  returns when the upload is accepted, not when the new version serves
  everywhere, so the suite could read the *previous* version and report a
  failure that was not real. It now retries the suite as a unit with
  bounded backoff, and distinguishes a genuine regression from a timing
  artifact in the error message.

### Changed

- Toolchain moved to **Node 24 (Krypton LTS)** across all five places at
  once — Dockerfile build stage, distroless runtime, and `ci.yml`,
  `deploy.yml`, `release.yml`. Dependabot had proposed Node 26 for the
  build stage alone, which would have installed dependencies under one
  major and executed them under another; 26 also has no distroless runtime
  published and is not an LTS line.
- **The repository is now adoptable by a fork.** `scripts/setup.sh` creates
  the KV namespace and rewrites `wrangler.jsonc`; `deploy.yml` reads
  `vars.WORKER_BASE_URL` so a fork smoke-tests its own deployment rather
  than the upstream one; and the maintainer's login no longer seeds a
  fork's allowlist. The README states single-tenancy as a deliberate
  threat-model decision rather than leaving it to be discovered.
- Tool descriptions no longer leak the maintainer's private repository
  names into every downstream user's tool schema.
- `AGENTS.md` is a pointer to `CLAUDE.md` instead of a diverging copy of
  it.
- Discovery metadata: 14 repository topics, a sharpened description, and
  `keywords`/`repository`/`bugs`/`homepage` in `package.json`.
- Dependency bumps across the window, each gated by CI: `agents` 0.21.0
  (which brings the `McpAgent` feature-freeze notice, recorded in
  `CLAUDE.md`), plus wrangler, hono, workers-types, vitest-pool-workers,
  qs, fast-uri, and several GitHub Actions groups.


## [1.0.0] - 2026-08-19

First tagged release. The gateway itself has been deployed and in daily
use well before this tag; 1.0.0 records the point at which the release
process, the license, and the security policy caught up with it.

### Added

- Release pipeline: `v*.*.*` tags build and publish a hardened,
  non-root, multi-arch (`linux/amd64`, `linux/arm64`) wrangler toolchain
  image to GHCR, signed keyless with cosign and published with an SBOM
  and SLSA provenance attestation. The tag is verified against `VERSION`
  and `package.json` before anything is published.
- CI now builds the toolchain image on every pull request without
  pushing, smoke-tests its entrypoint, and asserts the final stage does
  not run as root — so the Dockerfile is exercised before release time
  rather than at it.
- `SECURITY.md` — private disclosure via GitHub Security Advisories, a
  scoped map of the attack surface, and the design properties a change
  must not regress.
- Dependabot now tracks the `docker` ecosystem alongside npm and
  github-actions, so base images are patched on the same weekly cadence.
- Test coverage for the `GET`/`POST /authorize` routes, previously the
  only untested path: malformed-request handling, consent rendering,
  the approved-client short-circuit (including rejection of a forged
  cookie), CSRF rejection ordering, and the `__Host-` guarantees on
  every cookie the route issues.

### Fixed

- **`deploy.yml` had never once run.** The workflow was structurally
  invalid from the commit that added it (2026-08-07): its smoke test
  embedded a multi-line `python3 -c '...'` whose continuation lines sat
  at column 0, which ended the `run: |` block scalar and promoted
  `try:` / `except Exception:` to top-level YAML keys. GitHub rejected
  the file at startup, so all 30 runs reported failure with **zero jobs
  and no logs** — which reads as noise rather than as a broken deploy.
  The manual-drift problem that workflow exists to close therefore
  stayed open, silently, for twelve days. The check now uses `jq`, and
  CI validates that every workflow file parses with only legal
  top-level keys, since `ci.yml` never previously parsed the others.
- **`POST /authorize` never sent the approved-clients cookie.** Both
  cookies were collapsed through `Object.fromEntries(headers)`, which
  keeps only the last `Set-Cookie` and silently discards the rest, so
  `__Host-APPROVED_CLIENTS` was dropped on every consent and the 30-day
  "remember this client" path never took effect. The session-binding
  cookie was the survivor, so `/callback`'s binding check was never
  weakened — this was a broken feature, not a weakened gate.
- Transitive `nanoid` bumped to 3.3.18. It reaches the production tree
  via `agents → vite → postcss`, so the advisory tripped CI's
  `npm audit --omit=dev` gate and was blocking unrelated dependency PRs.

### Changed

- `CLAUDE.md` no longer presents `npm run deploy` as the deploy path —
  `deploy.yml` has shipped the Worker on every push to `main` since the
  deploy workflow landed. It now also documents `src/oauth/loopback.ts`,
  the `global_fetch_strictly_public` compatibility flag, and the
  `package.json` `overrides`, all of which read as removable cruft
  without an explanation attached.
- `package.json` declares the Apache-2.0 license that `LICENSE` already
  carried.

[Unreleased]: https://github.com/mazze93/github-mcp-gateway/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/mazze93/github-mcp-gateway/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/mazze93/github-mcp-gateway/releases/tag/v1.0.0
