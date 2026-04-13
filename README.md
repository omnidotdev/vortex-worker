<div align="center">

# Vortex Worker

DSL executor and workflow engine for Vortex

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE.md)

</div>

Execution engine for [Vortex](https://github.com/omnidotdev/vortex), interpreting the workflow DSL on pluggable backends (Hatchet, Temporal, or local). Handles trigger adapters, step execution, saga coordination, CloudEvents emission, and durable retries.

## Tech Stack

Bun, Hatchet SDK, Temporal SDK, CloudEvents, HMAC webhook delivery

## Setup

```sh
cp .env.local.template .env.local   # fill in values
bun i
bun dev
```

Or run `tilt up` from the metarepo. The worker connects to the configured execution backend (`EXECUTOR_ADAPTER`) and begins processing workflow events.

## Commands

| Command | Description |
|---------|-------------|
| `bun dev` | Start dev server |
| `bun build` | Build for production |
| `bun test` | Run tests |
| `bun test:watch` | Run tests in watch mode |
| `bun test:coverage` | Run tests with coverage |
| `bun lint` | Lint with Biome |
| `bun format` | Format with Biome |

## Documentation

- [Vortex Docs](https://docs.omni.dev/grid/vortex)

## License

The code in this repository is licensed under Apache 2.0, &copy; [Omni LLC](https://omni.dev). See [LICENSE.md](LICENSE.md) for more information.
