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

[Unreleased]: https://github.com/mazze93/github-mcp-gateway/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/mazze93/github-mcp-gateway/releases/tag/v1.0.0
