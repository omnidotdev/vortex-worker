<div align="center">

# Vortex Worker

DSL executor and workflow engine for Vortex

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE.md)

</div>

## Overview

Vortex Worker is the execution engine for [Vortex](https://github.com/omnidotdev/vortex), Omni's workflow automation platform. It interprets the workflow DSL and runs it on pluggable backends (Hatchet, Temporal, or a local executor), handling trigger adapters, step execution, saga coordination, event emission, and durable retries.

## Features

- **Pluggable Backends** - Hatchet (default), Temporal, or local execution without changing the DSL
- **Trigger Adapters** - Manual, webhook, schedule (cron), email, SSE, and event-driven triggers
- **CloudEvents** - Emits workflow lifecycle events via `@omnidotdev/providers`
- **Saga Support** - Cross-service transactions with compensating steps and collect operations
- **Subscription Delivery** - HMAC-signed webhook delivery with retry poller for external consumers

## Local Development

First, `cp .env.local.template .env.local` and fill in the values.

### Building and Running

Run `tilt up`, or:

```sh
bun i
bun dev
```

The worker connects to the configured execution backend (`EXECUTOR_ADAPTER`) and begins processing workflow events.

## Testing

```sh
bun test

# or in watch mode
bun test:watch

# or test with coverage reporting
bun test:coverage
```

## Documentation

- [Vortex Docs](https://docs.omni.dev/core/vortex)

## License

The code in this repository is licensed under Apache 2.0, &copy; [Omni LLC](https://omni.dev). See [LICENSE.md](LICENSE.md) for more information.
