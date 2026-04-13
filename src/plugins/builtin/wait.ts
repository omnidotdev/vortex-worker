/**
 * Built-in Wait Plugin
 *
 * Pause workflow execution until a condition is met (webhook callback, event, or timeout).
 */

import { VORTEX_CALLBACK_BASE_URL } from "lib/config/env.config";

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

type TimeUnit = "seconds" | "minutes" | "hours" | "days";
type ResumeCondition = "webhook" | "event" | "timeout";

const TIME_MULTIPLIERS: Record<TimeUnit, number> = {
  seconds: 1000,
  minutes: 60 * 1000,
  hours: 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000,
};

/**
 * Generate a unique callback URL for this wait step.
 */
const generateCallbackUrl = (
  context: PluginContext | undefined,
  webhookSuffix?: string,
): string => {
  const baseUrl = VORTEX_CALLBACK_BASE_URL;
  const workflowId = context?.workflowId || "unknown";
  const runId = context?.runId || "unknown";
  const suffix = webhookSuffix || "";
  return `${baseUrl}/api/v1/callbacks/${workflowId}/${runId}${suffix ? `/${suffix}` : ""}`;
};

/**
 * Wait for a condition to be met.
 */
const executeWait = async (
  inputs: Record<string, unknown>,
  context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const {
      resumeOn = "timeout",
      webhookSuffix,
      eventName,
      timeout,
      timeoutUnit = "minutes",
      timeoutAction: _timeoutAction = "error",
    } = inputs as {
      resumeOn?: ResumeCondition;
      webhookSuffix?: string;
      eventName?: string;
      timeout?: number;
      timeoutUnit?: TimeUnit;
      timeoutAction?: "continue" | "error";
    };

    switch (resumeOn) {
      case "webhook": {
        const callbackUrl = generateCallbackUrl(context, webhookSuffix);
        // In actual implementation, this would suspend the workflow
        // and return the callback URL for external systems to call
        return {
          success: true,
          output: {
            status: "waiting",
            resumeOn: "webhook",
            callbackUrl,
            timeoutMs: timeout
              ? timeout * (TIME_MULTIPLIERS[timeoutUnit] || 1000)
              : undefined,
          },
          durationMs: performance.now() - startTime,
        };
      }

      case "event": {
        if (!eventName) {
          return {
            success: false,
            error: "eventName is required for event-based wait",
            durationMs: performance.now() - startTime,
          };
        }
        return {
          success: true,
          output: {
            status: "waiting",
            resumeOn: "event",
            eventName,
            timeoutMs: timeout
              ? timeout * (TIME_MULTIPLIERS[timeoutUnit] || 1000)
              : undefined,
          },
          durationMs: performance.now() - startTime,
        };
      }

      case "timeout": {
        const ms = (timeout || 1) * (TIME_MULTIPLIERS[timeoutUnit] || 1000);
        // Cap at 1 hour for in-process waits
        const cappedMs = Math.min(ms, 60 * 60 * 1000);
        await new Promise((resolve) => setTimeout(resolve, cappedMs));
        return {
          success: true,
          output: {
            status: "completed",
            resumeOn: "timeout",
            waitedMs: cappedMs,
          },
          durationMs: performance.now() - startTime,
        };
      }

      default:
        return {
          success: false,
          error: `Unknown resumeOn condition: ${resumeOn}`,
          durationMs: performance.now() - startTime,
        };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

export const waitPlugin: BuiltinPlugin = {
  id: "builtin:wait",
  name: "Wait",
  description: "Pause workflow until condition is met",
  actions: {
    wait: {
      name: "wait",
      description: "Wait for webhook, event, or timeout",
      handler: executeWait,
    },
  },
};
