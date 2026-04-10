<div align="center">

# 🌪️ Vortex Worker

DSL executor and workflow engine for Vortex

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE.md)

</div>

## Overview

Vortex Worker is the execution engine for [Vortex](https://github.com/omnidotdev/vortex), Omni's workflow automation platform. It interprets the DSL emitted by the [API](https://github.com/omnidotdev/vortex-api) and runs workflows on pluggable backends (Hatchet, Temporal, or a local executor). Handles trigger adapters, step execution, saga coordination, event emission, and durable retries.

## Features

- **Pluggable Backends** - Hatchet (default), Temporal, or local execution without changing the DSL
- **Trigger Adapters** - Manual, webhook, schedule (cron), email, SSE, and event-driven triggers
- **141 Step Types** - HTTP, AI providers, database, transforms, flow control, communication, and more
- **CloudEvents** - Emits `vortex.workflow.started|completed|failed` via `@omnidotdev/providers`
- **Saga Support** - Cross-service transactions with compensating steps and collect operations
- **Subscription Delivery** - HMAC-signed webhook delivery with retry poller for external consumers
- **Cron Scheduler** - Daily jobs for token refresh, authz reconciliation, and cleanup

## Local Development

First, `cp .env.local.template .env.local` and fill in the values.

Install dependencies:

```sh
bun install
```

Run the worker:

```sh
bun run dev
```

The worker connects to Hatchet (or Temporal/local, depending on `EXECUTOR_ADAPTER`) and begins processing workflow events.

## Architecture

Step types live in `src/dsl/types.ts` (Zod schemas) with dispatch logic in `src/dsl/executor.ts`. Trigger adapters live in `src/adapters/*.adapter.ts` and are registered in `src/triggers/registry.ts`. Hatchet workflows live in `src/workflows/`.

## License

The code in this repository is licensed under Apache 2.0, &copy; [Omni LLC](https://omni.dev). See [LICENSE.md](LICENSE.md) for more information.
