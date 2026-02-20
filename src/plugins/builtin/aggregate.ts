/**
 * Built-in Aggregate Plugin
 *
 * Aggregate data from multiple sources (parallel branches, loops, etc.).
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

type AggregateMode = "collect" | "merge" | "concat" | "sum" | "first" | "last";

/**
 * Aggregate items based on mode.
 */
const executeAggregate = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const {
      mode = "collect",
      source,
      groupBy: _groupBy,
    } = inputs as {
      mode?: AggregateMode;
      source: unknown;
      groupBy?: string;
    };

    if (source === undefined) {
      return {
        success: false,
        error: "source is required",
        durationMs: performance.now() - startTime,
      };
    }

    const items = Array.isArray(source) ? source : [source];
    let result: unknown;

    switch (mode) {
      case "collect":
        result = items;
        break;

      case "merge":
        result = Object.assign(
          {},
          ...items.filter((item) => typeof item === "object" && item !== null),
        );
        break;

      case "concat":
        result = items.flat();
        break;

      case "sum":
        result = items.reduce((acc, item) => {
          const num = typeof item === "number" ? item : Number(item);
          return acc + (Number.isNaN(num) ? 0 : num);
        }, 0);
        break;

      case "first":
        result = items[0];
        break;

      case "last":
        result = items[items.length - 1];
        break;

      default:
        return {
          success: false,
          error: `Unknown aggregate mode: ${mode}`,
          durationMs: performance.now() - startTime,
        };
    }

    return {
      success: true,
      output: {
        result,
        mode,
        itemCount: items.length,
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

export const aggregatePlugin: BuiltinPlugin = {
  id: "builtin:aggregate",
  name: "Aggregate",
  description: "Aggregate data from multiple sources",
  actions: {
    aggregate: {
      name: "aggregate",
      description: "Aggregate items using specified mode",
      handler: executeAggregate,
    },
  },
};
