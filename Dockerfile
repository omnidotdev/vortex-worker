# syntax=docker/dockerfile:1

FROM oven/bun:1.4.2 AS base
WORKDIR /app

# Install production dependencies only
FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts --production

# Build (needs all deps including dev)
FROM base AS builder
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts
# Bust the COPY cache per commit. The Fractal operator always builds with
# --cache-from <name>:buildcache and always injects GIT_SHA as a build-arg;
# importing that registry cache can false-hit "COPY . ." so a new commit reuses
# a stale source layer and ships old code (the 2026-09 vortex-worker and
# gatekeeper stale-build incidents). Consuming GIT_SHA before the copy forces
# COPY to re-copy real source on every commit
ARG GIT_SHA=unknown
RUN echo "source-cache-bust ${GIT_SHA}"
COPY . .
RUN bun run postinstall && bun run build
# Guard: bun's bundler can emit an undefined __promiseAll helper for concurrent
# async-module init, crash-looping the worker on boot (the 2026-06 aether
# incident). Fail the build before a broken bundle can deploy.
RUN if grep -q '__promiseAll' build/index.js && \
      ! grep -qE '(function|var|let|const) +__promiseAll' build/index.js; then \
      echo 'FATAL: bundle references undefined __promiseAll (bun bundler bug); aborting build'; exit 1; \
    fi

# Run
FROM base AS runner
ENV NODE_ENV=production
# Bake the built commit into the image so the running commit is observable and a
# stale build is detectable (compare BUILD_SHA against the expected commit)
ARG GIT_SHA=unknown
ENV BUILD_SHA=${GIT_SHA}
USER bun

COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/build ./build
COPY --from=builder /app/src/sandbox/wasm/evaluator.wasm ./build/wasm/evaluator.wasm
COPY --from=builder /app/package.json ./

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD bun -e "fetch('http://localhost:8080/health').then(r=>{if(!r.ok)throw 1}).catch(()=>process.exit(1))"

CMD ["bun", "run", "start"]
