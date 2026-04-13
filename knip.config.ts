import type { KnipConfig } from "knip";

/**
 * Knip configuration.
 * @see https://knip.dev/overview/configuration
 */
const knipConfig: KnipConfig = {
  entry: ["src/index.ts"],
  project: ["src/**/*.ts"],
  // Used for proper management of exports (see https://knip.dev/reference/configuration#ignoreexportsusedinfile)
  ignoreExportsUsedInFile: true,
  ignore: [
    // Instrumentation loaded via --import flag at runtime
    "src/instrumentation.ts",
    // Temporal workflows and activities (WIP - alternative to Hatchet)
    "src/workflows/temporal/**",
    // Activity files (used by workflow engine at runtime)
    "src/activities/**",
    // Executor adapters (dynamically loaded based on config)
    "src/executor/**",
    // Integration index (re-exports for external consumers)
    "src/integrations/index.ts",
    // Connector index (re-exports for external consumers)
    "src/connectors/index.ts",
    // Types files (exported for consumers)
    "src/dsl/types.ts",
    "src/connectors/types.ts",
    "src/plugins/interface.ts",
    // Env config (exports used by other services)
    "src/lib/config/env.config.ts",
    // Connector registry (exports for external consumers and testing)
    "src/connectors/registry.ts",
    "src/connectors/executor.ts",
    // Plugin builtin exports (for external consumers)
    "src/plugins/builtin/index.ts",
    // Plugin host (exports for external consumers and testing)
    "src/plugins/host.ts",
    // MCP client (exports for testing)
    "src/mcp/client.ts",
    // Events consumer (wired at runtime, not yet imported from index)
    "src/events/**",
    // Distributed cron lock (consumed by cron scheduler)
    "src/lib/cron/**",
    // Rate limiter (consumed by workflow executor and API middleware)
    "src/lib/rate-limit/**",
    // Trigger adapter registry (public API for adapter discovery)
    "src/triggers/registry.ts",
    // Trigger runners (buildActive* exports used in test files)
    "src/triggers/polling.ts",
    "src/triggers/redis.ts",
    // Error classes (consumed by circuit-breaker, rate-limit)
    "src/lib/errors.ts",
  ],
  ignoreBinaries: [
    // Installed globally; compiles evaluator.js → evaluator.wasm
    "extism-js",
  ],
  ignoreDependencies: [
    // Changeset tooling (invoked via npx/bunx, not imported)
    "@changesets/cli",
    // All @activepieces/* packages are dynamically loaded at runtime based on integration type
    "@activepieces/*",
    // OpenTelemetry deps used by instrumentation.ts (loaded via --import)
    "@opentelemetry/auto-instrumentations-node",
    "@opentelemetry/exporter-logs-otlp-http",
    "@opentelemetry/exporter-trace-otlp-http",
    "@opentelemetry/resources",
    "@opentelemetry/sdk-logs",
    "@opentelemetry/sdk-node",
    "@opentelemetry/semantic-conventions",
    // Temporal deps for future use
    "@temporalio/activity",
  ],
  tags: ["-knipignore"],
};

export default knipConfig;
