/**
 * Built-in Event Plugin
 *
 * Emit events to other workflows (pub/sub pattern).
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/**
 * Emit an event.
 */
const emitEvent = async (
  inputs: Record<string, unknown>,
  context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const { eventName, payload = {} } = inputs as {
      eventName: string;
      payload?: Record<string, unknown>;
    };

    if (!eventName) {
      return {
        success: false,
        error: "eventName is required",
        durationMs: performance.now() - startTime,
      };
    }

    // TODO: Implement actual event bus integration
    // biome-ignore lint/suspicious/noConsole: Intentional runtime logging for plugin placeholder
    console.log(`[Event] Emitting "${eventName}" with payload:`, payload);

    return {
      success: true,
      output: {
        eventName,
        payload,
        emittedAt: new Date().toISOString(),
        workflowId: context?.workflowId,
        runId: context?.runId,
      },
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

export const eventPlugin: BuiltinPlugin = {
  id: "builtin:event",
  name: "Event",
  description: "Emit events to other workflows",
  actions: {
    emit: {
      name: "emit",
      description: "Emit an event",
      handler: emitEvent,
    },
  },
};
