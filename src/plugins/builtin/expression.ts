/**
 * Built-in Expression Plugin
 *
 * JavaScript expression evaluation and script execution.
 * Provides a sandboxed environment for running expressions.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** Evaluate expression input */
interface EvalInput {
  /** JavaScript expression to evaluate */
  expression: string;
  /** Context variables available in the expression */
  context?: Record<string, unknown>;
  /** Timeout in ms */
  timeout?: number;
}

/** Execute script input */
interface ScriptInput {
  /** JavaScript code to execute */
  code: string;
  /** Context variables */
  context?: Record<string, unknown>;
  /** Timeout in ms */
  timeout?: number;
}

/** Template input */
interface TemplateInput {
  /** Template string with ${} placeholders */
  template: string;
  /** Context variables */
  context: Record<string, unknown>;
}

/** Conditional input */
interface ConditionalInput {
  /** Condition expression */
  condition: string;
  /** Context variables */
  context?: Record<string, unknown>;
  /** Value if true */
  ifTrue?: unknown;
  /** Value if false */
  ifFalse?: unknown;
}

/** Map expression input */
interface MapExprInput {
  /** Array to map over */
  array: unknown[];
  /** Expression to apply (item available as 'item', index as 'index') */
  expression: string;
  /** Additional context */
  context?: Record<string, unknown>;
}

/** Filter expression input */
interface FilterExprInput {
  /** Array to filter */
  array: unknown[];
  /** Predicate expression (item available as 'item', index as 'index') */
  predicate: string;
  /** Additional context */
  context?: Record<string, unknown>;
}

/** Math expression input */
interface MathInput {
  /** Math expression */
  expression: string;
  /** Variables */
  variables?: Record<string, number>;
}

/**
 * Create a sandboxed evaluation context.
 */
const createSandbox = (
  context: Record<string, unknown> = {},
): Record<string, unknown> => {
  // Safe built-ins
  const sandbox: Record<string, unknown> = {
    // Math functions
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    JSON,
    Date,
    RegExp,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,

    // Utility functions
    console: {
      log: (...args: unknown[]) => args,
      warn: (...args: unknown[]) => args,
      error: (...args: unknown[]) => args,
    },

    // Spread context
    ...context,
  };

  return sandbox;
};

/**
 * Evaluate a JavaScript expression.
 */
