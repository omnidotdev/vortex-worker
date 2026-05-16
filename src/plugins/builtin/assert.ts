/**
 * Built-in Assert Plugin
 *
 * Validation assertions for workflows.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** Expression assertion input */
interface ExpressionInput {
  /** JavaScript expression to evaluate */
  expression: string;
  /** Custom failure message */
  message?: string;
  /** If true, assertion failure returns success with passed=false */
  softFail?: boolean;
}

/** Equality assertion input */
interface EqualsInput {
  /** Actual value */
  actual: unknown;
  /** Expected value */
  expected: unknown;
  /** Custom failure message */
  message?: string;
  /** If true, assertion failure returns success with passed=false */
  softFail?: boolean;
}

/**
 * Assert an expression evaluates to truthy.
 */
const assertExpression = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const {
      expression,
      message = "Assertion failed",
      softFail = false,
    } = inputs as unknown as ExpressionInput;

    if (!expression) {
      return {
        success: false,
        error: "Expression is required",
        durationMs: performance.now() - startTime,
      };
    }

    const result = new Function(`return Boolean(${expression})`)();

    if (!result) {
      if (softFail) {
        return {
          success: true,
          output: { passed: false, message },
          durationMs: performance.now() - startTime,
        };
      }
      return {
        success: false,
        error: message,
        output: { passed: false, expression },
        durationMs: performance.now() - startTime,
      };
    }

    return {
      success: true,
      output: { passed: true },
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
 * Assert two values are deeply equal.
 */
const assertEquals = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const {
      actual,
      expected,
      message = "Values are not equal",
      softFail = false,
    } = inputs as unknown as EqualsInput;

    const isEqual = JSON.stringify(actual) === JSON.stringify(expected);

    if (!isEqual) {
      if (softFail) {
        return {
          success: true,
          output: { passed: false, actual, expected, message },
          durationMs: performance.now() - startTime,
        };
      }
      return {
        success: false,
        error: `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
        output: { passed: false, actual, expected },
        durationMs: performance.now() - startTime,
      };
    }

    return {
      success: true,
      output: { passed: true, actual, expected },
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
 * Assert built-in plugin definition.
 */
export const assertPlugin: BuiltinPlugin = {
  id: "builtin:assert",
  name: "Assert",
  description: "Validation assertions",
  actions: {
    expression: {
      name: "expression",
      description: "Assert an expression is truthy",
      handler: assertExpression,
    },
    equals: {
      name: "equals",
      description: "Assert two values are equal",
      handler: assertEquals,
    },
  },
};
