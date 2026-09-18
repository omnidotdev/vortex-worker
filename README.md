<div align="center">

# Vortex Worker

DSL executor and workflow engine for Vortex

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE.md)

</div>

Execution engine for [Vortex](https://github.com/omnidotdev/vortex), interpreting the workflow DSL on pluggable backends (Hatchet, Temporal, or local). Handles trigger adapters, step execution, saga coordination, CloudEvents emission, and durable retries.

## Setup

```sh
cp .env.local.template .env.local   # fill in values
bun i
bun dev
```

Or run `tilt up` from the [metarepo](https://github.com/omnidotdev/vortex). The worker connects to the configured execution backend (`VORTEX_EXECUTOR`, defaults to `hatchet`) and begins processing workflow events. Only `DATABASE_URL` plus the backend token are required; every other integration in `.env.local.template` degrades gracefully when unset.

## Commands

| Command | Description |
|---------|-------------|
| `bun dev` | Start dev server (watch mode) |
| `bun build` | Build for production |
| `bun start` | Run the production build |
| `bun test` | Run all tests |
| `bun test:integration` | Run integration tests only |
| `bun test:watch` | Run tests in watch mode |
| `bun test:coverage` | Run tests with coverage |
| `bun check` | Lint and format check with Biome |
| `bun format` | Auto-format with Biome |
| `bun knip` | Detect dead code and unused dependencies |

## Diagnostics

- **Executor backend**: `VORTEX_EXECUTOR` selects `hatchet` (default), `temporal`, or `local`. `local` runs in-process, useful for tests and offline development.
- **Health probes**: the health worker listens on `HEALTH_PORT` (default `8080`) and serves `GET /health` (liveness) and `GET /ready` (readiness); the internal API server runs on `HEALTH_PORT + 1` (`8081`) for `/push-event` and `/execute-step`.
- **Code steps**: expression and code nodes run in a QuickJS/Extism WASM isolate (`src/sandbox/extism.ts`). That isolate needs WASI, which Bun does not provide, so the real evaluator cannot load under Bun today; integration tests mock the Extism runtime (see `src/__tests__/integration/setup.ts`).
- **Logging**: set `LOG_LEVEL` (e.g. `debug`) for verbose output. Optional Sentry (`SENTRY_DSN`) and OpenTelemetry (`OTEL_EXPORTER_OTLP_ENDPOINT`) exporters activate only when configured.

## Documentation

For detailed documentation, visit [omni.dev/grid/vortex](https://omni.dev/grid/vortex).

## License

The code in this repository is licensed under Apache 2.0, &copy; [Omni LLC](https://omni.dev). See [LICENSE.md](LICENSE.md) for more information.
