/**
 * Built-in Condition Plugin
 *
 * Evaluates boolean expressions for conditional branching.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/**
 * Evaluate a condition expression.
 */
const evaluateCondition = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const { expression, context: evalContext } = inputs as {
      expression: string;
      context?: Record<string, unknown>;
    };

    if (!expression) {
      return {
        success: false,
        error: "Expression is required",
        durationMs: performance.now() - startTime,
      };
    }

    const result = evaluateExpression(expression, evalContext || {});

    return {
      success: true,
      output: {
        result,
        branch: result ? "true" : "false",
        expression,
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

/**
 * Simple expression evaluator.
 */
function evaluateExpression(
  expression: string,
  context: Record<string, unknown>,
): boolean {
  const trimmed = expression.trim();

  // Boolean literals
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;

  // Resolve context references
  let resolved = trimmed;
  const refRegex = /([a-zA-Z_][a-zA-Z0-9_.]*)/g;
  resolved = resolved.replace(refRegex, (match) => {
    const value = getValueByPath(context, match);
    return JSON.stringify(value);
  });

  // Simple comparisons
  const comparisonMatch = resolved.match(
    /(.+?)\s*(===|!==|==|!=|>=|<=|>|<)\s*(.+)/,
  );
  if (comparisonMatch) {
    const [, left, op, right] = comparisonMatch;
    const leftVal = parseValue(left.trim());
    const rightVal = parseValue(right.trim());

    switch (op) {
      case "===":
      case "==":
        return leftVal === rightVal;
      case "!==":
      case "!=":
        return leftVal !== rightVal;
      case ">":
        return Number(leftVal) > Number(rightVal);
      case "<":
        return Number(leftVal) < Number(rightVal);
      case ">=":
        return Number(leftVal) >= Number(rightVal);
      case "<=":
        return Number(leftVal) <= Number(rightVal);
    }
  }

  // Truthy check
  const value = getValueByPath(context, trimmed);
  return Boolean(value);
}

function getValueByPath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current === "object") {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }

  return current;
}

function parseValue(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

export const conditionPlugin: BuiltinPlugin = {
  id: "builtin:condition",
  name: "Condition",
  description: "Evaluate boolean expressions for branching",
  actions: {
    evaluate: {
      name: "evaluate",
      description: "Evaluate a condition expression",
      handler: evaluateCondition,
    },
  },
};
