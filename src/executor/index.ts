/**
 * Vortex Executor Module
 *
 * Factory for creating workflow executors based on configuration.
 */

export * from "./interface";
export * from "./types";

import type { WorkflowExecutor } from "./interface";
import type { ExecutorConfig } from "./types";

/**
 * Get a workflow executor based on configuration.
 *
 * @param config - Executor configuration specifying backend type
 * @returns Configured workflow executor
 *
 * @example
 * ```typescript
 * // Use Hatchet in production
 * const executor = getExecutor({ type: "hatchet" });
 *
 * // Use Temporal for long-running workflows
 * const temporal = getExecutor({ type: "temporal" });
 *
 * // Use local executor for testing
 * const testExecutor = getExecutor({ type: "local" });
 * ```
 */
export async function getExecutor(
  config: ExecutorConfig,
): Promise<WorkflowExecutor> {
  switch (config.type) {
    case "hatchet": {
      const { HatchetExecutor } = await import("./adapters/hatchet");
      return new HatchetExecutor(config.options);
    }
    case "temporal": {
      const { TemporalExecutor } = await import("./adapters/temporal");
      return new TemporalExecutor(config.options);
    }
    case "local": {
      const { LocalExecutor } = await import("./adapters/local");
      return new LocalExecutor();
    }
    case "trigger-dev": {
      throw new Error("Trigger.dev adapter not yet implemented");
    }
    default:
      throw new Error(
        `Unknown executor type: ${(config as ExecutorConfig).type}`,
      );
  }
}

/**
 * Get the default executor based on environment.
 *
 * - Production: Hatchet (default)
 * - Set VORTEX_EXECUTOR=temporal for Temporal
 * - Set VORTEX_EXECUTOR=local for testing
 */
export async function getDefaultExecutor(): Promise<WorkflowExecutor> {
  const executorType = process.env.VORTEX_EXECUTOR || "hatchet";

  return getExecutor({
    type: executorType as ExecutorConfig["type"],
  });
}