const evaluate = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as EvalInput;
    const sandbox = createSandbox(input.context);

    // Create function from expression
    const keys = Object.keys(sandbox);
    const values = Object.values(sandbox);

    // Wrap in async to support await
    const asyncFn = new Function(
      ...keys,
      `"use strict"; return (async () => (${input.expression}))();`,
    );

    // Execute with timeout
    const timeout = input.timeout ?? 5000;

    const result = await Promise.race([
      asyncFn(...values),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Expression timeout")), timeout),
      ),
    ]);

    return {
      success: true,
      output: { result },
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
 * Execute a JavaScript script (multiple statements).
 */
const execute = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as ScriptInput;
    const sandbox = createSandbox(input.context);

    const keys = Object.keys(sandbox);
    const values = Object.values(sandbox);

    // Script wrapper that captures return value
    const wrappedCode = `
      "use strict";
      return (async () => {
        let __result__;
        ${input.code}
        return __result__;
      })();
    `;

    const asyncFn = new Function(...keys, wrappedCode);

    const timeout = input.timeout ?? 5000;

    const result = await Promise.race([
      asyncFn(...values),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Script timeout")), timeout),
      ),
    ]);

    return {
      success: true,
      output: { result },
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
 * Interpolate template string with context.
 */
const template = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as TemplateInput;

    // Replace ${...} with evaluated expressions
    const result = input.template.replace(/\$\{([^}]+)\}/g, (_, expr) => {
      try {
        const sandbox = createSandbox(input.context);
        const keys = Object.keys(sandbox);
        const values = Object.values(sandbox);

        const fn = new Function(...keys, `"use strict"; return (${expr});`);
        const value = fn(...values);

        return String(value ?? "");
      } catch {
        return `\${${expr}}`; // Keep original if evaluation fails.
      }
    });

    return {
      success: true,
      output: { result },
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
 * Evaluate a conditional expression.
 */
const conditional = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as ConditionalInput;
    const sandbox = createSandbox(input.context);

    const keys = Object.keys(sandbox);
    const values = Object.values(sandbox);

    const fn = new Function(
      ...keys,
      `"use strict"; return Boolean(${input.condition});`,
    );
    const conditionResult = fn(...values);

    const result = conditionResult ? input.ifTrue : input.ifFalse;

    return {
      success: true,
      output: {
        condition: conditionResult,
        result,
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
 * Map an expression over an array.
 */
const mapExpr = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as MapExprInput;

    const results: unknown[] = [];

    for (let i = 0; i < input.array.length; i++) {
      const sandbox = createSandbox({
        ...input.context,
        item: input.array[i],
        index: i,
        array: input.array,
      });

      const keys = Object.keys(sandbox);
      const values = Object.values(sandbox);

      const fn = new Function(
        ...keys,
        `"use strict"; return (${input.expression});`,
      );
      results.push(fn(...values));
    }

    return {
      success: true,
      output: { results },
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
 * Filter an array with a predicate expression.
 */
const filterExpr = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as FilterExprInput;

    const results: unknown[] = [];

    for (let i = 0; i < input.array.length; i++) {
      const sandbox = createSandbox({
        ...input.context,
        item: input.array[i],
        index: i,
        array: input.array,
      });

      const keys = Object.keys(sandbox);
      const values = Object.values(sandbox);

      const fn = new Function(
        ...keys,
        `"use strict"; return Boolean(${input.predicate});`,
      );

      if (fn(...values)) {
        results.push(input.array[i]);
      }
    }

    return {
      success: true,
      output: {
        results,
        originalCount: input.array.length,
        filteredCount: results.length,
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
 * Evaluate a math expression.
 */
const math = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as MathInput;

    // Only allow math operations
    const safeExpr = input.expression.replace(/[^0-9+\-*/%().^a-zA-Z_\s]/g, "");

    const sandbox: Record<string, unknown> = {
      ...Math,
      ...input.variables,
      // Additional math helpers
      pow: Math.pow,
      sqrt: Math.sqrt,
      abs: Math.abs,
      round: Math.round,
      floor: Math.floor,
      ceil: Math.ceil,
      min: Math.min,
      max: Math.max,
      sin: Math.sin,
      cos: Math.cos,
      tan: Math.tan,
      log: Math.log,
      log10: Math.log10,
      exp: Math.exp,
      PI: Math.PI,
      E: Math.E,
    };

    const keys = Object.keys(sandbox);
    const values = Object.values(sandbox);

    const fn = new Function(...keys, `"use strict"; return (${safeExpr});`);
    const result = fn(...values);

    if (typeof result !== "number" || Number.isNaN(result)) {
      return {
        success: false,
        error: "Expression did not evaluate to a valid number",
        durationMs: performance.now() - startTime,
      };
    }

    return {
      success: true,
      output: { result },
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
 * Access nested object path.
 */
const get = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as {
      object: Record<string, unknown>;
      path: string;
      defaultValue?: unknown;
    };

    const parts = input.path.split(/[.[\]]+/).filter(Boolean);
    let current: unknown = input.object;

    for (const part of parts) {
      if (current === null || current === undefined) {
        return {
          success: true,
          output: { value: input.defaultValue, found: false },
          durationMs: performance.now() - startTime,
        };
      }

      current = (current as Record<string, unknown>)[part];
    }

    return {
      success: true,
      output: {
        value: current ?? input.defaultValue,
        found: current !== undefined,
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
 * Expression built-in plugin definition.
 */
export const expressionPlugin: BuiltinPlugin = {
  id: "builtin:expression",
  name: "Expression",
  description: "JavaScript expression evaluation and script execution",
  actions: {
    evaluate: {
      name: "evaluate",
      description: "Evaluate a JavaScript expression",
      handler: evaluate,
    },
    execute: {
      name: "execute",
      description: "Execute a JavaScript script",
      handler: execute,
    },
    template: {
      name: "template",
      description: "Interpolate template string with context",
      handler: template,
    },
    conditional: {
      name: "conditional",
      description: "Evaluate a conditional expression",
      handler: conditional,
    },
    map: {
      name: "map",
      description: "Map an expression over an array",
      handler: mapExpr,
    },
    filter: {
      name: "filter",
      description: "Filter an array with a predicate expression",
      handler: filterExpr,
    },
    math: {
      name: "math",
      description: "Evaluate a math expression",
      handler: math,
    },
    get: {
      name: "get",
      description: "Access nested object path",
      handler: get,
    },
  },
};
