/**
 * Built-in Group Plugin
 *
 * Groups array items by a key expression.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

interface GroupArrayInput {
  source: unknown[];
  keyExpression: string;
  itemVariable?: string;
}

const groupArray = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const {
      source,
      keyExpression,
      itemVariable = "item",
    } = inputs as unknown as GroupArrayInput;

    if (!Array.isArray(source)) {
      return {
        success: false,
        error: "Source must be an array",
        durationMs: performance.now() - startTime,
      };
    }

    if (!keyExpression) {
      return {
        success: false,
        error: "Key expression is required",
        durationMs: performance.now() - startTime,
      };
    }

    const keyFn = new Function(itemVariable, `return (${keyExpression})`);
    const groups: Record<string, unknown[]> = {};

    for (const item of source) {
      try {
        const key = String(keyFn(item));
        if (!groups[key]) {
          groups[key] = [];
        }
        groups[key].push(item);
      } catch {
        // Skip items that fail key extraction
      }
    }

    return {
      success: true,
      output: {
        result: groups,
        groupCount: Object.keys(groups).length,
        itemCount: source.length,
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

export const groupPlugin: BuiltinPlugin = {
  id: "builtin:group",
  name: "Group",
  description: "Group array items by a key expression",
  actions: {
    array: {
      name: "array",
      description: "Group array items by key",
      handler: groupArray,
    },
  },
};
