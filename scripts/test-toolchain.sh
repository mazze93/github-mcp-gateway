#!/usr/bin/env bash
# Build and exercise the final toolchain image without credentials or deploys.
set -euo pipefail
cd "$(dirname "$0")/.."

runtime="${CONTAINER_RUNTIME:-}"
if [ -z "$runtime" ]; then
  if command -v container >/dev/null 2>&1; then
    runtime=container
  elif command -v docker >/dev/null 2>&1; then
    runtime=docker
  else
    echo "Install Apple container on a supported Mac, or Docker, to test the image." >&2
    exit 1
  fi
fi
case "$runtime" in
  container|docker) ;;
  *) echo "CONTAINER_RUNTIME must be container or docker" >&2; exit 1 ;;
esac

image=github-mcp-gateway-toolchain:local-test
"$runtime" build -t "$image" .
"$runtime" run --rm "$image" --version
"$runtime" run --rm --entrypoint /nodejs/bin/node "$image" -e \
  'if (process.getuid() === 0) throw new Error("Toolchain must not run as root"); console.log("Node", process.version, "uid", process.getuid())'
"$runtime" run --rm "$image" deploy --dry-run --outdir /tmp/worker-dist
