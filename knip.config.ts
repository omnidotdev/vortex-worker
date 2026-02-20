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
    // Generated catalog files
    "**/generated/**",
    // Scripts run manually
    "scripts/**",
    // Instrumentation loaded via --import flag at runtime
    "src/instrumentation.ts",
    // Test files are run via bun test
    "src/__tests__/**",
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
    // Plugin index (re-exports for external consumers)
    "src/plugins/index.ts",
    // MCP index (re-exports for external consumers)
    "src/mcp/index.ts",
    // DB index (exports for external consumers)
    "src/db/index.ts",
    // Types files (exported for consumers)
    "src/dsl/types.ts",
    "src/connectors/types.ts",
    "src/plugins/interface.ts",
    // Env config (exports used by other services)
    "src/lib/config/env.config.ts",
    // Crypto lib (exports used by other services)
    "src/lib/crypto/**",
    // Connector registry (exports for external consumers and testing)
    "src/connectors/registry.ts",
    "src/connectors/executor.ts",
    // Plugin builtin exports (for external consumers)
    "src/plugins/builtin/index.ts",
    // Plugin host (exports for external consumers and testing)
    "src/plugins/host.ts",
    // MCP client (exports for testing)
    "src/mcp/client.ts",
    // Adapters (dynamically loaded based on integration config)
    "src/adapters/**",
    // Cache client (exports used by plugins and connectors)
    "src/lib/cache/**",
    // Events consumer (wired at runtime, not yet imported from index)
    "src/events/**",
  ],
  ignoreDependencies: [
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
    "@temporalio/client",
  ],
  tags: ["-knipignore"],
};

export default knipConfig;
