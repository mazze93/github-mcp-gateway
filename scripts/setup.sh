#!/usr/bin/env bash
# ============================================================================
# setup.sh — one-command setup for a fork of github-mcp-gateway.
# ============================================================================
# This repository is BOTH a live deployment and a template. The committed
# wrangler.jsonc points at the maintainer's KV namespace and allowlist, which
# is correct for the upstream deployment and wrong for yours. This script
# rewrites those to yours.
#
# It does NOT touch secrets: those go through `wrangler secret put`, which
# keeps them out of the repo entirely. Run this once after forking, then
# follow the printed next steps.
#
#   ./scripts/setup.sh <your-github-login>
# ----------------------------------------------------------------------------
set -euo pipefail

LOGIN="${1:-}"
if [ -z "$LOGIN" ]; then
	echo "usage: ./scripts/setup.sh <your-github-login>" >&2
	echo "  e.g. ./scripts/setup.sh octocat" >&2
	exit 64
fi

cd "$(dirname "$0")/.."

if [ ! -f wrangler.jsonc ]; then
	echo "error: wrangler.jsonc not found — run this from the repo." >&2
	exit 1
fi

echo "==> Installing dependencies (locked)"
npm ci

echo
echo "==> Creating a KV namespace for OAuth state and GitHub tokens"
# Parse the id out of wrangler's output rather than asking the user to
# copy-paste it -- a mistyped namespace id fails at runtime, not at deploy,
# which is a genuinely confusing first experience.
KV_OUTPUT="$(npx wrangler kv namespace create OAUTH_KV 2>&1)"
echo "$KV_OUTPUT"
KV_ID="$(printf '%s' "$KV_OUTPUT" | grep -oE '"id"[[:space:]]*:[[:space:]]*"[a-f0-9]{32}"' | grep -oE '[a-f0-9]{32}' | head -1)"

if [ -z "$KV_ID" ]; then
	echo
	echo "error: could not parse the KV namespace id from wrangler's output." >&2
	echo "Set it by hand in wrangler.jsonc under kv_namespaces[0].id, then" >&2
	echo "re-run with the allowlist step only." >&2
	exit 1
fi

echo
echo "==> Pointing wrangler.jsonc at your namespace and your login"
python3 - "$KV_ID" "$LOGIN" <<'PY'
import io, re, sys
kv_id, login = sys.argv[1], sys.argv[2]
path = "wrangler.jsonc"
s = io.open(path, encoding="utf-8").read()

s, n_kv = re.subn(r'("id"\s*:\s*)"[a-f0-9]{32}"', r'\1"%s"' % kv_id, s, count=1)
s, n_login = re.subn(r'("ALLOWED_GITHUB_LOGINS"\s*:\s*)"[^"]*"',
                     r'\1"%s"' % login, s, count=1)

if not n_kv or not n_login:
    sys.exit("error: wrangler.jsonc did not match the expected shape "
             f"(kv={n_kv}, allowlist={n_login}) — edit it by hand.")

io.open(path, "w", encoding="utf-8").write(s)
print(f"    kv_namespaces[0].id  -> {kv_id}")
print(f"    ALLOWED_GITHUB_LOGINS -> {login}")
PY

cat <<NEXT

==> Done. Remaining steps, which need YOUR credentials:

  1. Create a GitHub App (see README section 1). Enable
     "User-to-server token expiration" — without it there are no refresh
     tokens and the callback fails with an explicit error.

  2. Set the secrets (these never enter the repo):

       npx wrangler secret put GITHUB_APP_CLIENT_ID
       npx wrangler secret put GITHUB_APP_CLIENT_SECRET
       openssl rand -hex 32 | npx wrangler secret put COOKIE_ENCRYPTION_KEY

  3. Deploy, then connect a client:

       npm run deploy
       claude mcp add --transport http github-mcp-gateway <your-worker-url>/mcp

  4. If you want CI to deploy on merge, set in your fork:

       gh secret set CLOUDFLARE_API_TOKEN     # Workers Scripts:Edit + Workers KV Storage:Edit
       gh secret set CLOUDFLARE_ACCOUNT_ID
       gh variable set WORKER_BASE_URL --body "https://<your-worker-url>"

     WORKER_BASE_URL matters: without it the post-deploy smoke test checks
     the UPSTREAM deployment and reports green on somebody else's Worker.

NEXT
