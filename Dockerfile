# syntax=docker/dockerfile:1.7

# ============================================================================
# Hardened build/deploy toolchain for github-mcp-gateway.
# ============================================================================
# This image does NOT run the gateway. It cannot: the gateway is a Cloudflare
# Worker and depends on the Workers runtime, a Durable Object namespace, and a
# KV binding, none of which exist inside a container. Anyone reaching for a
# runnable server image is looking for the deployed Worker instead:
#
#     https://github-mcp-gateway.mazzewhiteley93.workers.dev/mcp
#
# What this image IS: a pinned, reproducible toolchain that builds and deploys
# that Worker. CI and a workstation both invoke the same wrangler, resolved
# from the same lockfile, on the same Node major -- so "works on my machine"
# and "works in Actions" stop being separate questions.
#
#     docker run --rm -e CLOUDFLARE_API_TOKEN \
#       -v "$PWD:/work" ghcr.io/mazze93/github-mcp-gateway-toolchain:v1.0.0 \
#       deploy
#
# Hardening: multi-stage so no build toolchain reaches the final layer;
# distroless final base, so there is no shell, no package manager, and no busybox
# for an attacker to pivot through; non-root uid/gid 65532 (distroless nonroot);
# dependencies installed with --ignore-scripts so no package lifecycle
# script executes at build time.
# ----------------------------------------------------------------------------

# Pinned by digest, not just tag: a tag can be repointed at arbitrary content
# after review, which is the same reasoning that pins the SHAs in ci.yml.
FROM node:24-bookworm-slim@sha256:8579e5fce559544b50072d05cc5d3b84b6a14d0989ae56c331d9e983a36a21f1 AS build

WORKDIR /app

# Lockfile first so the dependency layer is cached independently of source.
COPY package.json package-lock.json ./

# `ci`, not `install`: installs exactly the lockfile and fails if it disagrees
# with package.json. --ignore-scripts blocks postinstall execution -- wrangler
# and esbuild ship prebuilt platform binaries selected by npm's own optional-
# dependency resolution, so nothing here needs a lifecycle script to run.
RUN npm ci --ignore-scripts

# Source is copied after the install layer so an edit doesn't bust the cache.
COPY tsconfig.json wrangler.jsonc worker-configuration.d.ts ./
COPY src ./src

# Typecheck and produce the real bundle inside the image. This makes the build
# fail here rather than at deploy time, and proves the pinned toolchain can
# actually build this Worker.
RUN npx tsc --noEmit \
 && npx wrangler deploy --dry-run --outdir dist

# ----------------------------------------------------------------------------
# Final stage: no shell, no npm, no compilers.
# ----------------------------------------------------------------------------
FROM gcr.io/distroless/nodejs24-debian12:nonroot@sha256:14d42e2511532589a7c7e01a753667a74fcc96266e137e8125006b87b0c32d0a

# Make the runtime identity explicit before WORKDIR, so BuildKit creates
# /app for this user. Wrangler needs to write .wrangler/tmp at runtime.
USER 65532:65532
WORKDIR /app

# Copy only the declared inputs and bundle, excluding build-stage scratch.
COPY --from=build --chown=nonroot:nonroot /app/node_modules ./node_modules
COPY --from=build --chown=nonroot:nonroot /app/package.json /app/package-lock.json ./
COPY --from=build --chown=nonroot:nonroot /app/wrangler.jsonc /app/tsconfig.json /app/worker-configuration.d.ts ./
COPY --from=build --chown=nonroot:nonroot /app/src ./src
COPY --from=build --chown=nonroot:nonroot /app/dist ./dist

ENV NODE_ENV=production \
    WRANGLER_SEND_METRICS=false

# No HEALTHCHECK: this is a one-shot CLI image, not a long-running service.
# A container that exits when wrangler exits has nothing to probe.

# The distroless nodejs entrypoint is `node`, so the wrangler CLI is invoked
# by path rather than through a shell wrapper.
ENTRYPOINT ["/nodejs/bin/node", "/app/node_modules/wrangler/bin/wrangler.js"]
CMD ["--version"]

LABEL org.opencontainers.image.title="github-mcp-gateway toolchain" \
      org.opencontainers.image.description="Pinned, non-root wrangler toolchain that builds and deploys the github-mcp-gateway Worker. Does not run the gateway itself." \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.source="https://github.com/mazze93/github-mcp-gateway"
