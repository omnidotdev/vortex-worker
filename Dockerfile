# syntax=docker/dockerfile:1

FROM oven/bun:1 AS base
WORKDIR /app

# Build
FROM base AS builder
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY . .
RUN bun run postinstall && bun run build

# Run
FROM base AS runner
ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/build ./build
COPY --from=builder /app/src/sandbox/wasm/evaluator.wasm ./build/wasm/evaluator.wasm
COPY --from=builder /app/package.json ./

RUN addgroup --system --gid 1001 app && \
    adduser --system --uid 1001 --ingroup app app && \
    chown -R app:app /app
USER app

EXPOSE 8080

CMD ["bun", "run", "start"]
