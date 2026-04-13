# syntax=docker/dockerfile:1

FROM oven/bun:1 AS base
WORKDIR /app

# Install production dependencies only
FROM base AS deps
COPY package.json bun.lock ./
COPY patches/ ./patches/
RUN bun install --frozen-lockfile --ignore-scripts --production

# Build (needs all deps including dev)
FROM base AS builder
COPY package.json bun.lock ./
COPY patches/ ./patches/
RUN bun install --frozen-lockfile --ignore-scripts
COPY . .
RUN bun run postinstall && bun run build

# Run
FROM base AS runner
ENV NODE_ENV=production
USER bun

COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/build ./build
COPY --from=builder /app/src/sandbox/wasm/evaluator.wasm ./build/wasm/evaluator.wasm
COPY --from=builder /app/package.json ./

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD bun -e "fetch('http://localhost:8080/health').then(r=>{if(!r.ok)throw 1}).catch(()=>process.exit(1))"

CMD ["bun", "run", "start"]
