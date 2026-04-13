/**
 * Built-in Event Plugin
 *
 * Emit events to other workflows (pub/sub pattern).
 */

import { isInitialized, publish } from "../../events/publisher";

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
    const {
      eventName,
      organizationId,
      payload = {},
    } = inputs as {
      eventName: string;
      organizationId?: string;
      payload?: Record<string, unknown>;
    };

    if (!eventName) {
      return {
        success: false,
        error: "eventName is required",
        durationMs: performance.now() - startTime,
      };
    }

    if (!isInitialized()) {
      return {
        success: false,
        error: "Event publisher not initialized",
        durationMs: performance.now() - startTime,
      };
    }

    if (!organizationId) {
      return {
        success: false,
        error: "organizationId is required to emit events",
        durationMs: performance.now() - startTime,
      };
    }

    const event = await publish({
      type: eventName,
      source: "vortex.plugin",
      data: payload as Record<string, unknown>,
      organizationId,
      correlationId: context?.runId,
    });

    return {
      success: true,
      output: {
        eventId: event?.id,
        eventName,
        payload,
        emittedAt: event?.timestamp,
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
